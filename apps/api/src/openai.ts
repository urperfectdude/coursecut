// Whisper transcription and GPT-5.5 analysis — `src-tauri/src/openai.rs`
// ported, prompts and validation rules intact.
//
// **Why this lives in `apps/api` rather than `apps/worker`.** Almost all of it
// is the worker's: transcription and analysis are jobs. But
// `previewLessonSegmentEdit` needs a model call *inside* a request (the review
// popup waits for a proposal), so the API needs the lesson-edit half. Written
// once, here, and imported by both — `apps/worker` already imports this
// package's schema, storage and events, so the dependency runs one way.
//
// **Privacy (plan §9, and `coursecut-privacy-invariants` for the desktop
// original).** The rule the desktop app enforces carries over unchanged, and
// it is the one thing in this file that must never be relaxed: only the
// **extracted audio** goes to Whisper, and only transcript **text** goes to
// GPT-5.5. The source video is never read here — this module has no filesystem
// and no S3 access at all, and takes audio as bytes a caller already
// extracted. Nothing else about a tenant (ids, names, keys) is ever sent.
//
// **D7 — the key is the platform's.** One `OPENAI_API_KEY` in the server's
// environment, used for every tenant, never in the database and never sent to
// the browser. There is no per-org key to look up, which is why no function
// here takes one: desktop's `api_key` parameter has no analogue.

import { env } from "./env.js";
import { splitIntoChunks } from "./wav.js";

/** A transcript segment as Whisper returns it — seconds from the audio's start. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * What a prompt needs from a transcript row: when it was said and what was
 * said. Declared structurally rather than as the Drizzle row type so the
 * parsers can be unit-tested against plain objects, and so nothing here can
 * accidentally reach a column (`id`, `video_id`, `keep`) that has no business
 * leaving the building.
 */
