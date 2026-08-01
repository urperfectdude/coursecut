// Enqueuing the long-running work (plan D3).
//
// Desktop runs ffmpeg and the OpenAI calls inline and returns when they are
// done. An HTTP request cannot hold open for a 40-minute transcode, so here
// the call writes a job row, returns immediately, and completion arrives on
// the progress stream. From the UI's side nothing changes: it awaits the call
// and watches progress either way.
//
// **Two tables, one job.** `jobs` is the user-visible projection — what the
// SSE stream reports against and what a Retry acts on — and it is tenant-
// scoped and RLS-covered. `graphile_worker`'s own tables are the queue, and
// own scheduling, locking and crash recovery. Keeping them separate is what
// lets the queue stay swappable, and what keeps a job's *meaning* inside RLS
// while the queue's internals (which have no `org_id`) sit outside it.
//
// **The enqueue is transactional.** `graphile_worker.add_job` runs on the
// caller's transaction, so the queued job appears only if the row it describes
// commits — no work is ever scheduled against a video whose insert rolled
// back, and no committed row is left with nothing scheduled for it.
//
// **`job_key` makes enqueuing idempotent.** Every job is keyed by the id of
// the thing it operates on, with `add_job`'s default `replace` mode, so a
// double-clicked Retry or a resume racing a re-poll collapses to one queued
// job rather than two encodes of the same lesson.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { publishProgress, type ProgressEvent } from "../events.js";
import { newId } from "../domain/lessons.js";

export type JobKind = "extract" | "transcribe" | "analyze" | "export";

export type JobRow = typeof jobs.$inferSelect;

/** The graphile-worker task names, matching `apps/worker/src/main.ts`. */
export const VIDEO_TASK = "video-pipeline";
export const EXPORT_TASK = "export";
/**
 * M7's retention sweep. Unlike the two above it is never enqueued from a
 * request — it is fired by the worker's crontab — and it writes no `jobs` row,
 * because that table is the projection of a *tenant's* work and a maintenance
 * task appearing in someone's progress stream would be a bug.
 */
export const RETENTION_TASK = "retention-sweep";

/** The pipeline stage each video job reports as, in `VideoProgress` terms. */
const STAGE: Record<"extract" | "transcribe" | "analyze", ProgressEvent["stage"]> = {
  extract: "ExtractingAudio",
  transcribe: "Transcribing",
  analyze: "Analyzing",
};

/** What the UI shows beside the bar until the worker says something better. */
const OPENING_DETAIL: Record<"extract" | "transcribe" | "analyze", string> = {
  extract: "Extracting audio",
  transcribe: "Transcribing audio",
  analyze: "Finding lesson boundaries",
};

/**
 * Queues a task on `graphile_worker`, on the caller's transaction.
 *
 * Called with the `Tx` so it commits with the row it belongs to (see this
 * file's header). `runAt` is used by the worker to re-schedule a paused export
 * rather than spinning on it.
 */
export function addQueueJob(
  tx: Tx,
  identifier: string,
  payload: Record<string, unknown>,
  options: { jobKey: string; runAt?: Date },
): Promise<unknown> {
  return tx.execute(
    sql`select graphile_worker.add_job(
      ${identifier},
      payload := ${JSON.stringify(payload)}::json,
      job_key := ${options.jobKey},
      run_at := ${options.runAt ?? null}::timestamptz,
      max_attempts := ${MAX_ATTEMPTS}
    )`,
  );
}

/**
 * Three, against `add_job`'s default of 25.
 *
 * Retrying is the *user's* call in this product — a failed transcode leaves a
 * row with an error and a Retry button, on desktop and here alike — and a
 * handler that fails for a real reason records that itself and returns
 * normally, so the queue never sees it. What is left for the queue to retry is
 * the unexpected: the database going away mid-job, the process being killed.
 * Those are worth a couple of attempts and nothing like 25, which for a job
 * that calls Whisper would be 25 times the bill for the same failure.
 */
const MAX_ATTEMPTS = 3;

