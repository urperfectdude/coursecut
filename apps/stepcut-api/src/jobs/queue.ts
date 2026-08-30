// Enqueuing the long-running work.
//
// Own copy of apps/api/src/jobs/queue.ts, trimmed to what's shipped so far:
// `extract`, `transcribe` (Phase 2), `analyze` (Phase 3), `render` (Phase 5's
// first render slice), and `render-webhook` (Phase 5, this slice). No
// `requeueExport`/`latestJob`-equivalent for renders — a render has no retry
// surface (this slice's constraints; see domain/renders.ts), so there is
// nothing here that puts a render back on the queue once it is running or
// terminal.
//
// **Two tables, one job.** `jobs` is the tenant-visible projection —
// RLS-covered, and what a future poll/progress surface and a Retry button act
// on. `graphile_worker`'s own tables are the queue, and own scheduling,
// locking and crash recovery. Keeping them separate is what lets the queue
// stay swappable, and what keeps a job's *meaning* inside RLS while the
// queue's internals (which have no `org_id`) sit outside it.
//
// **The enqueue is transactional.** `graphile_worker.add_job` runs on the
// caller's transaction, so the queued job appears only if the row it
// describes commits.
//
// **No progress announcement here** — a deliberate Phase 2 simplification.
// apps/api's copy of this file also calls `publishProgress` (a Postgres
// `NOTIFY` an SSE endpoint relays to the browser) right after queuing, so the
// UI is never left staring at nothing between the request returning and the
// worker's first real progress event. StepCut has no SSE stream yet (plan:
// polling `GET /api/videos` stands in for it in Phase 2) — see
// `apps/stepcut-worker/src/progress.ts`'s header for the other half of this
// same simplification, and the seam a future SSE addition would slot into.

import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { jobs } from "../db/schema.js";

export type JobKind = "extract" | "transcribe" | "analyze" | "render";

export type JobRow = typeof jobs.$inferSelect;

/** The graphile-worker task name, matching `apps/stepcut-worker/src/main.ts`. */
export const VIDEO_TASK = "video-pipeline";

/**
 * The graphile-worker task name for a render. Not yet handled by
 * `apps/stepcut-worker/src/main.ts` — that registration is this phase's next
 * slice's job — but the name is needed here since `enqueueRenderJob` below
 * queues against it regardless of which side lands first.
 */
export const RENDER_TASK = "render";

/** The graphile-worker task name for webhook delivery, matching
 * `apps/stepcut-worker/src/main.ts`'s registration of `runWebhookJob`. */
export const WEBHOOK_TASK = "render-webhook";

/** What a job row shows before the worker reports anything better. */
const OPENING_DETAIL: Record<JobKind, string> = {
  extract: "Extracting audio",
  transcribe: "Transcribing audio",
  analyze: "Finding steps",
  render: "Rendering",
};

/**
 * Three, against `add_job`'s default of 25 — the same call `apps/api` makes.
 * Retrying is the user's call in this product: a failed job leaves a row with
 * an error a future Retry button can act on, and a handler that fails for a
 * real reason records that itself and returns normally, so the queue never
 * sees it. What is left for the queue to retry is the unexpected (the
 * database going away mid-job, the process being killed), which is worth a
 * couple of attempts and nothing like 25 — for a job that calls Whisper, 25
 * would be 25 times the bill for the same failure.
 */
const MAX_ATTEMPTS = 3;

/**
 * Against `MAX_ATTEMPTS`'s 3: a webhook POST costs nothing to retry — no
 * OpenAI bill, no re-encode, just a network round trip — so it is worth
 * trying much harder before giving up on a subscriber that is only
 * intermittently reachable.
 */
const WEBHOOK_MAX_ATTEMPTS = 8;

const newId = () => crypto.randomUUID();

/**
 * Queues a task on `graphile_worker`, on the caller's transaction, so it
 * commits with the row it belongs to. `maxAttempts` defaults to the pipeline
 * stages' conservative `MAX_ATTEMPTS`; `enqueueWebhookJob` below overrides it.
 */
