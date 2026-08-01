// The three video-pipeline stages: extract → transcribe → analyze.
//
// One graphile-worker task for all three, because they share everything except
// their middle: the same job-row bookkeeping, the same cancellation check, the
// same "record the failure where the UI's Retry button can see it" ending. The
// `jobs` row says which stage this is.
//
// **The chain is the worker's, not the view's.** Desktop's `ProjectDetailView`
// chains extraction into transcription on `audio_path` coming back set; against
// a job queue that branch never fires, because the call returns before anything
// has run (plan D3, and M3's note). So a successful extract queues the
// transcription itself. The copied view is left alone — editing it for a
// web-only reason is what plan §7.1 forbids.
//
// Analysis is deliberately *not* chained. Desktop has the user press Analyze
// after reviewing the transcript, and that is a product decision (they trim
// dead air first), not a mechanical consequence of running inline.

import { and, eq, isNotNull, ne } from "../../../api/src/db/ops.js";
import { withOrg, type Tx } from "../../../api/src/db/client.js";
import {
  jobs,
  lessonSegments,
  lessons,
  orgSettings,
  transcriptSegments,
  videos,
} from "../../../api/src/db/schema.js";
import { newId } from "../../../api/src/domain/lessons.js";
import * as storage from "../../../api/src/storage.js";
import {
  analyzeTranscript,
  silenceGaps,
  transcribeAudio,
  trimSilenceFromSuggestions,
  SILENCE_GAP_THRESHOLD_SECS,
  type LessonSuggestion,
  type TranscriptSegment,
} from "../../../api/src/openai.js";
import { enqueueVideoJob } from "../../../api/src/jobs/queue.js";
import {
  assertCanTranscribe,
  recordUsage,
  TRANSCRIPTION_SECONDS,
} from "../../../api/src/quota.js";
import { extractAudio, probeDuration } from "../ffmpeg.js";
import { makeReporter, type Stage } from "../progress.js";
import { withScratchDir } from "../scratch.js";
import { join } from "node:path";

export interface VideoJobPayload {
  job_id: string;
  org_id: string;
}

const STAGE: Record<string, Stage> = {
  extract: "ExtractingAudio",
  transcribe: "Transcribing",
  analyze: "Analyzing",
};

/**
 * Runs one pipeline job.
 *
 * Failures are caught, not thrown: a job that fails for a real reason —
 * unreadable video, a Whisper refusal — records itself as `failed`, marks the
 * video `error` so the row grows a Retry button exactly as on desktop, and
 * returns normally. Throwing would hand it to the queue's retry logic, which
 * would re-run a 40-minute transcode against a file that is still unreadable.
 * Only the genuinely unexpected (the database going away mid-job) escapes, and
 * that is what the queue's three attempts are for.
 */
