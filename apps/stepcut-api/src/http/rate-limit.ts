// Per-user request limiting for the tenant API.
//
// Copied from apps/api/src/http/rate-limit.ts because it is cheap to copy —
// but, unlike apps/api, **not wired into `app.ts` yet** (plan §1's Step 1
// description). Phase 1 has exactly one route (`GET /orgs`), nothing
// expensive exists to limit, and `isExpensive`'s path list below is entirely
// apps/api's domain routes (uploads, exports, …) that do not exist here. Wire
// this in once a route worth limiting does.
//
// **In memory, and single-instance.** One API container, so a shared store
// would be a round trip to Postgres per request to coordinate with nobody. A
// restart forgives everyone; scaling the API horizontally multiplies every
// limit by the instance count. Both are acceptable now and both are the
// reason to move this to the database when the API is scaled out, not before.

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
 * allowed.
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

/** The general ceiling on a signed-in user's API traffic. */
export const GENERAL: RateLimitRule = { name: "general", max: 600, windowMs: 60_000 };

/** The narrower one, on calls that mint credentials or schedule work.
 * Nothing currently matches `isExpensive` below — see this file's header. */
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
 * The paths `EXPENSIVE` covers, as a predicate on method and path. Empty in
 * Phase 1 — no route matches any of apps/api's expensive-route suffixes,
 * since those are all domain routes stepcut does not have yet. Fill in as
 * later phases add routes worth this treatment.
 */
// `_path` is unused only because Phase 1 has no route worth this treatment
// yet; the two-argument signature is kept so a later phase's `app.ts` can
// wire this in with the same `isExpensive(c.req.method, c.req.path)` call
// apps/api uses. The leading underscore is this project's convention (see
// eslint.config.js) for a parameter kept for signature compatibility.
export function isExpensive(method: string, _path: string): boolean {
  if (method !== "POST") return false;
  return false;
}
