// PORTED FROM: src/db.ts @ 16d83e5
// DEVIATIONS: this file IS the seam — see docs/web-app-plan.md §1. The
// exported names, signatures and types match desktop's so that every copied
// view compiles unchanged; only the bodies differ (fetch instead of invoke).
// The exceptions are the ones §4 forces: D1 (importVideos takes File
// objects, since a browser has no paths), D2 (playback URLs are minted, not
// derived), D5 (exports have no output directory) and D6 (reveal becomes a
// download). Each is marked below.
//
// Design note: the frontend has no SQL surface here either — `apps/api`
// owns the database, exactly as Rust does on desktop.

import { request, requestOrNull, putToStorage, putPart } from "./api";

export interface Project {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface Video {
  id: string;
  project_id: string;
  // D2: on desktop this is a filesystem path; here it is the R2 object key,
  // `{org}/{project}/{video}/{original filename}`. The name is kept so the
  // copied views compile untouched, and the key deliberately ends with the
  // uploaded filename so `basename(video.file_path)` still renders what the
  // user recognises. Never a URL — see plan §3.4's portability rules.
  file_path: string;
  duration: number | null;
  transcript_status: string;
  created_at: string;
  updated_at: string;
  // The extracted-audio object key, set once the worker's extract job
  // succeeds. Same role as desktop's cached WAV path: lets a retry tell
  // whether extraction already completed and skip to transcription.
  audio_path: string | null;
}

// Keep in sync with the desktop app's `SUPPORTED_EXTENSIONS`
// (`src-tauri/src/db.rs`) — the API is the enforcing side here; this copy
// only feeds the file picker's `accept` filter.
export const SUPPORTED_VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "m4v"];

// D4: same `VideoProgress` shape desktop emits on its "video-progress"
// channel, delivered over SSE instead. `useVideoProgress` consumes the
// struct rather than raw events, so only the subscription line differs.
export type Stage = "ExtractingAudio" | "Transcribing" | "Analyzing";

export interface VideoProgress {
  video_id: string;
  stage: Stage;
  // `null` means indeterminate (show a spinner, not a bar).
  fraction: number | null;
  detail: string | null;
  attempt: number;
}

export async function createProject(name: string): Promise<Project> {
  return request<Project>("POST", "/projects", { name });
}

export async function listProjects(): Promise<Project[]> {
  // Org-scoped server-side (plan §4.1): this lists the *active org's*
  // projects, which for a single-org user is identical to desktop.
  return request<Project[]>("GET", "/projects");
}

export async function getProject(id: string): Promise<Project | null> {
  // Resolves to `null` for a missing project and only rejects on a real
  // error, so a not-found and a genuine failure aren't conflated — same
  // contract as desktop's command.
  return requestOrNull<Project>("GET", `/projects/${id}`);
}

/**
 * One video's upload ticket, minted by the API before any bytes move.
 *
 * The server picks the shape, not the client: whether a file is small enough
 * for one PUT is a storage-side fact (S3's per-PUT ceiling, the part-size
 * floor), and duplicating that threshold in the browser would mean two places
 * to get it wrong. Either way the SPA only ever sees presigned URLs, never a
 * bucket hostname (plan §3.4 rule 3).
 */
interface UploadTicket {
  video_id: string;
  storage_key: string;
  upload:
    | { mode: "single"; url: string }
    | { mode: "multipart"; upload_id: string; part_size: number; part_count: number };
}

interface PartUrl {
  part_number: number;
  url: string;
}

/** How many parts are in flight at once. Enough to keep a fast connection
 * busy, few enough that a phone on hotel wifi isn't fighting itself — and
 * few enough that a failure costs at most this many parts' worth of retry. */
const PART_CONCURRENCY = 3;

/**
 * Uploads `file` in parts and returns the (part number, ETag) list the
 * completion call needs.
 *
 * Part URLs are signed a batch at a time rather than all at once, which is
 * what makes a genuinely large upload work: signatures are short-lived by
 * design, and a 20 GB file over a slow line would outlive URLs minted at the
 * start. Signing per batch also means a retried part gets a fresh signature
 * for free.
 */