export interface TranscriptLine {
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

/** Whisper can sit on a long upload; desktop allows the same 10 minutes. */
const TRANSCRIBE_TIMEOUT_MS = 600_000;
/** One text-only completion, but a full-lecture transcript is a lot of it. */
const COMPLETION_TIMEOUT_MS = 180_000;

const TRANSCRIPTION_MODEL = "whisper-1";
const ANALYSIS_MODEL = "gpt-5.5";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${env.openAiApiKey()}` };
}

/**
 * `fetch` with a deadline, and with the response body kept out of the error.
 *
 * A failed OpenAI call's body can echo back part of what was sent, and plan §9
 * says logs carry ids and error codes only — so the snippet that reaches the
 * caller is capped at desktop's 300 characters and goes into the error message
 * a user sees, not into a log line.
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
 * `onProgress` reports chunk N of M so the UI's progress bar means something
 * during a 40-minute lecture; a single-request upload reports indeterminate,
 * exactly as desktop does.
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
    // ambiguous transcript is ever written — same as desktop.
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
 * recording and concatenates them in chunk order. Pure — the unit tests drive
 * it directly, as desktop's do.
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
// GPT-5.5 lesson analysis (PRD §7.5)
// ---------------------------------------------------------------------------

/**
 * One lesson proposal. `segments` is always non-empty and every range is
 * individually valid; `kind` is always one of `ALLOWED_KINDS` and `confidence`
 * is always within [0, 1] — all four are enforced before the object is built,
 * so nothing downstream re-checks them.
 */
export interface LessonSuggestion {
  segments: Array<[number, number]>;
  title: string;
  summary: string;
  kind: string;
  confidence: number;
}

/** The `kind` values PRD §7.5 asks the model to distinguish. Anything else
 * falls back to "lesson" rather than failing the batch. */
const ALLOWED_KINDS = ["lesson", "qna", "discussion", "break", "silence", "duplicate"];

const ANALYSIS_SYSTEM_PROMPT =
  'You are an assistant that analyzes lecture transcripts for a video editing tool, to propose ' +
  'lesson boundaries. You are given a transcript as a sequence of timestamped segments (in ' +
  'seconds). Respond with a single JSON object of the exact shape {"lessons": [{"segments": ' +
  '[{"start": number, "end": number}, ...], "title": string, "summary": string, "kind": string, ' +
  '"confidence": number}, ...]} and nothing else — no prose, no markdown fences. Only propose ' +
  'lessons for material that actually belongs in one — do not force coverage of the whole ' +
  'transcript. It is fine, and expected, for there to be gaps between lessons (e.g. dead air, an ' +
  "off-topic tangent, or a break that doesn't deserve its own entry), and it is fine for two " +
  "lessons' segments to overlap where the content justifies it (for example, a duplicate " +
  "explanation might overlap the original it repeats). Each lesson's `segments` array lists the " +
  'one or more timestamp ranges that make up that lesson — most lessons will have exactly one, ' +
  'but a lesson may be assembled from multiple non-contiguous ranges when the same material is ' +
  'split across the transcript. Tag each proposed lesson with exactly one `kind`: "lesson" (a ' +
  'coherent, teachable segment — give it a short title and a one- or two-sentence summary), ' +
  '"qna" (a question-and-answer exchange), "discussion" (open discussion or back-and-forth not ' +
  'structured as a single lesson), "break" (an off-topic break or pause in instruction), ' +
  '"silence" (a long stretch with no substantive spoken content), or "duplicate" (a segment that ' +
  're-explains something already covered earlier in this same transcript). Each `start` and ' +
  '`end` must be a real timestamp in seconds, drawn from (or falling between) the given segment ' +
  'boundaries, with `start` < `end`. Every lesson must include a `confidence` between 0 and 1 ' +
  "reflecting how sure you are about that lesson's boundaries and kind.";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/**
 * A finite number out of a JSON value that should be numeric. A numeric string
 * is accepted too rather than discarding an otherwise-usable suggestion over a
 * formatting slip.
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

/** The `[start-end] text` rendering both prompts use for transcript context. */
function renderTranscript(segments: readonly TranscriptLine[]): string {
  return segments
    .map((segment) => `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}`)
    .join("\n");
}

/**
 * Sends transcript **text only** — timestamps and words, never audio, never
 * video — to GPT-5.5 and parses the reply into validated suggestions.
 *
 * `instructions` is the org's free-text analysis preferences
 * (`org_settings.analysis_instructions`, Settings → Analysis instructions).
 * Non-empty, it is appended to the system prompt as an extra paragraph — it
 * steers the analysis but never replaces the structural JSON requirements.
 * Empty or absent produces byte-for-byte the prompt desktop sends.
 */
export async function analyzeTranscript(
  segments: readonly TranscriptLine[],
  instructions: string | null,
): Promise<LessonSuggestion[]> {
  if (segments.length === 0) throw new Error("no transcript segments to analyze");

  const transcriptStart = Math.min(...segments.map((segment) => segment.start));
  const transcriptEnd = Math.max(...segments.map((segment) => segment.end));

  const trimmed = instructions?.trim();
  const systemPrompt = trimmed
    ? `${ANALYSIS_SYSTEM_PROMPT}\n\nAdditional user requirements for this analysis: ${trimmed}`
    : ANALYSIS_SYSTEM_PROMPT;

  const content = await chatCompletion(
    systemPrompt,
    `Transcript (timestamps in seconds):\n\n${renderTranscript(segments)}`,
  );

  return parseLessonSuggestions(content, transcriptStart, transcriptEnd);
}

/**
 * Validates a JSON `segments` array into ranges, **dropping** rather than
 * erroring on any individual entry that is malformed: non-numeric bounds,
 * `start >= end`, or bounds outside `[rangeStart - 1, rangeEnd + 1]` (a small
 * tolerance around the transcript context actually given, mirroring the
 * prompt's instruction to draw ranges from within it). A value that is not an
 * array at all yields no ranges rather than throwing.
 */
function parseSegmentArray(value: unknown, rangeStart: number, rangeEnd: number): Array<[number, number]> {
  if (!Array.isArray(value)) return [];

  const segments: Array<[number, number]> = [];
  for (const raw of value) {
    const entry = raw as { start?: unknown; end?: unknown };
    const start = valueAsNumber(entry?.start);
    const end = valueAsNumber(entry?.end);
    if (start === undefined || end === undefined) continue;
    if (end <= start || start < rangeStart - 1 || end > rangeEnd + 1) continue;
    segments.push([start, end]);
  }
  return segments;
}

/**
 * Parses `{"lessons": [...]}` into validated suggestions. A lesson with no
 * surviving segment is dropped; a missing `lessons` array is an error, since
 * that is a malformed response rather than an empty one.
 */
export function parseLessonSuggestions(
  content: string,
  transcriptStart: number,
  transcriptEnd: number,
): LessonSuggestion[] {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `could not parse GPT-5.5 JSON payload: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rawLessons = (payload as { lessons?: unknown })?.lessons;
  if (!Array.isArray(rawLessons)) {
    throw new Error('GPT-5.5 JSON payload is missing a "lessons" array');
  }

  const suggestions: LessonSuggestion[] = [];
  for (const raw of rawLessons) {
    const entry = raw as Record<string, unknown>;
    const segments = parseSegmentArray(entry?.segments, transcriptStart, transcriptEnd);
    if (segments.length === 0) continue;

    const kind = typeof entry.kind === "string" && ALLOWED_KINDS.includes(entry.kind)
      ? entry.kind
      : "lesson";

    suggestions.push({
      segments,
      title: typeof entry.title === "string" ? entry.title : "Untitled lesson",
      summary: typeof entry.summary === "string" ? entry.summary : "",
      kind,
      confidence: Math.min(1, Math.max(0, valueAsNumber(entry.confidence) ?? 0.5)),
    });
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Silence trimming (ux-overhaul M6)
// ---------------------------------------------------------------------------

/** Gaps between kept transcript segments longer than this count as dead air. */
export const SILENCE_GAP_THRESHOLD_SECS = 2.0;

/**
 * Dead-air gaps across `segments` — the kept transcript segments, sorted by
 * start, exactly as they were sent to the model. Because only `keep` rows are
 * in there, a reported gap is either genuine silence or content the user
 * already marked for removal; both are fair game to trim toward.
 */
export function silenceGaps(
  segments: readonly TranscriptLine[],
  thresholdSecs: number,
): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1]!;
    const next = segments[index]!;
    if (next.start - previous.end > thresholdSecs) gaps.push([previous.end, next.start]);
  }
  return gaps;
}

