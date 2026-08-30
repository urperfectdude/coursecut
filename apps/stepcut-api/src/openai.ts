// Whisper transcription (Phase 2) and GPT-5.5 step analysis (Phase 3).
//
// The Whisper half is the transcription-only slice of apps/api's
// src/openai.ts (`src-tauri/src/openai.rs`'s Whisper half, by way of that
// port). The analysis half below is **not** a port or a fork of that file's
// `analyzeTranscript` — plan §9 is explicit that this prompt has to be its
// own from day one, tuned for "steps in a task" rather than "lessons in a
// lecture," because the freedom to iterate on it without touching the
// shipped lesson product is the entire reason this backend is separate. The
// shape it shares with the coursecut original (a text-only chat completion
// returning a constrained JSON object, parsed defensively) is a technique
// worth reusing, not a prompt worth reusing.
//
// **Privacy**, unchanged from the coursecut original: only extracted audio
// reaches Whisper, and only transcript **text** reaches GPT-5.5 — never the
// source video. This module has no filesystem and no S3 access at all — it
// takes audio as bytes, and transcript rows as plain objects, a caller
// already has. Nothing else about a tenant (ids, names, keys) is ever sent.
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

/** Same ceiling apps/api's chat completion gives GPT-5.5 for lesson analysis. */
const COMPLETION_TIMEOUT_MS = 180_000;

const TRANSCRIPTION_MODEL = "whisper-1";
const ANALYSIS_MODEL = "gpt-5.5";

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

// ---------------------------------------------------------------------------
// GPT-5.5 step analysis (Phase 3 — docs/stepcut-plan.md §5.3)
// ---------------------------------------------------------------------------

/**
 * One step proposal. `start`/`end`/`title` are always populated and
 * `start < end`; `confidence` is always within `[0, 1]` — both enforced
 * before the object is built, so nothing downstream re-checks them.
 *
 * Unlike a coursecut `LessonSuggestion`, this is a single range, not an array
 * of them — a step is one contiguous action, never assembled from
 * non-contiguous parts of the transcript (see `schema.ts`'s `steps` header).
 */
export interface StepSuggestion {
  start: number;
  end: number;
  title: string;
  summary: string;
  confidence: number;
}

const STEP_ANALYSIS_SYSTEM_PROMPT =
  "You are an assistant that watches the transcript of a narrated screen recording — someone " +
  "walking through a task on their computer while describing what they are doing — and proposes " +
  "the discrete steps that make up that task, for a tool that turns the recording into a " +
  "step-by-step tutorial video. You are given the transcript as a sequence of timestamped " +
  'segments (in seconds). Respond with a single JSON object of the exact shape {"steps": ' +
  '[{"start": number, "end": number, "title": string, "summary": string, "confidence": number}, ' +
  '...]} and nothing else — no prose, no markdown fences. A step is one contiguous, ordered ' +
  'action the narrator performs and describes — for example "open the settings page", "rename ' +
  'the project", or "click Save" — not a topic, a lesson, or a question. Order steps by `start` ' +
  "and do not let them overlap; it is fine, and expected, for there to be a gap between two steps " +
  "for narration that is not itself a step (a preamble, a false start, dead air, an aside) rather " +
  "than forcing that material into the nearest step. Give each step a short, imperative title " +
  '(for example "Open the settings menu") and a one- or two-sentence summary of what the user ' +
  "does and why, written for someone following along afterward. Every `start` and `end` must be a " +
  "real timestamp in seconds, drawn from (or falling between) the given segment boundaries, with " +
  "`start` < `end`. Every step must include a `confidence` between 0 and 1 reflecting how sure " +
  "you are about that step's boundaries.";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/**
 * A finite number out of a JSON value that should be numeric. A numeric
 * string is accepted too rather than discarding an otherwise-usable
 * suggestion over a formatting slip.
 */
function valueAsNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** One text-only chat completion, returning the message content. */
async function chatCompletion(systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await callOpenAi(
    "/chat/completions",
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ANALYSIS_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    },
    COMPLETION_TIMEOUT_MS,
    "GPT-5.5",
  );

  const parsed = (await response.json()) as ChatCompletionResponse;
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) throw new Error("GPT-5.5 response had no message content");
  return content;
}

/** A transcript line, timestamped in seconds — the shape both `transcribeAudio`
 * and `analyzeSteps` agree on for a stored `transcript_segments` row. */
export interface TranscriptLine {
  start: number;
  end: number;
  text: string;
}

/** The `[start-end] text` rendering the analysis prompt uses for transcript context. */
function renderTranscript(segments: readonly TranscriptLine[]): string {
  return segments
    .map((segment) => `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}`)
    .join("\n");
}

/**
 * Sends transcript **text only** — timestamps and words, never audio, never
 * video — to GPT-5.5 and parses the reply into validated step suggestions.
 */
export async function analyzeSteps(segments: readonly TranscriptLine[]): Promise<StepSuggestion[]> {
  if (segments.length === 0) throw new Error("no transcript segments to analyze");

  const transcriptStart = Math.min(...segments.map((segment) => segment.start));
  const transcriptEnd = Math.max(...segments.map((segment) => segment.end));

  const content = await chatCompletion(
    STEP_ANALYSIS_SYSTEM_PROMPT,
    `Transcript (timestamps in seconds):\n\n${renderTranscript(segments)}`,
  );

  return parseStepSuggestions(content, transcriptStart, transcriptEnd);
}

/**
 * Parses `{"steps": [...]}` into validated suggestions, **dropping** rather
 * than erroring on any individual entry that is malformed: non-numeric
 * bounds, `start >= end`, or bounds outside `[rangeStart - 1, rangeEnd + 1]`
 * (a small tolerance around the transcript context actually given, mirroring
 * the prompt's instruction to draw ranges from within it). A missing `steps`
 * array is an error, since that is a malformed response rather than an empty
 * one.
 */
export function parseStepSuggestions(
  content: string,
  transcriptStart: number,
  transcriptEnd: number,
): StepSuggestion[] {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `could not parse GPT-5.5 JSON payload: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rawSteps = (payload as { steps?: unknown })?.steps;
  if (!Array.isArray(rawSteps)) {
    throw new Error('GPT-5.5 JSON payload is missing a "steps" array');
  }

  const suggestions: StepSuggestion[] = [];
  for (const raw of rawSteps) {
    const entry = raw as Record<string, unknown>;
    const start = valueAsNumber(entry.start);
    const end = valueAsNumber(entry.end);
    if (start === undefined || end === undefined) continue;
    if (end <= start || start < transcriptStart - 1 || end > transcriptEnd + 1) continue;

    const trimmedTitle = typeof entry.title === "string" ? entry.title.trim() : "";
    const title = trimmedTitle.length > 0 ? trimmedTitle : "Untitled step";

    suggestions.push({
      start,
      end,
      title,
      summary: typeof entry.summary === "string" ? entry.summary : "",
      confidence: Math.min(1, Math.max(0, valueAsNumber(entry.confidence) ?? 0.5)),
    });
  }

  return suggestions;
}