async function uploadParts(
  videoId: string,
  upload: Extract<UploadTicket["upload"], { mode: "multipart" }>,
  file: File,
): Promise<Array<{ part_number: number; etag: string }>> {
  const uploaded: Array<{ part_number: number; etag: string }> = [];

  for (let first = 1; first <= upload.part_count; first += PART_CONCURRENCY) {
    const batch = Array.from(
      { length: Math.min(PART_CONCURRENCY, upload.part_count - first + 1) },
      (_, index) => first + index,
    );
    const { urls } = await request<{ urls: PartUrl[] }>(
      "POST",
      `/videos/${videoId}/upload/part-urls`,
      { upload_id: upload.upload_id, part_numbers: batch },
    );

    const results = await Promise.all(
      urls.map(async ({ part_number, url }) => {
        // Parts are numbered from 1; `slice` is zero-based. The last part is
        // whatever is left, which is the only one allowed to be under the
        // part-size floor.
        const start = (part_number - 1) * upload.part_size;
        const chunk = file.slice(start, Math.min(start + upload.part_size, file.size));
        return { part_number, etag: await putPart(url, chunk) };
      }),
    );
    uploaded.push(...results);
  }

  return uploaded;
}

// D1: desktop takes filesystem paths from a native dialog and leaves the
// files where they are. A browser has neither, so this takes the `File`
// objects the picker produced, uploads each one directly to object storage
// with presigned URLs (the API never proxies video bytes — plan §3.2), and
// returns the rows the API created. Everything else about the call — one
// call per import, returns only the newly created rows — matches desktop.
//
// Large files go up in parts. That is not an optimization: a one-shot PUT of
// a lecture recording restarts from zero on any network blip, and S3 caps a
// single PUT well below the size of a two-hour capture. With parts, a blip
// costs one part.
export async function importVideos(projectId: string, files: File[]): Promise<Video[]> {
  const created: Video[] = [];
  for (const file of files) {
    const contentType = file.type || "application/octet-stream";
    const ticket = await request<UploadTicket>("POST", `/projects/${projectId}/uploads`, {
      filename: file.name,
      size: file.size,
      content_type: contentType,
    });

    if (ticket.upload.mode === "single") {
      await putToStorage(ticket.upload.url, file, contentType);
      // Only after the bytes land does the row become importable — the API
      // confirms the object arrived and flips `upload_status` to `uploaded`
      // (plan §6).
      created.push(await request<Video>("POST", `/videos/${ticket.video_id}/complete`, {}));
      continue;
    }

    const upload = ticket.upload;
    try {
      const parts = await uploadParts(ticket.video_id, upload, file);
      created.push(
        await request<Video>("POST", `/videos/${ticket.video_id}/complete`, {
          upload_id: upload.upload_id,
          parts,
        }),
      );
    } catch (err) {
      // Abandoned parts are billed until they are cleaned up, so a failed
      // upload tells storage to forget them rather than leaving that to a
      // lifecycle rule. Best-effort: the original failure is what the user
      // needs to see, and swallowing it in favour of an abort error would
      // hide the actual problem.
      await request("POST", `/videos/${ticket.video_id}/upload/abort`, {
        upload_id: upload.upload_id,
      }).catch(() => undefined);
      throw err;
    }
  }
  return created;
}

export async function listVideos(projectId: string): Promise<Video[]> {
  return request<Video[]>("GET", `/projects/${projectId}/videos`);
}

export async function getVideo(id: string): Promise<Video | null> {
  return requestOrNull<Video>("GET", `/videos/${id}`);
}

// Marks a video `transcript_status = 'error'` without an actual attempt —
// used when the frontend itself short-circuits the pipeline (e.g. no OpenAI
// key saved), so the row still lands somewhere the existing Retry button can
// pick it up from.
export async function markVideoError(id: string): Promise<void> {
  await request<void>("POST", `/videos/${id}/error`);
}

// D3: desktop runs ffmpeg inline and resolves when done. Here this enqueues
// a job for `apps/worker` and resolves as soon as it is queued; the video
// row comes back in its new state and completion arrives via the progress
// stream. `attempt` is stamped onto this run's progress events (1 for a
// fresh import, >1 for a Retry), same convention as desktop.
export async function extractAudioForVideo(videoId: string, attempt: number): Promise<Video> {
  return request<Video>("POST", `/videos/${videoId}/extract`, { attempt });
}

export interface TranscriptSegment {
  id: string;
  video_id: string;
  start: number;
  end: number;
  text: string;
  keep: boolean;
}