export async function runVideoJob(payload: VideoJobPayload): Promise<void> {
  const { job_id: jobId, org_id: orgId } = payload;

  const job = await withOrg(orgId, async (tx) => {
    const [row] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    // Gone or cancelled: the video was deleted, or `cancelJobsForVideo` marked
    // it while it sat in the queue. Either way there is nothing to do, and
    // nowhere to report it to.
    if (!row || row.state === "cancelled") return undefined;
    // Already finished. A queue delivers at least once, and the duplicate of a
    // transcription is a second Whisper bill for a transcript we already have.
    if (row.state === "done") return undefined;
    await tx
      .update(jobs)
      .set({ state: "running", updatedAt: new Date() })
      .where(eq(jobs.id, jobId));
    return row;
  });
  if (!job?.videoId) return;

  const videoId = job.videoId;
  const report = makeReporter({
    jobId,
    orgId,
    videoId,
    attempt: job.attempt,
    stage: STAGE[job.kind] ?? "ExtractingAudio",
  });

  try {
    if (job.kind === "extract") {
      await runExtract(orgId, videoId, jobId, job.attempt, report);
    } else if (job.kind === "transcribe") {
      await runTranscribe(orgId, videoId, report);
    } else if (job.kind === "analyze") {
      await runAnalyze(orgId, videoId, report);
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
    // Plan §9: an error message can quote a model response, so it goes to the
    // row the user is looking at, and only ids reach the log.
    console.error(`[worker] ${job.kind} job ${jobId} failed`);
    await withOrg(orgId, async (tx) => {
      await tx
        .update(jobs)
        .set({ state: "failed", error: message, updatedAt: new Date() })
        .where(eq(jobs.id, jobId));
      // Desktop's `mark_error`, and the reason a failed video can be retried:
      // `ProjectDetailView` renders Retry off `transcript_status === "error"`.
      //
      // Only for the two stages desktop marks. A failed *analysis* leaves the
      // status alone there, and must here too: `error` is in the view's
      // `PRE_TRANSCRIPT_STATUSES`, so writing it after a good transcription
      // would make the transcript unreachable because the lesson analysis
      // failed — losing more than the step that broke.
      if (job.kind === "extract" || job.kind === "transcribe") {
        await tx
          .update(videos)
          .set({ transcriptStatus: "error", updatedAt: new Date() })
          .where(eq(videos.id, videoId));
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

/**
 * Probes duration and produces mono 16 kHz audio, then queues transcription.
 *
 * The cache (PRD §7.4) survives the move to object storage with one change.
 * Desktop keys a shared on-disk WAV by content hash and lets many rows point at
 * it; here a sibling's audio object is **copied** to this video's own prefix
 * instead, because an object shared between two rows would outlive the delete
 * that plan §9 promises purges a video. A server-side copy costs no download,
 * no upload and no ffmpeg — the expensive part is still skipped.
 *
 * The hash comes free: the source has to be downloaded for ffmpeg anyway, and
 * `downloadToFile` digests the stream on its way past.
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
    // A sibling extracted before the move to Opus still has a `.wav` object;
    // the copy has to keep that extension so the key never disagrees with the
    // bytes under it. Fresh extractions are Opus.
    const ext = cached ? storage.audioKeyExt(cached.audioKey) : "ogg";
    const audioKey = storage.audioKey(orgId, video.projectId, videoId, ext);

    let duration: number;
    if (cached) {
      // A sibling in this org already has audio for these exact bytes.
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

  // The chain (see this file's header). Queued in its own transaction, after
  // the extract has committed, so a transcription job never starts against a
  // row whose `audio_key` is not there yet.
  await withOrg(orgId, (tx) => enqueueVideoJob(tx, orgId, "transcribe", videoId, attempt));
}

/** Another video in this org whose audio was already extracted from these
 * exact bytes. RLS confines the lookup to this tenant; the index makes it a
 * range scan. */
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
        and(
          eq(videos.contentHash, contentHash),
          ne(videos.id, excludeVideoId),
          isNotNull(videos.audioKey),
        ),
      )
      .limit(1);
    return hit?.audioKey ? { audioKey: hit.audioKey, duration: hit.duration } : undefined;
  });
}

// ---------------------------------------------------------------------------
// Transcribe
// ---------------------------------------------------------------------------

/**
 * Transcribes the extracted audio, or copies a sibling's transcript.
 *
 * Only the audio ever leaves — never the source video (plan §9). The cache
 * check is the same one desktop runs, scoped to this org by RLS: a shared
 * cache would tell one tenant that another holds the same recording, which
 * plan §6 calls out as a security requirement rather than an optimization
 * detail.
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

  const cached = video.contentHash
    ? await findCachedTranscript(orgId, video.contentHash, videoId)
    : [];

  let segments: TranscriptSegment[];
  if (cached.length > 0) {
    // A cache hit costs nothing, so it meters nothing (M7). Recording it would
    // charge a tenant twice for one transcription, which is both wrong and the
    // opposite of the incentive the cache exists to create.
    segments = cached;
  } else {
    // The quota was checked when this job was queued, which may have been
    // hours and several jobs ago — this is the check that is actually adjacent
    // to the spend. Refusing here throws, so the job records itself as failed
    // with this message and `ProjectDetailView` grows its usual Retry button.
    await withOrg(orgId, (tx) => assertCanTranscribe(tx, orgId));

    report(null, "Transcribing audio");
    const audio = await storage.getObjectBytes(video.audioKey);
    // The stored key's own extension, so a legacy `.wav` object is announced
    // to Whisper as one and today's Opus as one.
    segments = await transcribeAudio(
      audio,
      `audio.${storage.audioKeyExt(video.audioKey)}`,
      (fraction, detail) => report(fraction, detail),
    );

    // Metered after the fact and from the transcript rather than from
    // `videos.duration`: it is what Whisper was actually given, it is a number
    // we hold whether or not the probe ran, and a job that died mid-call bills
    // nothing (see `recordUsage`'s note on reservations).
    const seconds = segments.length > 0 ? Math.max(...segments.map((s) => s.end)) : 0;
    await withOrg(orgId, (tx) =>
      recordUsage(tx, orgId, TRANSCRIPTION_SECONDS, seconds, { videoId }),
    );
  }

  // One transaction, so a re-run replaces cleanly instead of accumulating
  // alongside whatever the previous attempt left — desktop's rule exactly.
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
          keep: true,
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

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------

/**
 * Sends the kept transcript **text** to GPT-5.5 and replaces the video's
 * AI-sourced lessons with what comes back.
 *
 * Ported whole from `analyze_video`, including the two things that are easy to
 * lose: only `source = 'ai'` rows are cleared (a lesson the user built by hand
 * survives re-analysis), and boundaries are trimmed against dead air computed
 * from the same segments the model saw, before anything is written — so the
 * trim shows up in the segment list rather than being a silent adjustment.
 */
async function runAnalyze(
  orgId: string,
  videoId: string,
  report: ReturnType<typeof makeReporter>,
): Promise<void> {
  report(null, "Finding lesson boundaries");

  const { segments, instructions } = await withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({
        start: transcriptSegments.start,
        end: transcriptSegments.end,
        text: transcriptSegments.text,
      })
      .from(transcriptSegments)
      .where(and(eq(transcriptSegments.videoId, videoId), eq(transcriptSegments.keep, true)))
      .orderBy(transcriptSegments.start, transcriptSegments.id);

    const [settings] = await tx
      .select({ instructions: orgSettings.analysisInstructions })
      .from(orgSettings)
      .where(eq(orgSettings.orgId, orgId))
      .limit(1);

    return { segments: rows, instructions: settings?.instructions ?? null };
  });

  if (segments.length === 0) {
    throw new Error("This video has no transcript yet — transcribe it before analyzing.");
  }

  const suggestions = trimSilenceFromSuggestions(
    await analyzeTranscript(segments, instructions),
    silenceGaps(segments, SILENCE_GAP_THRESHOLD_SECS),
  );

  // Sorted by earliest segment, because `sort_order` is assigned by this order.
  suggestions.sort((a, b) => minStart(a) - minStart(b));

  await withOrg(orgId, (tx) => replaceAiLessons(tx, orgId, videoId, suggestions));
}

