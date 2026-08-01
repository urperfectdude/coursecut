// Per-user request limiting for the tenant API (M7's abuse limits).
//
// This is the *second* limiter in the system, and the split is deliberate.
// `better-auth`'s own (configured in `auth.ts`) covers `/api/auth/*`, where
// there is no session yet and the only identity a request has is its IP. Below
// `requireOrg` every request has a user id, which is a far better key: it
// cannot be shared by a university's entire NAT, and it cannot be spread across
// a botnet either.
//
// **What it is for.** Not capacity — the expensive work is queued, and
// `quota.ts` is what bounds spend. This is for the shape of abuse a quota does
// not catch: a loop that mints ten thousand presigned URLs, a client bug that
// polls `listExports` every millisecond, an enumeration sweep over `/videos/:id`
// looking for a row RLS will not hand over. Cheap requests, in volume.
//
// **In memory, and single-instance.** One API container today (plan §3.3), so
// a shared store would be a round trip to Postgres per request to coordinate
// with nobody. Two consequences worth naming rather than discovering: a restart
// forgives everyone, and scaling the API horizontally multiplies every limit by
// the instance count. Both are acceptable now and both are the reason to move
// this to the database — not to a bigger in-memory number — when the API is
// scaled out.

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./context.js";
import { tooManyRequests } from "./errors.js";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Swept lazily rather than on a timer: a `setInterval` here would keep the
 * process alive and would have to be torn down by every test that imports this
 * file. Entries are tiny and a walk of an expired map is O(users). */
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60_000;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Counts one hit against `key` and returns how long to wait, or null if it is
 * allowed. Exported for the tests, which would otherwise have to make hundreds
 * of HTTP calls to observe a limit.
 */
export function consume(key: string, max: number, windowMs: number, now = Date.now()): number | null {
  sweep(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  bucket.count += 1;
  if (bucket.count > max) return (bucket.resetAt - now) / 1000;
  return null;
}

/** Drops every counter. For tests, and for nothing else — a production reset
 * is a process restart. */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}

export interface RateLimitRule {
  /** Requests allowed per window. */
  max: number;
  windowMs: number;
  /** Distinguishes one rule's counters from another's for the same user. */
  name: string;
}

/**
 * The general ceiling on a signed-in user's API traffic. Generous: the SPA
 * polls export progress and re-fetches lists on navigation, and a limit a
 * normal session can reach is a bug report, not a defence.
 */
export const GENERAL: RateLimitRule = { name: "general", max: 600, windowMs: 60_000 };

/**
 * The narrower one, on the calls that mint credentials or schedule work:
 * upload tickets, part URLs, playback and download URLs, pipeline enqueues,
 * exports. Still well above what the UI does — importing twenty files is
 * twenty upload tickets — and far below what a loop does.
 */
export const EXPENSIVE: RateLimitRule = { name: "expensive", max: 120, windowMs: 60_000 };

/** Applies `rule`, keyed by the caller's user id. */
export function rateLimit(rule: RateLimitRule): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const retryAfter = consume(`${rule.name}:${c.get("userId")}`, rule.max, rule.windowMs);
    if (retryAfter !== null) {
      throw tooManyRequests(
        "Too many requests. Wait a moment and try again.",
        retryAfter,
      );
    }
    await next();
  };
}

/**
 * The paths `EXPENSIVE` covers, as a predicate on method and path.
 *
 * A list rather than per-route middleware because these routes live in five
 * files and are registered by a factory in one of them; a single matcher
 * mounted once is both easier to read and impossible to forget on a new route
 * that fits the pattern.
 */
export function isExpensive(method: string, path: string): boolean {
  if (method !== "POST") return false;
  return (
    path.endsWith("/uploads") ||
    path.includes("/upload/") ||
    path.endsWith("/complete") ||
    path.endsWith("/playback-url") ||
    path.endsWith("/download-url") ||
    path.endsWith("/extract") ||
    path.endsWith("/transcribe") ||
    path.endsWith("/analyze") ||
    path.endsWith("/exports") ||
    // The one route that calls a model inside the request (M5's
    // `previewLessonSegmentEdit`), so the most expensive request the API
    // serves per call.
    path.endsWith("/segment-edit/preview")
  );
}