// Enqueues transcription. As on desktop, only the **extracted audio** ever
// reaches OpenAI — never the source video (plan §9). Content-hash caching
// still applies but is scoped per-org, which is a security requirement, not
// an optimization (plan §6).
export async function transcribeVideo(videoId: string, attempt: number): Promise<Video> {
  return request<Video>("POST", `/videos/${videoId}/transcribe`, { attempt });
}

export async function listTranscriptSegments(videoId: string): Promise<TranscriptSegment[]> {
  return request<TranscriptSegment[]>("GET", `/videos/${videoId}/transcript`);
}

// Transcript Mode editing (PRD §8.1) — a plain row update, no AI involved.
export async function updateTranscriptSegment(id: string, keep: boolean): Promise<TranscriptSegment> {
  return request<TranscriptSegment>("PATCH", `/transcript-segments/${id}`, { keep });
}

export interface Lesson {
  id: string;
  video_id: string;
  title: string;
  summary: string | null;
  start: number;
  end: number;
  sort_order: number;
  // Nullable: unset for a manually-created lesson that never went through AI
  // analysis.
  confidence: number | null;
  // One of "lesson" | "qna" | "discussion" | "break" | "silence" |
  // "duplicate" (PRD §7.5).
  kind: string;
  // "ai" for AI-suggested rows, "manual" for hand-built ones.
  source: string;
}

// Enqueues lesson-boundary analysis. Only the transcript **text** is sent to
// GPT-5.5 — never audio, never video (plan §9). Re-running replaces the
// video's AI-sourced lessons rather than accumulating, same as desktop.
export async function analyzeVideo(videoId: string, attempt: number): Promise<Lesson[]> {
  return request<Lesson[]>("POST", `/videos/${videoId}/analyze`, { attempt });
}

export async function listLessons(videoId: string): Promise<Lesson[]> {
  return request<Lesson[]>("GET", `/videos/${videoId}/lessons`);
}

// One `{start, end}` range for `createLesson` below — already collapsed from
// a transcript-segment checkbox selection into contiguous runs by the caller
// (see `CreateLessonModal`), so a non-contiguous selection arrives here as
// more than one range.
export interface LessonSegmentRange {
  start: number;
  end: number;
}

// Creates a manually-built lesson (`source: "manual"`, not `"ai"`), one
// `lesson_segments` row per range. `source !== "ai"` is what keeps
// re-analysis from deleting it.
export async function createLesson(
  videoId: string,
  title: string,
  segments: LessonSegmentRange[],
): Promise<Lesson> {
  return request<Lesson>("POST", `/videos/${videoId}/lessons`, { title, segments });
}

// Patch semantics: omit (or pass `undefined` for) a field to leave it
// unchanged. `start`/`end` are a cached bound derived from a lesson's
// segments and are not settable here — see the segment calls below.
export async function updateLesson(
  id: string,
  patch: { title?: string; summary?: string },
): Promise<Lesson> {
  return request<Lesson>("PATCH", `/lessons/${id}`, {
    title: patch.title ?? null,
    summary: patch.summary ?? null,
  });
}

// Splits `segmentId` (which must belong to `lessonId`) into two at `atTime`
// (must be strictly inside that segment's current `[start, end)`); returns
// both resulting lesson rows.
export async function splitLesson(
  lessonId: string,
  segmentId: string,
  atTime: number,
): Promise<Lesson[]> {
  return request<Lesson[]>("POST", `/lessons/${lessonId}/split`, {
    segment_id: segmentId,
    at_time: atTime,
  });
}

// Merges `secondId` into `firstId` (both must belong to the same video);
// returns the merged row. `secondId`'s row is deleted.
export async function mergeLessons(firstId: string, secondId: string): Promise<Lesson> {
  return request<Lesson>("POST", "/lessons/merge", { first_id: firstId, second_id: secondId });
}

// A lesson is built from one or more, possibly overlapping and
// non-contiguous, segments of its source video. `lessons.start`/`.end`
// remain a read-only cached bound (min/max across these), kept in sync
// server-side after every segment write.
export interface LessonSegment {
  id: string;
  lesson_id: string;
  start: number;
  end: number;
  sort_order: number;
}

// Deleting a lesson's last remaining segment deletes the lesson itself
// rather than leaving it with stale cached bounds — `lesson_deleted` tells
// the caller which happened.
export interface DeleteLessonSegmentResult {
  lesson_id: string;
  lesson_deleted: boolean;
}

