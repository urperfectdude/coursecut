// The two video-pipeline stages Phase 2 has: extract → transcribe.
//
// Own copy of apps/worker/src/tasks/video.ts's `runExtract`/`runTranscribe`
// halves — `runAnalyze` doesn't exist here, because `analyze` (and the
// `steps` table it writes) is Phase 3.
//
// One graphile-worker task for both stages, because they share everything
// except their middle: the same job-row bookkeeping, the same cancellation
// check, the same "record the failure where a future Retry can see it"
// ending. The `jobs` row says which stage this is.
//
// **The chain is the worker's, not the API's.** `POST /videos/:id/extract`
// just enqueues extraction and returns; a successful extract queues
// transcription itself, here, once its own job has committed.

import { withOrg } from "../../../stepcut-api/src/db/client.js";
import { and, eq, isNotNull, ne } from "../../../stepcut-api/src/db/ops.js";
import { jobs, transcriptSegments, videos } from "../../../stepcut-api/src/db/schema.js";
import * as storage from "../../../stepcut-api/src/storage.js";
import { transcribeAudio, type TranscriptSegment } from "../../../stepcut-api/src/openai.js";
import { enqueueVideoJob } from "../../../stepcut-api/src/jobs/queue.js";
import { extractAudio, probeDuration } from "../ffmpeg.js";
import { makeReporter } from "../progress.js";
import { withScratchDir } from "../scratch.js";
import { join } from "node:path";

export interface VideoJobPayload {
  job_id: string;
  org_id: string;
}

const newId = () => crypto.randomUUID();

/**
 * Runs one pipeline job.
 *
 * Failures are caught, not thrown: a job that fails for a real reason —
 * unreadable video, a Whisper refusal — records itself as `failed`, marks the
 * video `error` so a future Retry button has something to act on, and
 * returns normally. Throwing would hand it to the queue's retry logic, which
 * would re-run a long transcode against a file that is still unreadable.
 * Only the genuinely unexpected (the database going away mid-job) escapes,
 * and that is what the queue's three attempts are for.
 */
