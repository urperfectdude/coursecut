// Whisper transcription — the transcription-only slice of apps/api's
// src/openai.ts (`src-tauri/src/openai.rs`'s Whisper half, by way of that
// port).
//
// StepCut has no GPT-5.5 lesson-analysis call to reimplement here, and that
// is deliberate rather than a Phase 2 gap: `analyze` arrives in Phase 3 with
// its **own** prompt, tuned for "steps in a task" from day one — plan §9 is
// explicit that it must never share or fork coursecut's lesson-boundary
// prompt, because the freedom to iterate on that prompt without touching the
// shipped lesson product is the entire reason this backend is separate. So
// this file only ever grows the pieces `extract`/`transcribe` need; the
// analysis half belongs in a file that does not exist yet.
//
// **Privacy**, unchanged from the coursecut original: only the **extracted
// audio** goes to Whisper. This module has no filesystem and no S3 access at
// all — it takes audio as bytes a caller already extracted. Nothing else
// about a tenant (ids, names, keys) is ever sent.
//
// **The key is the platform's.** One `OPENAI_API_KEY` in the server's
// environment, used for every tenant, never in the database and never sent
// to the browser — no per-org key to look up, so no function here takes one.

import { env } from "./env.js";
import { splitIntoChunks } from "./wav.js";

/** A transcript segment as Whisper returns it — seconds from the audio's start. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Whisper's documented upload cap is 25 MB. Kept comfortably under it (a ~1 MB
 * margin) so multipart header overhead never pushes a "just under" file over.
 */
const SAFE_UPLOAD_BYTES = 24_000_000;

/**
 * Target size per chunk when splitting a legacy oversized WAV (see
 * `transcribeAudio`). At the mono/16 kHz/16-bit PCM `extractAudio` used to
 * produce (32 KB/s) this is exactly 10 minutes (~18.3 MB) — under
 * `SAFE_UPLOAD_BYTES` even after the silence-seeking boundary picker nudges a
 * cut a few tens of seconds either way.
 */
const CHUNK_TARGET_BYTES = 19_200_000;

/** Whisper can sit on a long upload; the coursecut original allows the same
 * 10 minutes. */
const TRANSCRIBE_TIMEOUT_MS = 600_000;

const TRANSCRIPTION_MODEL = "whisper-1";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${env.openAiApiKey()}` };
}

/**
 * `fetch` with a deadline, and with the response body kept out of the error.
 *
 * A failed OpenAI call's body can echo back part of what was sent, so the
 * snippet that reaches the caller is capped at 300 characters and goes into
 * the error message a user sees, not into a log line.
 */
async function callOpenAi(path: string, init: RequestInit, timeoutMs: number, label: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${env.openAiBaseUrl()}${path}`, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`${label} request timed out`);
    throw new Error(`${label} request failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${label} returned ${response.status}: ${body.slice(0, 300)}`);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Whisper
// ---------------------------------------------------------------------------

/**
 * Transcribes `audioBytes` — mono 16 kHz Opus, as `extractAudio` produces.
 *
 * The 25 MB cap applies to every model OpenAI offers, so the way under it is
 * the encoding: at 24 kbps Opus (~3 KB/s) two hours of lecture fit in one
 * request, and the chunking below does not run.
 *
 * It still runs for audio stored as raw PCM WAV before that change (32 KB/s —
 * the cap at ~13 minutes), which the `RIFF` check selects on: `wav.ts` splits
 * it into sub-cap chunks at natural pauses, each uploaded sequentially, with
 * every returned timestamp offset back onto the full recording's timeline
 * (`mergeChunkSegments`). An oversized *Opus* file means a recording past
 * ~2 hours, which `wav.ts` cannot split, and gets a clear error instead of a
 * parse failure. Either way only the extracted audio leaves this process —
 * never the source video.
 *
 * `onProgress` reports chunk N of M so a progress bar means something during
 * a 40-minute lecture; a single-request upload reports indeterminate.
 */
export async function transcribeAudio(
  audioBytes: Uint8Array<ArrayBuffer>,
  fileName: string,
  onProgress: (fraction: number | null, detail: string | null) => void,
): Promise<TranscriptSegment[]> {
  if (audioBytes.byteLength <= SAFE_UPLOAD_BYTES) {
    onProgress(null, null);
    return uploadChunk(audioBytes, fileName, mimeFor(fileName));
  }

  if (!isRiff(audioBytes)) {
    throw new Error(
      "this recording is too long to transcribe in one upload (over ~2 hours of audio)",
    );
  }

  const chunks = splitIntoChunks(audioBytes, CHUNK_TARGET_BYTES);
  const total = chunks.length;
  onProgress(null, null);

  const results: Array<[TranscriptSegment[], number]> = [];
  for (const [index, chunk] of chunks.entries()) {
    onProgress((index + 1) / total, `chunk ${index + 1} of ${total}`);
    // A chunk failing fails the whole transcription, so no partial or
    // ambiguous transcript is ever written.
    const segments = await uploadChunk(
      chunk.bytes,
      `chunk-${String(index).padStart(3, "0")}-${fileName}`,
      "audio/wav",
    );
    results.push([segments, chunk.startOffsetSecs]);
  }

  return mergeChunkSegments(results);
}

interface WhisperResponse {
  segments?: Array<{ start: number; end: number; text: string }>;
}

/** A RIFF/WAVE header — i.e. audio extracted before the move to Opus. */
function isRiff(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
  );
}

/** Content type for `fileName`'s extension. Whisper keys off the extension
 * more than the part's type, but a matching one keeps the two from
 * disagreeing. Only what `extractAudio` has ever written needs to appear;
 * anything else falls back to Opus/Ogg, today's output. */
function mimeFor(fileName: string): string {
  return fileName.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/ogg";
}

/** One audio file — a whole recording, or a WAV chunk of a legacy oversized
 * one — with timestamps relative to its own start. */
async function uploadChunk(
  audioBytes: Uint8Array<ArrayBuffer>,
  fileName: string,
  mime: string,
): Promise<TranscriptSegment[]> {
  const form = new FormData();
  form.set("model", TRANSCRIPTION_MODEL);
  // Segment-level timestamps; the plain response format has none, and the
  // whole editing model downstream is built on them.
  form.set("response_format", "verbose_json");
  form.set("file", new Blob([audioBytes], { type: mime }), fileName);

  const response = await callOpenAi(
    "/audio/transcriptions",
    { method: "POST", headers: authHeaders(), body: form },
    TRANSCRIBE_TIMEOUT_MS,
    "Whisper",
  );

  const parsed = (await response.json()) as WhisperResponse;
  return (parsed.segments ?? []).map((segment) => ({
    start: segment.start,
    end: segment.end,
    text: segment.text,
  }));
}

/**
 * Offsets each chunk's timestamps by where that chunk starts in the full
 * recording and concatenates them in chunk order. Pure — testable directly
 * against plain arrays.
 */
export function mergeChunkSegments(
  chunks: Array<[TranscriptSegment[], number]>,
): TranscriptSegment[] {
  return chunks.flatMap(([segments, offset]) =>
    segments.map((segment) => ({
      start: segment.start + offset,
      end: segment.end + offset,
      text: segment.text,
    })),
  );
}