// Read-only listing of a lesson's segments, in playback (`sort_order`) order.
export async function listLessonSegments(lessonId: string): Promise<LessonSegment[]> {
  return request<LessonSegment[]>("GET", `/lessons/${lessonId}/segments`);
}

// Appends a new segment (always added last); the parent lesson's cached
// bound is recomputed server-side. No overlap validation, by design.
export async function addLessonSegment(
  lessonId: string,
  start: number,
  end: number,
): Promise<LessonSegment> {
  return request<LessonSegment>("POST", `/lessons/${lessonId}/segments`, { start, end });
}

export async function updateLessonSegment(
  id: string,
  start: number,
  end: number,
): Promise<LessonSegment> {
  return request<LessonSegment>("PATCH", `/lesson-segments/${id}`, { start, end });
}

export async function deleteLessonSegment(id: string): Promise<DeleteLessonSegmentResult> {
  return request<DeleteLessonSegmentResult>("DELETE", `/lesson-segments/${id}`);
}

// Per-lesson AI segment edit — the free-text prompt box on
// `LessonSegmentsView`. Sends this lesson's current ranges, a windowed slice
// of the video's transcript **text**, and the instruction; never audio or
// video. Proposing is a pure read (no DB write); `baseline` omitted means
// "start from this lesson's real current segments", while passing the
// popup's not-yet-applied proposal is how "Update proposal" refines without
// re-reading the database.
export async function previewLessonSegmentEdit(
  lessonId: string,
  instruction: string,
  baseline?: LessonSegmentRange[],
): Promise<LessonSegmentRange[]> {
  return request<LessonSegmentRange[]>("POST", `/lessons/${lessonId}/segment-edit/preview`, {
    instruction,
    baseline: baseline ?? null,
  });
}

// Commits exactly what the review popup displayed as the lesson's new
// segments. Rejects an empty array rather than deleting the lesson as a side
// effect.
export async function applyLessonSegmentEdit(
  lessonId: string,
  segments: LessonSegmentRange[],
): Promise<LessonSegment[]> {
  return request<LessonSegment[]>("POST", `/lessons/${lessonId}/segment-edit/apply`, { segments });
}

// Sets `sort_order` to each id's position in `orderedIds` — must be exactly
// the lesson's current set of segment ids (a partial/mismatched list is
// rejected rather than silently applied). Doesn't change any segment's own
// start/end, only playback sequence.
export async function reorderLessonSegments(lessonId: string, orderedIds: string[]): Promise<void> {
  await request<void>("PUT", `/lessons/${lessonId}/segment-order`, { ordered_ids: orderedIds });
}

export async function deleteLesson(id: string): Promise<void> {
  await request<void>("DELETE", `/lessons/${id}`);
}

// Same all-or-nothing contract as `reorderLessonSegments`, for a video's
// lessons.
export async function reorderLessons(videoId: string, orderedIds: string[]): Promise<void> {
  await request<void>("PUT", `/videos/${videoId}/lesson-order`, { ordered_ids: orderedIds });
}

export async function deleteProject(id: string): Promise<void> {
  // Cascade delete of videos/lessons/etc. is the schema's job (ON DELETE
  // CASCADE), as on desktop. Purging the org's objects from storage is the
  // API's — a dropped row must not leave video behind (plan §9).
  await request<void>("DELETE", `/projects/${id}`);
}

export async function deleteVideo(id: string): Promise<void> {
  await request<void>("DELETE", `/videos/${id}`);
}

// D7: desktop is BYOK — the user's own OpenAI key, held in the OS keychain,
// with a Settings screen to save and test it. The web app is not. It uses a
// single platform-owned key from the server's environment, so there is
// nothing for a tenant to enter, nothing to store, and no key surface here at
// all: `saveOpenAiKey`, `getOpenAiKeyStatus`, `testOpenAiKey`, `KeyStatus`
// and `KeyTestResult` have no web counterpart and are deliberately absent
// rather than stubbed. A stub would leave `SettingsView` rendering a form
// that silently does nothing.
//
// This is the one place `db.ts` is a strict *subset* of desktop's surface
// rather than a match. The removal is what forces the compile error in
// `SettingsView` that D9 then resolves — which is the intended order.