export async function runVideoJob(payload: VideoJobPayload): Promise<void> {
  const { job_id: jobId, org_id: orgId } = payload;

  const job = await withOrg(orgId, async (tx) => {
    const [row] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    // Gone or cancelled: the video was deleted, or `cancelJobsForVideo`
    // marked it while it sat in the queue. Either way there is nothing to do.
    if (!row || row.state === "cancelled") return undefined;
    // Already finished. A queue delivers at least once, and the duplicate of
    // a transcription is a second Whisper bill for a transcript we already
    // have.
    if (row.state === "done") return undefined;
    await tx.update(jobs).set({ state: "running", updatedAt: new Date() }).where(eq(jobs.id, jobId));
    return row;
  });
  if (!job?.videoId) return;

  const videoId = job.videoId;
  const report = makeReporter({ jobId, orgId });

  try {
    if (job.kind === "extract") {
      await runExtract(orgId, videoId, jobId, job.attempt, report);
    } else if (job.kind === "transcribe") {
      await runTranscribe(orgId, videoId, report);
    } else {
      throw new Error(`unknown video job kind ${job.kind}`);
    }

    await withOrg(orgId, (tx) =>
      tx
        .update(jobs)
        .set({ state: "done", progress: 1, detail: null, updatedAt: new Date() })
        .where(eq(jobs.id, jobId)),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[stepcut-worker] ${job.kind} job ${jobId} failed`);
    await withOrg(orgId, async (tx) => {
      await tx
        .update(jobs)
        .set({ state: "failed", error: message, updatedAt: new Date() })
        .where(eq(jobs.id, jobId));
      await tx
        .update(videos)
        .set({ transcriptStatus: "error", updatedAt: new Date() })
        .where(eq(videos.id, videoId));
    });
  }
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

/**
 * Probes duration and produces mono 16 kHz audio, then queues transcription.
 *
 * The content-hash cache: a sibling video's already-extracted audio object is
 * **copied** to this video's own prefix instead of shared, because an object
 * shared between two rows would outlive a delete that is supposed to purge a
 * video. A server-side copy costs no download, no upload and no ffmpeg — the
 * expensive part is still skipped.
 */
async function runExtract(
  orgId: string,
  videoId: string,
  jobId: string,
  attempt: number,
  report: ReturnType<typeof makeReporter>,
): Promise<void> {
  const video = await withOrg(orgId, async (tx) => {
    const [row] = await tx.select().from(videos).where(eq(videos.id, videoId)).limit(1);
    if (!row) throw new Error(`video ${videoId} does not exist`);
    if (row.uploadStatus !== "uploaded") throw new Error("this video has not finished uploading yet");
    return row;
  });

  report(null, "Extracting audio");

  await withScratchDir(jobId, async (dir) => {
    const sourcePath = join(dir, "source");
    const { sha256 } = await storage.downloadToFile(video.storageKey, sourcePath);

    const cached = await findCachedAudio(orgId, sha256, videoId);
    // A sibling extracted before a hypothetical future change of encoding
    // could have kept a different extension; the copy has to keep it so the
    // key never disagrees with the bytes under it.
    const ext = cached ? storage.audioKeyExt(cached.audioKey) : "ogg";
    const audioKey = storage.audioKey(orgId, videoId, ext);

    let duration: number;
    if (cached) {
      await storage.copyObject(cached.audioKey, audioKey);
      duration = cached.duration ?? (await probeDuration(sourcePath));
    } else {
      duration = await probeDuration(sourcePath);
      const audioPath = join(dir, `audio.${ext}`);
      await extractAudio(sourcePath, audioPath);
      await storage.uploadFile(audioKey, audioPath, "audio/ogg");
    }

    await withOrg(orgId, (tx) =>
      tx
        .update(videos)
        .set({
          duration,
          contentHash: sha256,
          audioKey,
          transcriptStatus: "audio_ready",
          updatedAt: new Date(),
        })
        .where(eq(videos.id, videoId)),
    );
  });

  // The chain. Queued in its own transaction, after the extract has
  // committed, so a transcription job never starts against a row whose
  // `audio_key` is not there yet.
  await withOrg(orgId, (tx) => enqueueVideoJob(tx, orgId, "transcribe", videoId, attempt));
}

/** Another video in this org whose audio was already extracted from these
 * exact bytes. RLS confines the lookup to this tenant. */
async function findCachedAudio(
  orgId: string,
  contentHash: string,
  excludeVideoId: string,
): Promise<{ audioKey: string; duration: number | null } | undefined> {
  return withOrg(orgId, async (tx) => {
    const [hit] = await tx
      .select({ audioKey: videos.audioKey, duration: videos.duration })
      .from(videos)
      .where(
        and(eq(videos.contentHash, contentHash), ne(videos.id, excludeVideoId), isNotNull(videos.audioKey)),
      )
      .limit(1);
    return hit?.audioKey ? { audioKey: hit.audioKey, duration: hit.duration } : undefined;
  });
}

// ---------------------------------------------------------------------------
// Transcribe
// ---------------------------------------------------------------------------

/**
 * Transcribes the extracted audio, or copies a sibling's transcript. Only
 * the audio ever leaves this process — never the source video.
 */
async function runTranscribe(
  orgId: string,
  videoId: string,
  report: ReturnType<typeof makeReporter>,
): Promise<void> {
  const video = await withOrg(orgId, async (tx) => {
    const [row] = await tx.select().from(videos).where(eq(videos.id, videoId)).limit(1);
    if (!row) throw new Error(`video ${videoId} does not exist`);
    return row;
  });
  if (!video.audioKey) throw new Error("audio not extracted yet for this video");

  const cached = video.contentHash ? await findCachedTranscript(orgId, video.contentHash, videoId) : [];

  let segments: TranscriptSegment[];
  if (cached.length > 0) {
    segments = cached;
  } else {
    report(null, "Transcribing audio");
    const audio = await storage.getObjectBytes(video.audioKey);
    segments = await transcribeAudio(
      audio,
      `audio.${storage.audioKeyExt(video.audioKey)}`,
      (fraction, detail) => report(fraction, detail),
    );
  }

  // One transaction, so a re-run replaces cleanly instead of accumulating
  // alongside whatever the previous attempt left.
  await withOrg(orgId, async (tx) => {
    await tx.delete(transcriptSegments).where(eq(transcriptSegments.videoId, videoId));
    if (segments.length > 0) {
      await tx.insert(transcriptSegments).values(
        segments.map((segment) => ({
          id: newId(),
          orgId,
          videoId,
          start: segment.start,
          end: segment.end,
          text: segment.text,
        })),
      );
    }
    await tx
      .update(videos)
      .set({ transcriptStatus: "transcribed", updatedAt: new Date() })
      .where(eq(videos.id, videoId));
  });
}

/** A finished transcript for the same bytes, in this org. */
function findCachedTranscript(
  orgId: string,
  contentHash: string,
  excludeVideoId: string,
): Promise<TranscriptSegment[]> {
  return withOrg(orgId, async (tx) => {
    const [source] = await tx
      .select({ id: videos.id })
      .from(videos)
      .where(
        and(
          eq(videos.contentHash, contentHash),
          ne(videos.id, excludeVideoId),
          eq(videos.transcriptStatus, "transcribed"),
        ),
      )
      .limit(1);
    if (!source) return [];

    return tx
      .select({
        start: transcriptSegments.start,
        end: transcriptSegments.end,
        text: transcriptSegments.text,
      })
      .from(transcriptSegments)
      .where(eq(transcriptSegments.videoId, source.id))
      .orderBy(transcriptSegments.start, transcriptSegments.id);
  });
}