function minStart(suggestion: LessonSuggestion): number {
  return Math.min(...suggestion.segments.map(([start]) => start));
}

/**
 * Deletes the video's `source = 'ai'` lessons and inserts the fresh ones, one
 * `lesson_segments` row per range.
 *
 * Bounds are computed here rather than through `recomputeLessonBounds`: this is
 * an insert-only path (the lesson does not exist yet, so there is nothing to
 * recompute from), which is the same shortcut desktop's `replace_ai_lessons_tx`
 * takes and for the same reason.
 */
async function replaceAiLessons(
  tx: Tx,
  orgId: string,
  videoId: string,
  suggestions: LessonSuggestion[],
): Promise<void> {
  await tx.delete(lessons).where(and(eq(lessons.videoId, videoId), eq(lessons.source, "ai")));

  for (const [index, suggestion] of suggestions.entries()) {
    const segments = [...suggestion.segments].sort((a, b) => a[0] - b[0]);
    const lessonId = newId();

    await tx.insert(lessons).values({
      id: lessonId,
      orgId,
      videoId,
      title: suggestion.title,
      summary: suggestion.summary,
      start: Math.min(...segments.map(([start]) => start)),
      end: Math.max(...segments.map(([, end]) => end)),
      sortOrder: index,
      confidence: suggestion.confidence,
      kind: suggestion.kind,
      source: "ai",
    });

    await tx.insert(lessonSegments).values(
      segments.map(([start, end], segmentIndex) => ({
        id: newId(),
        orgId,
        lessonId,
        start,
        end,
        sortOrder: segmentIndex,
      })),
    );
  }
}
