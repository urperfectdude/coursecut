// The render job — Phase 5 ("Templates & render"), this slice: cut each
// snapshotted step, generate a title card per step, assemble everything with
// the template's intro/outro/brand, upload the result, and move `renders`/
// `jobs` to a terminal state.
//
// Structured on `apps/worker/src/tasks/export.ts`'s claim/encode/finalize
// shape (`claimExport` → `encodeAndUpload` → `finalize`, with
// `watchForCancel`/`assertNotCancelled`/`isCancelled`/`setProgress` ported
// alongside it), rewired against this project's `renders`/`render_steps`
// instead of `exports`/`lesson_segments` and this project's own
// `db/client.ts`/`db/ops.ts` instead of `apps/api`'s. Two differences from
// that reference, both forced by this project's shape:
//
//   * **A `jobs` row exists and this task owns its lifecycle**, the way
//     `tasks/video.ts`'s `runVideoJob` owns it for extract/transcribe/
//     analyze — `apps/api`'s exports have no such row-marking step of their
//     own (their `jobs` row goes straight from `queued` to `done`/`failed` in
//     `finalize`, never through `running`). `renders` gets one because the
//     task list already routes by job id (`RENDER_TASK`'s payload is
//     `{ job_id, org_id }`, matching `VIDEO_TASK`'s shape, not `exports`'
//     `{ export_id, org_id }`), so loading and marking the `jobs` row is what
//     `runRenderJob` does first, same as `runVideoJob`.
//   * **No pause/resume.** `claimRender` only ever returns the plan to
//     execute or a `"skip"` sentinel — never `"paused"` — since a render's
//     only mid-flight control is cancel (`domain/renders.ts`'s header).
//
// Webhook delivery itself (POSTing to `callback_url`) is a separate task —
// `tasks/webhook.ts` — enqueued from `finalize` below once a `done`/`failed`
// outcome has committed. This file's only responsibility toward it is that
// one enqueue call.

import { withOrg } from "../../../stepcut-api/src/db/client.js";
import { and, eq } from "../../../stepcut-api/src/db/ops.js";
import { enqueueWebhookJob } from "../../../stepcut-api/src/jobs/queue.js";
import { jobs, renders, renderSteps, templates, videos } from "../../../stepcut-api/src/db/schema.js";
import * as storage from "../../../stepcut-api/src/storage.js";
import { concatVideos, cutSegment, probeDuration, renderTitleCard, type FfmpegRun } from "../ffmpeg.js";
import { withScratchDir } from "../scratch.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";

export interface RenderJobPayload {
  job_id: string;
  org_id: string;
}

/** How often a running encode re-reads its row to see whether it was
 * cancelled — same interval `export.ts` polls at, for the same reason: a
 * cancel arriving mid-segment should not have to wait the whole segment out. */
const CANCEL_POLL_MS = 2000;

/** How long a title card is shown. Not configurable per template — one fixed
 * length keeps the pacing predictable, and there is nowhere in the schema yet
 * to store a per-template override. */
const TITLE_CARD_SECONDS = 3;

interface TemplatePlan {
  introKey: string | null;
  outroKey: string | null;
  logoKey: string | null;
  brandPrimaryHex: string | null;
  targetWidth: number;
  targetHeight: number;
  targetFps: number;
}

interface PendingRender {
  id: string;
  orgId: string;
  videoId: string;
  sourceStorageKey: string;
  template: TemplatePlan;
  steps: Array<{ start: number; end: number; title: string }>;
}