function addQueueJob(
  tx: Tx,
  identifier: string,
  payload: Record<string, unknown>,
  jobKey: string,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<unknown> {
  return tx.execute(
    sql`select graphile_worker.add_job(
      ${identifier},
      payload := ${JSON.stringify(payload)}::json,
      job_key := ${jobKey},
      max_attempts := ${maxAttempts}
    )`,
  );
}

/**
 * Queues a pipeline job for a video.
 *
 * `attempt` is stamped onto the row — 1 for a fresh import, higher for a
 * retry of the same stage, same convention as apps/api's copy.
 */
export async function enqueueVideoJob(
  tx: Tx,
  orgId: string,
  kind: JobKind,
  videoId: string,
  attempt: number,
): Promise<JobRow> {
  const [job] = await tx
    .insert(jobs)
    .values({
      id: newId(),
      orgId,
      kind,
      state: "queued",
      videoId,
      attempt,
      progress: null,
      detail: OPENING_DETAIL[kind],
    })
    .returning();

  // Keyed by kind and video rather than by job id: two retries of the same
  // video collapse to one queued job rather than two racing each other over
  // the same row. The newer job row wins, and the older one is left
  // `queued` — visible, and harmless, because the worker only ever acts on
  // the id the queue handed it.
  await addQueueJob(tx, VIDEO_TASK, { job_id: job!.id, org_id: orgId }, `${kind}:${videoId}`);

  return job!;
}

/**
 * Cancels a video's outstanding pipeline jobs. Called when the row they
 * operate on is deleted, so the worker has an unambiguous signal not to pick
 * them up rather than failing on a missing video.
 *
 * The queue entries themselves are left alone: they will run, see a job row
 * that is `cancelled` (or gone, since `jobs` cascades from `videos`), and
 * return without doing anything.
 */
export async function cancelJobsForVideo(tx: Tx, videoId: string): Promise<void> {
  await tx
    .update(jobs)
    .set({ state: "cancelled", updatedAt: new Date() })
    .where(and(eq(jobs.videoId, videoId), eq(jobs.state, "queued")));
}

/**
 * Queues a render, keyed by `renderId` rather than by `videoId` — unlike
 * extract/transcribe/analyze, two renders of the same video against
 * different templates are both legitimate at once, and a `videoId`-keyed
 * `job_key` would collapse the second render's enqueue into the first's
 * instead of queuing it.
 */
export async function enqueueRenderJob(tx: Tx, orgId: string, renderId: string): Promise<JobRow> {
  const [job] = await tx
    .insert(jobs)
    .values({
      id: newId(),
      orgId,
      kind: "render",
      state: "queued",
      renderId,
      attempt: 1,
      progress: null,
      detail: OPENING_DETAIL.render,
    })
    .returning();

  await addQueueJob(tx, RENDER_TASK, { job_id: job!.id, org_id: orgId }, `render:${renderId}`);

  return job!;
}

/**
 * Cancels a render's outstanding job. Same shape as `cancelJobsForVideo`,
 * called from the `/renders/:id/cancel` transition alongside marking the
 * `renders` row itself `cancelled`.
 */
export async function cancelJobsForRender(tx: Tx, renderId: string): Promise<void> {
  await tx
    .update(jobs)
    .set({ state: "cancelled", updatedAt: new Date() })
    .where(and(eq(jobs.renderId, renderId), eq(jobs.state, "queued")));
}

/**
 * Queues delivery of a finished render's webhook. Called from
 * `tasks/render.ts`'s `finalize`, in the same transaction as the `done`/
 * `failed` status it is about to report — so a webhook job only ever exists
 * for a terminal status that actually committed (this file's header, "the
 * enqueue is transactional").
 *
 * No `jobs` row: unlike extract/transcribe/analyze/render, webhook delivery
 * is not a pipeline stage a tenant's dashboard needs to see as a distinct
 * job — there is no "cancel this webhook attempt" action and no `GET` route
 * lists it. `renders.webhook_status`/`webhook_attempts`/`webhook_last_error`
 * are its own status surface instead (this file's header, "two tables, one
 * job" — this is the case where the second table isn't needed at all).
 *
 * Keyed by `renderId` alone: a render's webhook only ever needs one
 * outstanding delivery job, same as `enqueueRenderJob`'s reasoning for why a
 * render (rather than a video) is the right key.
 */
export async function enqueueWebhookJob(tx: Tx, orgId: string, renderId: string): Promise<void> {
  await addQueueJob(
    tx,
    WEBHOOK_TASK,
    { render_id: renderId, org_id: orgId },
    `webhook:${renderId}`,
    WEBHOOK_MAX_ATTEMPTS,
  );
}