/**
 * Trims one segment's edges against overlapping gaps: a gap over the leading
 * edge pushes `start` forward, one over the trailing edge pulls `end` back. A
 * gap entirely inside the segment is left alone — this trims edges, it never
 * splits. Returns `undefined` when trimming consumes the segment.
 */
export function trimSegmentAgainstGaps(
  segment: [number, number],
  gaps: ReadonlyArray<[number, number]>,
): [number, number] | undefined {
  let [start, end] = segment;
  for (const [gapStart, gapEnd] of gaps) {
    const preStart = start;
    const preEnd = end;
    if (gapStart <= preStart && gapEnd > preStart) start = Math.max(start, gapEnd);
    if (gapEnd >= preEnd && gapStart < preEnd) end = Math.min(end, gapStart);
  }
  return start < end ? [start, end] : undefined;
}

/**
 * Applies the trim to every segment of every suggestion. A segment trimmed to
 * nothing is dropped; a suggestion is dropped only when *all* of its segments
 * were — the same rule `parseLessonSuggestions` uses for invalid ones.
 *
 * This runs before the suggestions are persisted, so whatever survives is
 * exactly what `lesson_segments` stores and what the lesson card plays back.
 * The trim is visible in the segment list, never a silent adjustment.
 */
export function trimSilenceFromSuggestions(
  suggestions: LessonSuggestion[],
  gaps: ReadonlyArray<[number, number]>,
): LessonSuggestion[] {
  return suggestions.flatMap((suggestion) => {
    const segments = suggestion.segments.flatMap((segment) => {
      const trimmed = trimSegmentAgainstGaps(segment, gaps);
      return trimmed ? [trimmed] : [];
    });
    return segments.length === 0 ? [] : [{ ...suggestion, segments }];
  });
}

// ---------------------------------------------------------------------------
// Per-lesson AI segment edit
// ---------------------------------------------------------------------------
//
// The free-text prompt box on `LessonSegmentsView`. Same shape as analysis (a
// text-only completion returning JSON) but scoped to one lesson and gated
// behind an explicit review step: proposing never writes to the database, and
// applying never calls the model. The old-vs-new popup is the seam.

const LESSON_EDIT_SYSTEM_PROMPT =
  "You are an assistant that revises a single lesson's segment list for a video editing tool, " +
  "per a user's free-text instruction. You are given: the lesson's current segment ranges " +
  '(start/end, in seconds, in order), a window of the underlying video\'s transcript as ' +
  'timestamped segments (also in seconds, via `[start-end]` prefixes, on the same timeline as ' +
  "the lesson's segment ranges), and the user's instruction. Respond with a single JSON object " +
  'of the exact shape {"segments": [{"start": number, "end": number}, ...]} and nothing else — ' +
  "no prose, no markdown fences. Revise the lesson's segments per the instruction: you may split " +
  'a segment into more ranges than were given, merge or remove segments (returning fewer ranges, ' +
  'or none at all if the instruction amounts to removing everything from this lesson), or trim a ' +
  "segment's start/end. Every returned range must come from within the transcript context given, " +
  'with `start` < `end`. The instruction may contain literal timestamps (for example "cut from ' +
  '2:15 to 3:40", "split at 12:03", "trim everything after 4:15") on this same source video ' +
  "timeline — the same seconds-based timeline every transcript line's `[start-end]` prefix, and " +
  'every given segment range, already use. Treat any such timestamp as a precise, authoritative ' +
  'boundary: convert it to seconds and use it directly, rather than approximating it from nearby ' +
  "transcript wording. Use the transcript content/wording only for whatever the instruction " +
  "doesn't pin to a specific time.";

