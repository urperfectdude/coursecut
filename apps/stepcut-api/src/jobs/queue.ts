// Enqueuing the long-running work.
//
// Own copy of apps/api/src/jobs/queue.ts, trimmed to Phase 2's two stages
// (`extract`, `transcribe` — no `analyze`/`export`/`render` yet, and
// correspondingly no `enqueueExportJob`/`requeueExport`/`cancelJobsForExport`/
// `latestJob`, which are export/retry-surface concerns for later phases).
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

export type JobKind = "extract" | "transcribe";

export type JobRow = typeof jobs.$inferSelect;

/** The graphile-worker task name, matching `apps/stepcut-worker/src/main.ts`. */
export const VIDEO_TASK = "video-pipeline";

/** What a job row shows before the worker reports anything better. */
const OPENING_DETAIL: Record<JobKind, string> = {
  extract: "Extracting audio",
  transcribe: "Transcribing audio",
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

const newId = () => crypto.randomUUID();

/**
 * Queues a task on `graphile_worker`, on the caller's transaction, so it
 * commits with the row it belongs to.
 */
function addQueueJob(
  tx: Tx,
  identifier: string,
  payload: Record<string, unknown>,
  jobKey: string,
): Promise<unknown> {
  return tx.execute(
    sql`select graphile_worker.add_job(
      ${identifier},
      payload := ${JSON.stringify(payload)}::json,
      job_key := ${jobKey},
      max_attempts := ${MAX_ATTEMPTS}
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
