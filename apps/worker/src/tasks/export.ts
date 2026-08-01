// The export job (D5): cut a lesson's segments, join them, put the MP4 in
// storage.
//
// `src-tauri/src/export.rs`'s worker ported, with three differences forced by
// the split into two processes and by there being no local folder to write to:
//
//   * **The output is an object, not a file.** No collision handling to port —
//     the key contains the export's own id, so it is unique by construction
//     (see `routes/exports.ts`). Desktop's `unique_output_path` has nothing to
//     do here.
//   * **Cancellation arrives through the database.** Desktop's `cancel_export`
//     kills the ffmpeg child directly because it owns the process; the API
//     cannot, so it marks the row and this poll notices within a second or two
//     and kills the child itself. The post-encode status check is unchanged,
//     and is what makes cancellation stick either way: a cancelled row is
//     never overwritten with `done`.
//   * **A paused job is rescheduled, not skipped.** Desktop's worker polls the
//     table, so `paused` simply never gets picked up. Here the queue entry
//     already exists, so a job that finds its row paused puts itself back with
//     a delay rather than failing or spinning.
//
// Pause/resume still only apply before encoding starts. Suspending a live
// ffmpeg process portably is not something either app attempts.

import { and, eq } from "../../../api/src/db/ops.js";
import { withOrg } from "../../../api/src/db/client.js";
import { exports as exportsTable, jobs, lessonSegments, lessons, videos } from "../../../api/src/db/schema.js";
import { env } from "../../../api/src/env.js";
import { requeueExport } from "../../../api/src/jobs/queue.js";
import * as storage from "../../../api/src/storage.js";
import { concatVideos, cutSegment, type FfmpegRun } from "../ffmpeg.js";
import { withScratchDir } from "../scratch.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";

export interface ExportJobPayload {
  export_id: string;
  org_id: string;
}

/** How long a paused export waits before looking at its row again. Resume
 * re-queues immediately (`requeueExport` replaces this delayed entry), so this
 * is only the ceiling for a resume that raced it. */
const PAUSED_RECHECK_MS = 30_000;

/** How often a running encode re-reads its row to see whether it was
 * cancelled. Desktop checks between segments only; polling as well means a
 * cancel during a single long segment does not have to wait it out. */
const CANCEL_POLL_MS = 2000;

interface PendingExport {
  id: string;
  orgId: string;
  outputKey: string;
  storageKey: string;
  segments: Array<{ start: number; end: number }>;
}

export async function runExportJob(payload: ExportJobPayload): Promise<void> {
  const { export_id: exportId, org_id: orgId } = payload;

  const claim = await claimExport(orgId, exportId);
  if (claim === "paused") {
    await withOrg(orgId, (tx) =>
      requeueExport(tx, orgId, exportId, new Date(Date.now() + PAUSED_RECHECK_MS)),
    );
    return;
  }
  if (claim === "skip") return;

  try {
    const uploaded = await encodeAndUpload(claim);
    await finalize(orgId, exportId, undefined, uploaded);
  } catch (err) {
    await finalize(orgId, exportId, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Moves the row `queued` → `running` and returns what to cut.
 *
 * The claim is guarded by `AND status = 'queued'`, exactly as desktop's
 * `mark_running` is: without it, a cancel landing between the queue handing
 * this job over and the update committing would be silently undone —
 * `queued → cancelled → running` — and a cancelled export would run to
 * completion.
 *
 * `segments` is the lesson's real `lesson_segments`, in playback order, never
 * `lessons.start`/`.end`. For a non-contiguous lesson that cached bound is min
 * start to max end, so cutting it as one span would re-include precisely the
 * gaps the user excluded.
 */
async function claimExport(
  orgId: string,
  exportId: string,
): Promise<PendingExport | "paused" | "skip"> {
  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: exportsTable.id,
        status: exportsTable.status,
        outputKey: exportsTable.outputKey,
        lessonId: exportsTable.lessonId,
      })
      .from(exportsTable)
      .where(eq(exportsTable.id, exportId))
      .limit(1);
    if (!row) return "skip";
    if (row.status === "paused") return "paused";
    if (row.status !== "queued") return "skip";

    const [video] = await tx
      .select({ storageKey: videos.storageKey })
      .from(videos)
      .innerJoin(lessons, eq(lessons.videoId, videos.id))
      .where(eq(lessons.id, row.lessonId))
      .limit(1);
    if (!video) return "skip";

    const segments = await tx
      .select({ start: lessonSegments.start, end: lessonSegments.end })
      .from(lessonSegments)
      .where(eq(lessonSegments.lessonId, row.lessonId))
      .orderBy(lessonSegments.sortOrder, lessonSegments.id);

    // The `status = 'queued'` half of this is the guard, not the read above:
    // under READ COMMITTED a cancel committing between that SELECT and this
    // UPDATE would otherwise be overwritten, and the export would run.
    const claimed = await tx
      .update(exportsTable)
      .set({ status: "running" })
      .where(and(eq(exportsTable.id, exportId), eq(exportsTable.status, "queued")))
      .returning({ id: exportsTable.id });
    if (claimed.length === 0) return "skip";

    return {
      id: exportId,
      orgId,
      outputKey: row.outputKey,
      storageKey: video.storageKey,
      segments,
    };
  });
}

/**
 * Cuts, joins and uploads.
 *
 * A single-segment lesson — the common case — takes the fast path desktop
 * takes: one `cutSegment` straight to the output file, no temp file and no
 * concat, so it is byte-identical to what a single-segment export produced
 * before multi-segment lessons existed (no extra re-mux, no second lossy
 * pass).
 */