// Free-text user preferences (PRD §7.5) appended to the analysis prompt.
// Still the tenant's to set: the key is ours, the instructions are theirs.
export async function saveAnalysisInstructions(instructions: string): Promise<void> {
  await request<void>("PUT", "/settings/analysis-instructions", { instructions });
}

export async function getAnalysisInstructions(): Promise<string | null> {
  const result = await request<{ instructions: string | null }>(
    "GET",
    "/settings/analysis-instructions",
  );
  return result.instructions;
}

export interface ExportRow {
  id: string;
  lesson_id: string;
  // D5: the output object key rather than a local file path. Kept under the
  // desktop name so Export History renders unchanged.
  output_path: string;
  // One of "queued" | "paused" | "running" | "done" | "failed" | "cancelled".
  status: string;
  created_at: string;
  // Fraction in [0, 1] of the lesson's own duration, updated while running.
  progress: number;
  // Set only when status === "failed".
  error: string | null;
  // Lesson/video ancestry, joined in by `listExports` for Export History
  // (PRD §11). Present on every row `listExports` returns; the other export
  // calls return these as empty-string/zero placeholders, since their
  // callers always re-fetch via `listExports` rather than rendering the
  // return value — don't rely on these four outside a `listExports` result.
  lesson_title: string;
  lesson_start: number;
  lesson_end: number;
  video_file_path: string;
}

// D5: no `outputDir` — the worker writes the finished MP4 to object storage
// and the UI offers a download. The parameter is kept in the signature so
// the copied views' call sites match desktop's, and ignored server-side.
export async function queueExport(lessonIds: string[], outputDir: string): Promise<ExportRow[]> {
  void outputDir;
  return request<ExportRow[]>("POST", "/exports", { lesson_ids: lessonIds });
}

// Pause/resume only ever apply to a job that hasn't started encoding yet
// (`queued` <-> `paused`); calling either on a `running` export is rejected
// rather than attempting to suspend a live ffmpeg process.
export async function pauseExport(id: string): Promise<ExportRow> {
  return request<ExportRow>("POST", `/exports/${id}/pause`);
}

export async function resumeExport(id: string): Promise<ExportRow> {
  return request<ExportRow>("POST", `/exports/${id}/resume`);
}

// For a queued/paused job this just marks it cancelled. For a running job
// the worker kills the in-flight ffmpeg process.
export async function cancelExport(id: string): Promise<ExportRow> {
  return request<ExportRow>("POST", `/exports/${id}/cancel`);
}

// Resets a failed/cancelled job back to `queued` (clearing progress/error).
export async function retryExport(id: string): Promise<ExportRow> {
  return request<ExportRow>("POST", `/exports/${id}/retry`);
}

// Read-only, project-scoped listing (joined through lessons -> videos),
// newest first.
export async function listExports(projectId: string): Promise<ExportRow[]> {
  return request<ExportRow[]>("GET", `/projects/${projectId}/exports`);
}

// D6: desktop opens Finder/Explorer. A browser can't, so the nearest
// equivalent is handing the user the file: mint a short-TTL download URL and
// open it. Keeping the desktop name means Export History's "Reveal" button
// is copied unchanged; only its label is a lie, which the view corrects.
export async function revealInFolder(outputPath: string): Promise<void> {
  const { url } = await request<{ url: string }>("POST", "/exports/download-url", {
    output_key: outputPath,
  });
  window.open(url, "_blank", "noopener,noreferrer");
}

// --- Web-only surface (no desktop counterpart) ---

// D2: desktop derives a playback URL locally with `convertFileSrc`. Here the
// API mints a short-TTL presigned GET. Takes the object key because that is
// what the copied components already hold; `apps/api` must resolve it to a
// video row under the caller's org (RLS makes a foreign key simply return no
// row) rather than signing whatever it is handed.
export async function getPlaybackUrl(storageKey: string): Promise<string> {
  const { url } = await request<{ url: string }>("POST", "/videos/playback-url", {
    storage_key: storageKey,
  });
  return url;
}

// D5: desktop asks for an output folder before queuing an export. There is
// no such thing here, so this resolves without prompting. It exists so the
// copied export handlers keep their shape (`pick → queue`) instead of
// growing a web-only branch, and so a future "choose where to save" — should
// the File System Access API ever be worth using — has one place to live.
export async function pickExportDirectory(): Promise<string | null> {
  return "";
}