/**
 * Queues a pipeline job for a video and announces it.
 *
 * The announcement is not decoration: without it the UI would sit inert
 * between the call returning and the worker's first real progress event, which
 * on a busy queue could be minutes. `fraction: null` is the indeterminate
 * case `useVideoProgress` already renders as a spinner.
 *
 * `attempt` is stamped onto every event this run emits — 1 for a fresh
 * import, higher for a Retry — same convention as desktop.
 */
export async function enqueueVideoJob(
  tx: Tx,
  orgId: string,
  kind: "extract" | "transcribe" | "analyze",
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

  // Keyed by kind and video rather than by job id: two Retry clicks on the
  // same video should be one extraction, not two racing each other over the
  // same row. The newer job row wins, and the older one is left `queued` —
  // visible, and harmless, because the worker only ever acts on the id the
  // queue handed it.
  await addQueueJob(
    tx,
    VIDEO_TASK,
    { job_id: job!.id, org_id: orgId },
    { jobKey: `${kind}:${videoId}` },
  );

  await publishProgress(tx, {
    org_id: orgId,
    video_id: videoId,
    stage: STAGE[kind],
    fraction: null,
    detail: OPENING_DETAIL[kind],
    attempt,
  });

  return job!;
}

/** Queues an export. Export progress is read off the `exports` row, not the
 * `VideoProgress` stream — it belongs to a lesson, not a video, and Export
 * History polls it exactly as desktop's does — so nothing is published here. */
export async function enqueueExportJob(
  tx: Tx,
  orgId: string,
  exportId: string,
): Promise<JobRow> {
  const [job] = await tx
    .insert(jobs)
    .values({ id: newId(), orgId, kind: "export", state: "queued", exportId })
    .returning();
  await requeueExport(tx, orgId, exportId);
  return job!;
}

/**
 * (Re-)schedules an export.
 *
 * Also what Resume and Retry call: both flip `exports.status` back to `queued`,
 * and without a queue job to match, the row would sit there looking queued
 * with nothing coming for it. The `job_key` means calling this against an
 * export that already has one pending replaces it rather than adding a second.
 */
export function requeueExport(
  tx: Tx,
  orgId: string,
  exportId: string,
  runAt?: Date,
): Promise<unknown> {
  return addQueueJob(
    tx,
    EXPORT_TASK,
    { export_id: exportId, org_id: orgId },
    { jobKey: `export:${exportId}`, runAt },
  );
}

/** The most recent job of a kind for a video — what a Retry increments from. */
export async function latestJob(
  tx: Tx,
  videoId: string,
  kind: JobKind,
): Promise<JobRow | undefined> {
  const [job] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.videoId, videoId), eq(jobs.kind, kind)))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return job;
}

/**
 * Cancels a video's outstanding pipeline jobs. Called when the row they
 * operate on is deleted, so the worker has an unambiguous signal not to pick
 * them up rather than failing on a missing video.
 *
 * The queue entries themselves are left alone: they will run, see a job row
 * that is `cancelled` (or gone, since `jobs` cascades from `videos`), and
 * return without doing anything. Deleting them here would mean reaching into
 * the queue's tables to undo something the `jobs` row already says.
 */
export async function cancelJobsForVideo(tx: Tx, videoId: string): Promise<void> {
  await tx
    .update(jobs)
    .set({ state: "cancelled", updatedAt: new Date() })
    .where(and(eq(jobs.videoId, videoId), eq(jobs.state, "queued")));
}

/**
 * The same for an export the user cancelled.
 *
 * Added at M7, and the reason is worth recording because it was invisible
 * before: cancelling an export marked the `exports` row and left its `jobs`
 * row saying `queued` forever. Nothing read that row, so nothing was wrong —
 * until the active-job cap started counting it, at which point every cancelled
 * export permanently consumed a slot of the tenant's budget. The cap did not
 * cause the bug; it was the first thing to look at the value.
 *
 * `finalize` in the worker already writes `done`/`failed` for a job that ran,
 * so this only covers the one that never will.
 */
export async function cancelJobsForExport(tx: Tx, exportId: string): Promise<void> {
  await tx
    .update(jobs)
    .set({ state: "cancelled", updatedAt: new Date() })
    .where(and(eq(jobs.exportId, exportId), eq(jobs.state, "queued")));
}