async function encodeAndUpload(job: PendingExport): Promise<{ sizeBytes: number }> {
  if (job.segments.length === 0) {
    throw new Error("this lesson has no segments to export");
  }

  return withScratchDir(job.id, async (dir) => {
    const sourcePath = join(dir, "source");
    await storage.downloadToFile(job.storageKey, sourcePath);
    const outputPath = join(dir, "output.mp4");

    const total = job.segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
    let elapsed = 0;
    const parts: string[] = [];

    for (const [index, segment] of job.segments.entries()) {
      await assertNotCancelled(job);

      const single = job.segments.length === 1;
      const target = single ? outputPath : join(dir, `segment-${index}.mp4`);
      const segmentDuration = Math.max(0, segment.end - segment.start);
      // Weighted by duration rather than by segment count: a job of one
      // 40-minute segment and one 10-second one is not half done when the
      // short one finishes.
      const base = elapsed;
      await watchForCancel(job, () =>
        cutSegment(sourcePath, segment.start, segment.end, target, (fraction) => {
          const overall = total > 0 ? (base + fraction * segmentDuration) / total : fraction;
          void setProgress(job, overall);
        }),
      );

      parts.push(target);
      elapsed += segmentDuration;
    }

    if (parts.length > 1) {
      await assertNotCancelled(job);
      await watchForCancel(job, () => concatVideos(parts, outputPath, dir));
    }

    await assertNotCancelled(job);
    await storage.uploadFile(job.outputKey, outputPath, "video/mp4");
    // The size of what was actually written, for M7's storage meter. Taken
    // from the local file rather than a HEAD against storage: it is the same
    // number and it is already on disk.
    return { sizeBytes: (await stat(outputPath)).size };
  });
}

/**
 * Runs one ffmpeg invocation, killing it if the row turns `cancelled`.
 *
 * This is the cross-process half of `cancel_export`: the API marks the row (it
 * has no handle on the process), and this is what acts on the mark. A killed
 * process rejects with a message that would read like a genuine failure, which
 * is why `finalize` re-reads the row rather than trusting the outcome.
 */
async function watchForCancel(job: PendingExport, start: () => FfmpegRun): Promise<void> {
  const run = start();
  const poll = setInterval(() => {
    void isCancelled(job).then((cancelled) => {
      if (cancelled) run.kill();
    });
  }, CANCEL_POLL_MS);
  // Node keeps the process alive for a pending interval; this one should never
  // be the reason the worker will not shut down.
  poll.unref?.();

  try {
    await run.done;
  } finally {
    clearInterval(poll);
  }
}

async function assertNotCancelled(job: PendingExport): Promise<void> {
  if (await isCancelled(job)) throw new Error("export cancelled");
}

/** Defaults to "not cancelled" if the row cannot be read, so a transient
 * database blip never stops a job nobody cancelled. */
async function isCancelled(job: PendingExport): Promise<boolean> {
  try {
    const status = await withOrg(job.orgId, async (tx) => {
      const [row] = await tx
        .select({ status: exportsTable.status })
        .from(exportsTable)
        .where(eq(exportsTable.id, job.id))
        .limit(1);
      return row?.status;
    });
    return status === "cancelled";
  } catch {
    return false;
  }
}

/** Progress only moves while the row is still `running`, so a line arriving
 * from ffmpeg just before it is killed cannot resurrect a cancelled row. */
function setProgress(job: PendingExport, fraction: number): Promise<unknown> {
  return withOrg(job.orgId, (tx) =>
    tx
      .update(exportsTable)
      .set({ progress: Math.min(1, Math.max(0, fraction)) })
      .where(eq(exportsTable.id, job.id)),
  ).catch(() => undefined);
}

/**
 * Writes the final status — unless the row was cancelled while the encode was
 * unwinding, in which case that status is left alone and anything already
 * uploaded is removed. A cancelled export must not leave a downloadable object
 * behind, and it must not be reported as `failed` either: the kill is the
 * reason it stopped, and the user knows.
 */
async function finalize(
  orgId: string,
  exportId: string,
  error: string | undefined,
  uploaded?: { sizeBytes: number },
): Promise<void> {
  const outcome = await withOrg(orgId, async (tx) => {
    const [row] = await tx
      .select({ status: exportsTable.status, outputKey: exportsTable.outputKey })
      .from(exportsTable)
      .where(eq(exportsTable.id, exportId))
      .limit(1);
    if (!row) return undefined;

    if (row.status === "cancelled") return { cleanup: row.outputKey };

    await tx
      .update(exportsTable)
      .set(
        error === undefined
          ? {
              status: "done",
              progress: 1,
              error: null,
              // M7. The size is the storage meter; the expiry is what the
              // retention sweep acts on, and the first thing in this codebase
              // to write the column M2 added for it. An export is derived — a
              // re-export costs one job — which is why it is the one thing
              // with a retention default rather than an opt-in window.
              sizeBytes: uploaded?.sizeBytes ?? null,
              downloadExpiresAt: new Date(
                Date.now() + env.retentionExportDays() * 24 * 60 * 60 * 1000,
              ),
            }
          : { status: "failed", error },
      )
      .where(eq(exportsTable.id, exportId));
    await tx
      .update(jobs)
      .set({
        state: error === undefined ? "done" : "failed",
        error: error ?? null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.exportId, exportId));
    return undefined;
  });

  if (outcome?.cleanup) {
    // Best-effort, and post-commit: an object left behind is M7's retention
    // sweep to catch, whereas refusing the status write because a bucket call
    // failed would leave the row lying about what happened.
    await storage.deleteObject(outcome.cleanup).catch(() => undefined);
  }
}
