// Render creation, reads, and cancellation — Phase 5 (docs/stepcut-plan.md
// §8: "Templates & render"), this slice.
//
// This file is API/DB-only: it snapshots `steps` into `render_steps` and
// writes the `renders` row, but never touches ffmpeg or storage output —
// that is `apps/stepcut-worker`'s job in the next slice of this phase.
// `cancelRender` is the only lifecycle transition this slice grants a caller;
// `running`/`done`/`failed` are set by the worker alone.
//
// Modeled on `domain/templates.ts` and `domain/steps.ts` for validation style
// (`badRequest`/`notFound` from `http/errors.ts`) and on
// `apps/api/src/routes/exports.ts`'s `transition()` for the cancel-guard
// shape, simplified: StepCut renders have no pause/resume, only cancel.

import { asc, desc, eq } from "drizzle-orm";
import { isIP } from "node:net";
import type { Tx } from "../db/client.js";
import { badRequest, notFound } from "../http/errors.js";
import { renders, renderSteps, steps, videos } from "../db/schema.js";
import { queryTemplate } from "./templates.js";

export const newId = () => crypto.randomUUID();

export type RenderRow = typeof renders.$inferSelect;

async function requireVideo(tx: Tx, videoId: string): Promise<void> {
  const [row] = await tx.select({ id: videos.id }).from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!row) throw notFound(`video ${videoId}`);
}

// ---------------------------------------------------------------------------
// callback_url validation — SSRF guard
// ---------------------------------------------------------------------------
//
// This API and its worker run on the same droplet as Postgres/MinIO (plan
// §7), so an unchecked caller-supplied callback URL is a direct path from an
// authenticated-but-untrusted caller into the droplet's own internal
// services. This check has to happen the moment `callback_url` is accepted
// at all, not deferred to the webhook-delivery slice.
//
// This only inspects the hostname as given — an IP literal, or the literal
// string "localhost" — with simple octet/hextet checks (`net.isIP`, no IP-range
// library). It deliberately does not resolve a non-IP hostname via DNS to
// check where it *actually* points, so a hostname that round-trips through a
// public DNS record pointed at an internal address (DNS rebinding) is not
// caught here. That is a known gap, not an oversight — see this slice's
// report for the full reasoning — and would need to be closed before
// `callback_url` is trusted for anything beyond this phase's use.

function isPrivateOrLoopbackIPv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

function isPrivateOrLoopbackIPv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1") return true; // loopback
  // The first hextet, treating a leading "::" (empty first group) as 0 —
  // enough to test the /7 and /10 prefixes below, which only constrain the
  // first hextet's high bits.
  const firstGroup = normalized.split(":")[0];
  const firstHextet = firstGroup === "" ? 0 : parseInt(firstGroup, 16);
  if (Number.isNaN(firstHextet)) return false;
  if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** Small, deliberately not a full IP-range library — see this file's header
 * for exactly what it does and does not cover. */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  // `URL.hostname` keeps an IPv6 literal's brackets (e.g. "[::1]"); `net.isIP`
  // never recognises a bracketed string, so without stripping them every IPv6
  // literal would silently fall through this check unflagged.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateOrLoopbackIPv4(host);
  if (ipVersion === 6) return isPrivateOrLoopbackIPv6(host);
  return false;
}

function validateCallbackUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest("callback_url must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("callback_url must use http or https");
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    throw badRequest("callback_url must not point at a private, loopback, or link-local address");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function queryRender(tx: Tx, id: string): Promise<RenderRow> {
  const [row] = await tx.select().from(renders).where(eq(renders.id, id)).limit(1);
  if (!row) throw notFound(`render ${id}`);
  return row;
}

/** A video's renders, newest first — `GET /videos/:id/renders`. */
export async function listRendersForVideo(tx: Tx, videoId: string): Promise<RenderRow[]> {
  await requireVideo(tx, videoId);
  return tx.select().from(renders).where(eq(renders.videoId, videoId)).orderBy(desc(renders.createdAt));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Creates a render and snapshots the video's *current* `steps` into
 * `render_steps` — see this file's header. Enqueueing the worker job is the
 * caller's job (`routes/renders.ts`), not this function's, so it stays in the
 * same transaction the route already opened.
 */
export async function createRender(
  tx: Tx,
  orgId: string,
  videoId: string,
  templateId: string,
  callbackUrl?: string,
): Promise<RenderRow> {
  await requireVideo(tx, videoId);
  await queryTemplate(tx, templateId);

  const videoSteps = await tx
    .select()
    .from(steps)
    .where(eq(steps.videoId, videoId))
    .orderBy(asc(steps.sortOrder), asc(steps.start));
  if (videoSteps.length === 0) {
    throw badRequest("this video has no steps to render — analyze or add steps before rendering");
  }

  if (callbackUrl !== undefined) validateCallbackUrl(callbackUrl);

  const [render] = await tx
    .insert(renders)
    .values({
      id: newId(),
      orgId,
      videoId,
      templateId,
      status: "queued",
      progress: null,
      callbackUrl: callbackUrl ?? null,
    })
    .returning();

  await tx.insert(renderSteps).values(
    videoSteps.map((step) => ({
      id: newId(),
      orgId,
      renderId: render!.id,
      stepId: step.id,
      sortOrder: step.sortOrder,
      start: step.start,
      end: step.end,
      title: step.title,
    })),
  );

  return render!;
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * The one lifecycle transition a caller can request: `queued`/`running` →
 * `cancelled`. Anything else — already terminal, or already cancelled — is
 * refused, same refusal-message style as `apps/api/src/routes/exports.ts`'s
 * `transition()`.
 */
export async function cancelRender(tx: Tx, id: string): Promise<RenderRow> {
  const existing = await queryRender(tx, id);
  if (existing.status !== "queued" && existing.status !== "running") {
    throw badRequest(`cannot cancel render ${id}: already ${existing.status}`);
  }

  const [row] = await tx
    .update(renders)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(renders.id, id))
    .returning();
  return row!;
}