/**
 * Timestamps typed into the instruction, in seconds.
 *
 * Deliberately loose matching (`mm:ss`, `h:mm:ss`, `hh:mm:ss:ff`,
 * `hh:mm:ss:fff`, no required zero-padding) — unlike `LessonSegmentsView`'s
 * own strict parser, someone typing into a free-text box will not reliably
 * zero-pad. A 2-digit trailing group reads as centiseconds and a 3-digit one
 * as milliseconds, so `78` is 0.78s and `078` is 0.078s.
 *
 * Nothing is validated against the lesson's real bounds here; this only
 * answers "what times, if any, did the user name", so the transcript context
 * window can be widened to cover them. No match is a valid, empty result.
 */
export function extractTimestampsSeconds(text: string): number[] {
  // 2 to 4 colon-separated groups of 1-3 digits, bounded so this cannot match
  // inside a longer digit run.
  const pattern = /\b\d{1,3}(?::\d{1,3}){1,3}\b/g;

  const found: number[] = [];
  for (const match of text.matchAll(pattern)) {
    const rawParts = match[0].split(":");
    const parts = rawParts.map((part) => Number.parseInt(part, 10));
    if (parts.some((part) => !Number.isFinite(part))) continue;

    if (parts.length === 2) {
      found.push(parts[0]! * 60 + parts[1]!);
    } else if (parts.length === 3) {
      found.push(parts[0]! * 3600 + parts[1]! * 60 + parts[2]!);
    } else if (parts.length === 4) {
      // Scale by however many digits were actually typed.
      const divisor = 10 ** rawParts[3]!.length;
      found.push(parts[0]! * 3600 + parts[1]! * 60 + parts[2]! + parts[3]! / divisor);
    }
  }
  return found;
}

/**
 * Parses `{"segments": [...]}` into ranges. A well-formed but empty array is a
 * valid proposal, not an error — "delete this whole lesson" is something the
 * user may have asked for, and nothing is written until they accept it. A
 * missing `segments` key *is* an error: that is a malformed reply.
 */
export function parseEditSegments(
  content: string,
  rangeStart: number,
  rangeEnd: number,
): Array<[number, number]> {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `could not parse GPT-5.5 JSON payload: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const value = (payload as { segments?: unknown })?.segments;
  if (value === undefined) throw new Error('GPT-5.5 JSON payload is missing a "segments" array');
  return parseSegmentArray(value, rangeStart, rangeEnd);
}

/**
 * Proposes a revised segment list for one lesson. Only transcript text and the
 * instruction (also text) are sent — never audio, never video.
 *
 * Proposed ranges are validated against the transcript window's own span, the
 * same rule analysis uses. An empty window (a lesson sitting in a stretch that
 * is entirely `keep = false`) has nothing to bound against, so the range check
 * is skipped rather than rejecting every proposal against an empty span.
 */
export async function editLessonSegments(
  baselineSegments: ReadonlyArray<[number, number]>,
  transcriptSegments: readonly TranscriptLine[],
  instruction: string,
): Promise<Array<[number, number]>> {
  const baselineText =
    baselineSegments.length === 0
      ? "(none — this lesson currently has no segments)"
      : baselineSegments.map(([start, end]) => `[${start.toFixed(2)}-${end.toFixed(2)}]`).join(", ");

  const content = await chatCompletion(
    LESSON_EDIT_SYSTEM_PROMPT,
    `Current lesson segments (seconds): ${baselineText}\n\n` +
      `Transcript context (timestamps in seconds):\n\n${renderTranscript(transcriptSegments)}\n\n` +
      `Instruction: ${instruction}`,
  );

  const rangeStart =
    transcriptSegments.length === 0
      ? Number.NEGATIVE_INFINITY
      : Math.min(...transcriptSegments.map((segment) => segment.start));
  const rangeEnd =
    transcriptSegments.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.max(...transcriptSegments.map((segment) => segment.end));

  return parseEditSegments(content, rangeStart, rangeEnd);
}