export async function runRenderJob(payload: RenderJobPayload): Promise<void> {
  const { job_id: jobId, org_id: orgId } = payload;

  const job = await withOrg(orgId, async (tx) => {
    const [row] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    // Gone or cancelled: the render was deleted (cascades from its video or
    // template), or `cancelJobsForRender` marked it while it sat in the
    // queue. Either way there is nothing to do.
    if (!row || row.state === "cancelled") return undefined;
    // Already finished — the queue delivers at least once, and re-running a
    // finished render would re-cut and re-upload for nothing.
    if (row.state === "done") return undefined;
    await tx.update(jobs).set({ state: "running", updatedAt: new Date() }).where(eq(jobs.id, jobId));
    return row;
  });
  if (!job?.renderId) return;

  const renderId = job.renderId;

  const claim = await claimRender(orgId, renderId);
  if (claim === "skip") return;

  try {
    const uploaded = await encodeAndUpload(claim);
    await finalize(orgId, renderId, undefined, uploaded);
  } catch (err) {
    await finalize(orgId, renderId, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Moves the row `queued` → `running` and returns what to cut and assemble.
 *
 * The claim is guarded by `AND status = 'queued'`, exactly as `export.ts`'s
 * `claimExport` is: without it, a cancel landing between the queue handing
 * this job over and the update committing would be silently undone —
 * `queued → cancelled → running` — and a cancelled render would run to
 * completion.
 */
async function claimRender(orgId: string, renderId: string): Promise<PendingRender | "skip"> {
  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .select({ status: renders.status, videoId: renders.videoId, templateId: renders.templateId })
      .from(renders)
      .where(eq(renders.id, renderId))
      .limit(1);
    if (!row || row.status !== "queued") return "skip";

    const [video] = await tx
      .select({ storageKey: videos.storageKey })
      .from(videos)
      .where(eq(videos.id, row.videoId))
      .limit(1);
    if (!video) return "skip";

    const [template] = await tx
      .select({
        introKey: templates.introKey,
        outroKey: templates.outroKey,
        logoKey: templates.logoKey,
        brandPrimaryHex: templates.brandPrimaryHex,
        targetWidth: templates.targetWidth,
        targetHeight: templates.targetHeight,
        targetFps: templates.targetFps,
      })
      .from(templates)
      .where(eq(templates.id, row.templateId))
      .limit(1);
    if (!template) return "skip";

    const stepRows = await tx
      .select({ start: renderSteps.start, end: renderSteps.end, title: renderSteps.title })
      .from(renderSteps)
      .where(eq(renderSteps.renderId, renderId))
      .orderBy(renderSteps.sortOrder);

    // The `status = 'queued'` half of this is the guard, not the read above:
    // under READ COMMITTED a cancel committing between that SELECT and this
    // UPDATE would otherwise be overwritten, and the render would run.
    const claimed = await tx
      .update(renders)
      .set({ status: "running" })
      .where(and(eq(renders.id, renderId), eq(renders.status, "queued")))
      .returning({ id: renders.id });
    if (claimed.length === 0) return "skip";

    return {
      id: renderId,
      orgId,
      videoId: row.videoId,
      sourceStorageKey: video.storageKey,
      template,
      steps: stepRows,
    };
  });
}

/**
 * Cuts, titles, and joins.
 *
 * Deviates from this slice's brief in one place, deliberately: an intro/outro
 * is a raw asset a user uploaded through the template's presigned-PUT flow
 * (arbitrary resolution, frame rate, codec) — not something `cutSegment`
 * already normalized the way every step's cut and every title card is. Concat
 * output list are `[introPath?, titleCard₁, cut₁, …, outroPath?]`, but
 * `concatVideos`'s `-c copy` needs *every* input to already match the
 * template's target dimensions/fps/codec, and an intro/outro is the one input
 * in that list this worker did not itself produce. So each is re-encoded
 * through the same `cutSegment` pass every step already gets — full duration,
 * `start = 0`, `end` = its own probed length — before joining, which is what
 * actually makes `concatVideos`'s "every input already matches" precondition
 * true rather than merely assumed.
 */
async function encodeAndUpload(job: PendingRender): Promise<{ sizeBytes: number; outputKey: string }> {
  if (job.steps.length === 0) {
    throw new Error("this render has no steps to cut");
  }

  const { targetWidth, targetHeight, targetFps } = job.template;
  const brandHex = job.template.brandPrimaryHex ?? "#000000";

  return withScratchDir(job.id, async (dir) => {
    const sourcePath = join(dir, "source");
    await storage.downloadToFile(job.sourceStorageKey, sourcePath);

    let logoPath: string | undefined;
    if (job.template.logoKey) {
      logoPath = join(dir, "logo");
      await storage.downloadToFile(job.template.logoKey, logoPath);
    }

    const introPath = job.template.introKey
      ? await downloadAndNormalizeAsset(job, job.template.introKey, join(dir, "intro-raw"), join(dir, "intro.mp4"))
      : undefined;
    const outroPath = job.template.outroKey
      ? await downloadAndNormalizeAsset(job, job.template.outroKey, join(dir, "outro-raw"), join(dir, "outro.mp4"))
      : undefined;

    const total = job.steps.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
    let elapsed = 0;
    const parts: string[] = [];
    if (introPath) parts.push(introPath);

    for (const [index, step] of job.steps.entries()) {
      await assertNotCancelled(job);

      const cardPath = join(dir, `title-${index}.mp4`);
      await watchForCancel(job, () =>
        renderTitleCard(
          step.title,
          brandHex,
          logoPath,
          targetWidth,
          targetHeight,
          targetFps,
          TITLE_CARD_SECONDS,
          cardPath,
        ),
      );
      parts.push(cardPath);

      await assertNotCancelled(job);

      const cutPath = join(dir, `cut-${index}.mp4`);
      const stepDuration = Math.max(0, step.end - step.start);
      // Weighted by duration rather than by step count, same reasoning as
      // `export.ts`'s copy: a render of one 20-minute step and one 5-second
      // one is not half done when the short one finishes. Title cards are
      // cheap next to a real cut and are left out of the weighting entirely.
      const base = elapsed;
      await watchForCancel(job, () =>
        cutSegment(sourcePath, step.start, step.end, cutPath, targetWidth, targetHeight, targetFps, (fraction) => {
          const overall = total > 0 ? (base + fraction * stepDuration) / total : fraction;
          void setProgress(job, overall);
        }),
      );
      parts.push(cutPath);
      elapsed += stepDuration;
    }

    if (outroPath) parts.push(outroPath);

    await assertNotCancelled(job);
    const outputPath = join(dir, "output.mp4");
    await watchForCancel(job, () => concatVideos(parts, outputPath, dir));

    await assertNotCancelled(job);
    const outputKey = storage.renderKey(job.orgId, job.videoId, job.id);
    await storage.uploadFile(outputKey, outputPath, "video/mp4");
    // The size of what was actually written, for the download surface. Taken
    // from the local file rather than a HEAD against storage: it is the same
    // number and it is already on disk.
    return { sizeBytes: (await stat(outputPath)).size, outputKey };
  });
}

/** Downloads a template asset and re-encodes it to the render's target
 * dimensions/fps — see `encodeAndUpload`'s header for why this exists. */
async function downloadAndNormalizeAsset(
  job: PendingRender,
  key: string,
  rawPath: string,
  normalizedPath: string,
): Promise<string> {
  await storage.downloadToFile(key, rawPath);
  const duration = await probeDuration(rawPath);
  await watchForCancel(job, () =>
    cutSegment(
      rawPath,
      0,
      duration,
      normalizedPath,
      job.template.targetWidth,
      job.template.targetHeight,
      job.template.targetFps,
      () => {},
    ),
  );
  return normalizedPath;
}

/**
 * Runs one ffmpeg invocation, killing it if the row turns `cancelled`.
 *
 * This is the cross-process half of cancellation: the API marks the row (it
 * has no handle on the process), and this is what acts on the mark. A killed
 * process rejects with a message that would read like a genuine failure,
 * which is why `finalize` re-reads the row rather than trusting the outcome.
 */
async function watchForCancel(job: PendingRender, start: () => FfmpegRun | Promise<FfmpegRun>): Promise<void> {
  // `cutSegment` is async (it probes for an audio stream before spawning —
  // see `ffmpeg.ts`), so a cancel landing during that brief probe isn't
  // caught until the poll below starts; negligible next to the 2s poll
  // interval itself.
  const run = await start();
  const poll = setInterval(() => {
    void isCancelled(job).then((cancelled) => {
      if (cancelled) run.kill();
    });
  }, CANCEL_POLL_MS);
  // Node keeps the process alive for a pending interval; this one should
  // never be the reason the worker will not shut down.
  poll.unref?.();

  try {
    await run.done;
  } finally {
    clearInterval(poll);
  }
}

async function assertNotCancelled(job: PendingRender): Promise<void> {
  if (await isCancelled(job)) throw new Error("render cancelled");
}

/** Defaults to "not cancelled" if the row cannot be read, so a transient
 * database blip never stops a render nobody cancelled. */
async function isCancelled(job: PendingRender): Promise<boolean> {
  try {
    const status = await withOrg(job.orgId, async (tx) => {
      const [row] = await tx.select({ status: renders.status }).from(renders).where(eq(renders.id, job.id)).limit(1);
      return row?.status;
    });
    return status === "cancelled";
  } catch {
    return false;
  }
}

/** Progress only moves while the row is still `running`, so a line arriving
 * from ffmpeg just before it is killed cannot resurrect a cancelled row. */
function setProgress(job: PendingRender, fraction: number): Promise<unknown> {
  return withOrg(job.orgId, (tx) =>
    tx
      .update(renders)
      .set({ progress: Math.min(1, Math.max(0, fraction)) })
      .where(eq(renders.id, job.id)),
  ).catch(() => undefined);
}

/**
 * Writes the final status — unless the row was cancelled while the encode was
 * unwinding, in which case that status is left alone and anything already
 * uploaded is removed. A cancelled render must not leave a downloadable
 * object behind, and it must not be reported as `failed` either: the kill is
 * the reason it stopped, and the user knows.
 *
 * Also moves the matching `jobs` row to its own terminal state — this task's
 * one addition over `export.ts`'s copy of this function, needed because this
 * task (unlike `runExportJob`) marked that row `running` itself; see this
 * file's header.
 */
async function finalize(
  orgId: string,
  renderId: string,
  error: string | undefined,
  uploaded?: { sizeBytes: number; outputKey: string },
): Promise<void> {
  const outcome = await withOrg(orgId, async (tx) => {
    const [row] = await tx
      .select({ status: renders.status, outputKey: renders.outputKey, callbackUrl: renders.callbackUrl })
      .from(renders)
      .where(eq(renders.id, renderId))
      .limit(1);
    if (!row) return undefined;

    if (row.status === "cancelled") {
      // `cancelJobsForRender` only ever matches `state = 'queued'` (see
      // `jobs/queue.ts`), because by the time a user cancels a render that is
      // actually encoding, this task has already moved that row to `running`
      // itself (this file's header — unlike `export.ts`'s copy, which never
      // advances its `jobs` row before `finalize`). Without this, a cancel of
      // an in-progress render would leave `jobs.state` stuck at `running`
      // forever, even though `renders.status` correctly reads `cancelled`.
      await tx
        .update(jobs)
        .set({ state: "cancelled", updatedAt: new Date() })
        .where(eq(jobs.renderId, renderId));
      return { cleanup: uploaded?.outputKey ?? row.outputKey ?? undefined };
    }

    await tx
      .update(renders)
      .set(
        error === undefined
          ? {
              status: "done",
              progress: 1,
              error: null,
              outputKey: uploaded?.outputKey ?? null,
              sizeBytes: uploaded?.sizeBytes ?? null,
            }
          : { status: "failed", error },
      )
      .where(eq(renders.id, renderId));
    await tx
      .update(jobs)
      .set({
        state: error === undefined ? "done" : "failed",
        error: error ?? null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.renderId, renderId));

    // Only `done`/`failed` get a webhook — not `cancelled` (handled above,
    // this branch never reaches it): a cancel is something the user did, not
    // an event about the render's processing, and they already know. Enqueued
    // on this same transaction, so the job only ever exists alongside the
    // terminal status it is about to report (`jobs/queue.ts`'s "the enqueue
    // is transactional").
    if (row.callbackUrl) await enqueueWebhookJob(tx, orgId, renderId);
    return undefined;
  });

  if (outcome?.cleanup) {
    // Best-effort, and post-commit: an object left behind here has no
    // retention sweep to catch it yet (Phase 6 territory), so this is the
    // only cleanup a cancelled-mid-upload render gets.
    await storage.deleteObject(outcome.cleanup).catch(() => undefined);
  }
}
