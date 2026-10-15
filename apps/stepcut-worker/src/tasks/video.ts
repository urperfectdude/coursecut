// The video-pipeline stages: extract → transcribe (Phase 2), analyze
// (Phase 3).
//
// Own copy of apps/worker/src/tasks/video.ts's `runExtract`/`runTranscribe`/
// `runAnalyze` — `runAnalyze` here calls `analyzeSteps` (its own prompt, see
// `apps/stepcut-api/src/openai.ts`'s header) rather than that file's
// `analyzeTranscript`, and writes `steps` rather than `lessons`.
//
// One graphile-worker task for all three stages, because they share
// everything except their middle: the same job-row bookkeeping, the same
// cancellation check, the same "record the failure where a future Retry can
// see it" ending. The `jobs` row says which stage this is.
//
// **The chain is the worker's, not the API's.** `POST /videos/:id/extract`
// just enqueues extraction and returns; a successful extract queues
// transcription itself, here, once its own job has committed.

import { withOrg, type Tx } from "../../../stepcut-api/src/db/client.js";
import { and, eq, isNotNull, ne } from "../../../stepcut-api/src/db/ops.js";
import { jobs, steps, transcriptSegments, videos, zoomRegions } from "../../../stepcut-api/src/db/schema.js";
import { replaceZoomSuggestions } from "../../../stepcut-api/src/domain/effects.js";
import * as storage from "../../../stepcut-api/src/storage.js";
import {
  analyzeSteps,
  dropLikelyHallucinations,
  transcribeAudio,
  type StepSuggestion,
  type TranscriptSegment,
} from "../../../stepcut-api/src/openai.js";
import { enqueueVideoJob } from "../../../stepcut-api/src/jobs/queue.js";
import { decodeGrayFrames, extractAudio, peakLevelDb, probeDuration } from "../ffmpeg.js";
import { ANALYSIS_FPS, ANALYSIS_HEIGHT, ANALYSIS_WIDTH, suggestZooms } from "../zoom-suggest.js";
import { makeReporter } from "../progress.js";
import { withScratchDir } from "../scratch.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface VideoJobPayload {
  job_id: string;
  org_id: string;
  /**
   * Set by a user-initiated re-transcribe. Bypasses the content-hash
   * transcript cache in `runTranscribe` — without it a re-transcribe of a
   * video whose bytes another row already carries would copy that row's
   * transcript straight back, which for the case the button exists to fix (a
   * transcript that came out wrong) means re-fixing nothing.
   */
  force?: boolean;
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
  const { job_id: jobId, org_id: orgId, force = false } = payload;

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
      await runTranscribe(orgId, videoId, jobId, force, report);
    } else if (job.kind === "analyze") {
      await runAnalyze(orgId, videoId, report);
    } else if (job.kind === "zooms") {
      await runSuggestZooms(orgId, videoId, jobId, report);
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
      // Only extract/transcribe own `transcriptStatus` — an `analyze` or
      // `zooms` failure has no transcript-side effect and must not stomp a video
      // that is genuinely `transcribed`, which is exactly what unconditionally
      // setting `error` here would do. The `jobs` row above is where an
      // `analyze` failure actually surfaces (`GET /videos/:id/jobs`).
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
 * Peak level, in dBFS, below which the extracted audio is treated as holding
 * no speech at all.
 *
 * Generous on purpose. Quiet narration — a distant laptop microphone, a
 * soft-spoken narrator — still peaks far above this; a track that never once
 * crosses it captured nothing. The case this exists for is a screen
 * recording made with the microphone muted or the wrong input device
 * selected, which produces audio at around -91 dBFS (ffmpeg's floor for
 * digital silence) and is otherwise indistinguishable to the pipeline from a
 * recording with narration.
 */
const SILENCE_PEAK_DBFS = -60;

/**
 * Transcribes the extracted audio, or copies a sibling's transcript. Only
 * the audio ever leaves this process — never the source video.
 *
 * Two guards stand between Whisper's output and the `transcript_segments`
 * rows every later stage trusts, both for the same reason: Whisper does not
 * report silence as silence, it fills it with generic stock phrases and
 * returns them as an ordinary transcript, so "it came back with segments" is
 * not evidence that anything was said.
 *
 *  1. Silent audio never reaches Whisper at all (`SILENCE_PEAK_DBFS`) — the
 *     failure is reported as what it is, which is also one fewer API call
 *     billed for a recording that cannot produce a transcript.
 *  2. What does come back is filtered for repeated stock phrases
 *     (`dropLikelyHallucinations`), which catches the partial case the first
 *     guard cannot see: a recording that is genuinely narrated but has long
 *     wordless stretches inside it.
 */
async function runTranscribe(
  orgId: string,
  videoId: string,
  jobId: string,
  force: boolean,
  report: ReturnType<typeof makeReporter>,
): Promise<void> {
  const video = await withOrg(orgId, async (tx) => {
    const [row] = await tx.select().from(videos).where(eq(videos.id, videoId)).limit(1);
    if (!row) throw new Error(`video ${videoId} does not exist`);
    return row;
  });
  if (!video.audioKey) throw new Error("audio not extracted yet for this video");

  const cached =
    !force && video.contentHash
      ? await findCachedTranscript(orgId, video.contentHash, videoId)
      : [];

  let segments: TranscriptSegment[];
  if (cached.length > 0) {
    segments = cached;
  } else {
    report(null, "Transcribing audio");
    const audio = await storage.getObjectBytes(video.audioKey);
    const ext = storage.audioKeyExt(video.audioKey);

    // Guard 1. The audio is already in memory, but `volumedetect` needs a
    // file, and this one is small — 24 kbps Opus, a few MB for a long
    // recording — so the write costs far less than the Whisper call it can
    // save.
    await withScratchDir(jobId, async (dir) => {
      const audioPath = join(dir, `audio.${ext}`);
      await writeFile(audioPath, audio);
      const peak = await peakLevelDb(audioPath);
      if (peak < SILENCE_PEAK_DBFS) {
        throw new Error(
          "this recording's audio is silent — there is no narration to transcribe. " +
            "Check that the right microphone was selected, and that it was not muted, " +
            "when the screen was recorded.",
        );
      }
    });

    segments = await transcribeAudio(audio, `audio.${ext}`, (fraction, detail) =>
      report(fraction, detail),
    );

    // Guard 2. Only ever applied to a fresh transcription — a cached sibling
    // transcript was already filtered when it was first written, and running
    // it again would re-count phrases that survived that pass on purpose.
    const kept = dropLikelyHallucinations(segments);
    if (kept.length === 0 && segments.length > 0) {
      throw new Error(
        "this recording produced no usable transcript — every segment Whisper returned was " +
          "a repeated stock phrase, which is what it returns for audio with no speech in it.",
      );
    }
    segments = kept;
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

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------

const newStepId = () => crypto.randomUUID();

/**
 * Sends the transcript **text** to GPT-5.5 (`analyzeSteps` — its own prompt,
 * see `apps/stepcut-api/src/openai.ts`'s header) and replaces the video's
 * AI-sourced steps with what comes back.
 *
 * Only `source = 'ai'` rows are cleared — a step a human has built or edited
 * by hand (Phase 4) survives a re-analysis, the same `lessons.source` rule
 * `apps/worker`'s `runAnalyze` already relies on. Unlike that reference,
 * there is no dead-air trimming here: `transcript_segments` has no `keep`
 * column in this schema (see `schema.ts`'s header), so every stored segment
 * is sent as-is.
 */
async function runAnalyze(
  orgId: string,
  videoId: string,
  report: ReturnType<typeof makeReporter>,
): Promise<void> {
  report(null, "Finding steps");

  const [video, segments] = await Promise.all([
    withOrg(orgId, async (tx) => {
      const [row] = await tx.select({ duration: videos.duration }).from(videos).where(eq(videos.id, videoId)).limit(1);
      if (!row) throw new Error(`video ${videoId} does not exist`);
      return row;
    }),
    withOrg(orgId, (tx) =>
      tx
        .select({
          start: transcriptSegments.start,
          end: transcriptSegments.end,
          text: transcriptSegments.text,
        })
        .from(transcriptSegments)
        .where(eq(transcriptSegments.videoId, videoId))
        .orderBy(transcriptSegments.start, transcriptSegments.id),
    ),
  ]);

  if (segments.length === 0) {
    throw new Error("This video has no transcript yet — transcribe it before analyzing.");
  }

  // Falls back to the transcript's own last timestamp only if `extract`
  // somehow never recorded a duration — `analyzeSteps` already treats that
  // as "nothing past the transcript to reach for."
  const videoDuration = video.duration ?? Math.max(...segments.map((segment) => segment.end));

  const suggestions = await analyzeSteps(segments, videoDuration);
  // Sorted by start, because `sort_order` is assigned by this order.
  suggestions.sort((a, b) => a.start - b.start);

  // Deterministic safety net: the transcript only covers speech, so GPT-5.5
  // can only ever *see* as far as the narrator's last word even though the
  // prompt now asks it to reach past that — this is what actually guarantees
  // the rendered video isn't cut off before the recording's real end,
  // regardless of whether the model followed that instruction.
  const lastStep = suggestions[suggestions.length - 1];
  if (lastStep && videoDuration > lastStep.end) {
    lastStep.end = videoDuration;
  }

  await withOrg(orgId, (tx) => replaceAiSteps(tx, orgId, videoId, suggestions));
}

/**
 * Deletes the video's `source = 'ai'` steps and inserts the fresh ones.
 *
 * Own copy of apps/worker's `replaceAiLessons`, simplified for a step's
 * single range: no bounds to compute across a segment list, since a step
 * *is* its own `start`/`end`.
 */
async function replaceAiSteps(
  tx: Tx,
  orgId: string,
  videoId: string,
  suggestions: StepSuggestion[],
): Promise<void> {
  await tx.delete(steps).where(and(eq(steps.videoId, videoId), eq(steps.source, "ai")));

  if (suggestions.length === 0) return;
  await tx.insert(steps).values(
    suggestions.map((suggestion, index) => ({
      id: newStepId(),
      orgId,
      videoId,
      sortOrder: index,
      start: suggestion.start,
      end: suggestion.end,
      title: suggestion.title,
      summary: suggestion.summary,
      confidence: suggestion.confidence,
      source: "ai",
    })),
  );
}

// ---------------------------------------------------------------------------
// Zoom suggestions
// ---------------------------------------------------------------------------

/**
 * Scans the recording for localized on-screen change and replaces the video's
 * pending zoom suggestions (`zoom-suggest.ts`). Frames are decoded on this
 * worker and never leave it — no OpenAI call is involved.
 *
 * Writes through `domain/effects.ts`'s `replaceZoomSuggestions` rather than
 * inserting directly, unlike this file's other stages: it re-checks accepted
 * regions inside the write transaction, so a zoom someone placed by hand
 * while this scan ran still wins.
 */
async function runSuggestZooms(
  orgId: string,
  videoId: string,
  jobId: string,
  report: ReturnType<typeof makeReporter>,
): Promise<void> {
  const video = await withOrg(orgId, async (tx) => {
    const [row] = await tx.select().from(videos).where(eq(videos.id, videoId)).limit(1);
    if (!row) throw new Error(`video ${videoId} does not exist`);
    if (row.uploadStatus !== "uploaded") throw new Error("this video has not finished uploading yet");
    return row;
  });

  await withScratchDir(jobId, async (dir) => {
    report(null, "Downloading recording");
    const sourcePath = join(dir, "source");
    await storage.downloadToFile(video.storageKey, sourcePath);
    const duration = video.duration ?? (await probeDuration(sourcePath));

    const occupied = await withOrg(orgId, (tx) =>
      tx
        .select({ start: zoomRegions.start, end: zoomRegions.end })
        .from(zoomRegions)
        .where(and(eq(zoomRegions.videoId, videoId), eq(zoomRegions.source, "manual"))),
    );

    const expectedFrames = Math.max(1, Math.ceil(duration * ANALYSIS_FPS));
    let seen = 0;
    async function* counted(): AsyncGenerator<Uint8Array> {
      for await (const frame of decodeGrayFrames(sourcePath, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, ANALYSIS_FPS)) {
        seen++;
        report(Math.min(1, seen / expectedFrames), "Finding zoom moments");
        yield frame;
      }
    }

    const suggestions = await suggestZooms(counted(), {
      width: ANALYSIS_WIDTH,
      height: ANALYSIS_HEIGHT,
      fps: ANALYSIS_FPS,
      duration,
      occupied,
    });

    await withOrg(orgId, (tx) => replaceZoomSuggestions(tx, orgId, videoId, suggestions));
  });
}
