// Webhook delivery — Phase 5 ("Templates & render"), this slice.
//
// Enqueued from `tasks/render.ts`'s `finalize`, once a `done`/`failed`
// outcome has committed and `renders.callback_url` is set. POSTs a status
// update to that URL and updates `renders.webhook_status`/`webhook_attempts`/
// `webhook_last_error` — see `db/schema.ts`'s `renders` comment for what those
// columns mean.
//
// **No retry loop here, on purpose.** A failed delivery attempt throws,
// handing retry/backoff to `graphile-worker`'s own attempt mechanism
// (`jobs/queue.ts`'s `enqueueWebhookJob`, `max_attempts: 8`). Rolling a
// second retry loop on top of the queue's would just be two backoff
// schedules disagreeing with each other.
//
// `webhook_status` design: null means "no callback_url was ever set" (this
// task returns immediately if `row.callbackUrl` is null — no job should ever
// be enqueued for that case, and `enqueueWebhookJob`'s only caller checks
// this first). The first attempt for a render that *does* have a
// `callback_url` flips it to "pending" before the POST goes out, so a caller
// polling `GET /renders/:id` can tell "no webhook configured" apart from
// "configured, still trying". It becomes "delivered" on a 2xx response, or
// "failed" — but only once `helpers.job.attempts` has reached
// `helpers.job.max_attempts` (graphile-worker increments `attempts` before
// invoking the task, so this job's own `attempts` already reflects the
// attempt in progress), so a caller is never told "failed" while a retry is
// still coming. Short of that, it stays "pending": a `webhook_status` stuck
// at "pending" after the real retries are exhausted (if this count were ever
// wrong) is a much smaller UX gap than reporting "delivered" or "failed" too
// early.
//
// SSRF note (see `domain/renders.ts`'s `isPrivateOrLoopbackHost` header): that
// guard only inspects the hostname as given at `callback_url`-creation time,
// not where a hostname's DNS actually resolves — a gap it explicitly flags as
// needing to be closed "before `callback_url` is trusted for anything beyond
// this phase's use". This task is exactly that "beyond": it is the thing that
// actually dereferences the URL. Full DNS-pinning is out of scope for this
// slice, but `redirect: "manual"` below closes the one bypass that would
// otherwise be trivial — a public, allowed host redirecting the request to an
// internal one — by treating any redirect response as a delivery failure
// rather than following it (see `deliver`'s comment for exactly what shape
// that response comes back as, which is runtime-dependent).

import { withOrg } from "../../../stepcut-api/src/db/client.js";
import { eq } from "../../../stepcut-api/src/db/ops.js";
import { renders } from "../../../stepcut-api/src/db/schema.js";
import * as storage from "../../../stepcut-api/src/storage.js";
import type { JobHelpers } from "graphile-worker";

export interface WebhookJobPayload {
  render_id: string;
  org_id: string;
}

/** Generous next to the pipeline's own ffmpeg/Whisper timeouts — this is
 * someone else's server, and a slow-but-alive endpoint should not be treated
 * the same as a dead one. */
const DELIVERY_TIMEOUT_MS = 10_000;

type RenderRow = typeof renders.$inferSelect;

export async function runWebhookJob(payload: WebhookJobPayload, helpers: JobHelpers): Promise<void> {
  const { render_id: renderId, org_id: orgId } = payload;

  const row = await withOrg(orgId, async (tx) => {
    const [r] = await tx.select().from(renders).where(eq(renders.id, renderId)).limit(1);
    return r;
  });
  // Gone (the render's video or template cascaded it away) — nothing to
  // deliver.
  if (!row) return;
  // No callback configured. Shouldn't happen — `finalize` only enqueues this
  // task when `callback_url` is set — but this is the row's own source of
  // truth, not a re-check of the caller's.
  if (!row.callbackUrl) return;
  // Already delivered. The queue delivers at least once (same reasoning
  // `runVideoJob`/`runRenderJob` already document for their own "already
  // finished" guards), and a second POST to a subscriber that already got the
  // first one is exactly the kind of duplicate this guard exists to avoid.
  if (row.webhookStatus === "delivered") return;

  if (row.webhookStatus === null) {
    await withOrg(orgId, (tx) =>
      tx.update(renders).set({ webhookStatus: "pending" }).where(eq(renders.id, renderId)),
    );
  }

  const body = buildPayload(row, await outputUrl(row));
  const result = await deliver(row.callbackUrl, body);

  const isLastAttempt = helpers.job.attempts >= helpers.job.max_attempts;
  await withOrg(orgId, (tx) =>
    tx
      .update(renders)
      .set(
        result.ok
          ? { webhookStatus: "delivered", webhookAttempts: row.webhookAttempts + 1, webhookLastError: null }
          : {
              webhookStatus: isLastAttempt ? "failed" : "pending",
              webhookAttempts: row.webhookAttempts + 1,
              webhookLastError: result.error,
            },
      )
      .where(eq(renders.id, renderId)),
  );

  // Hands retry/backoff to graphile-worker — see this file's header.
  if (!result.ok) throw new Error(result.error);
}

/** A fresh download URL, minted the same way `GET /renders/:id` mints one —
 * only for a `done` render, never stored. */
async function outputUrl(row: RenderRow): Promise<string | undefined> {
  if (row.status !== "done" || !row.outputKey) return undefined;
  return storage.presignGet(row.outputKey);
}

function buildPayload(row: RenderRow, outputUrl: string | undefined): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    ...(outputUrl !== undefined ? { output_url: outputUrl } : {}),
    ...(row.status === "failed" ? { error: row.error } : {}),
  };
}

/**
 * POSTs the payload, treating a redirect the same as any other failure — see
 * this file's header for why `redirect: "manual"` matters here.
 */
async function deliver(callbackUrl: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  // `redirect: "manual"` stops `fetch` from following a 3xx itself. Which
  // shape the response actually comes back as is runtime-dependent — the
  // fetch spec's `opaqueredirect` (status 0) is one documented outcome, but
  // Node's own `fetch` (undici) has been observed returning the redirect
  // response as-is (`type: "basic"`, real 3xx status) instead — so this
  // checks for both rather than assuming one.
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    return { ok: false, error: "webhook responded with a redirect, which is not followed" };
  }
  if (!response.ok) {
    return { ok: false, error: `webhook responded with status ${response.status}` };
  }
  return { ok: true };
}
