import { invoke } from "@tauri-apps/api/core";

// Design note: coursecut queries SQLite from Rust only (see
// `src-tauri/src/db.rs`), invoked here over IPC via `invoke()`. The
// frontend has no direct SQL surface — there's no `@tauri-apps/plugin-sql`
// dependency, and no `sql:*` permissions in
// `src-tauri/capabilities/default.json`.

export interface Project {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface Video {
  id: string;
  project_id: string;
  file_path: string;
  duration: number | null;
  transcript_status: string;
  created_at: string;
  updated_at: string;
  // Path to the cached extracted audio, set once extraction succeeds (see
  // `src-tauri/src/ffmpeg.rs`). Lets a retry tell whether extraction has
  // already completed and skip straight to transcription.
  audio_path: string | null;
}

// Keep in sync with `SUPPORTED_EXTENSIONS` in `src-tauri/src/db.rs` —
// Rust is the enforcing side; this copy only feeds file-dialog filters.
export const SUPPORTED_VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "m4v"];

// Progress events (PRD-adjacent, `docs/ux-overhaul-plan.md` Phase 2) —
// emitted from Rust on the "video-progress" channel by `progress.rs` during
// the extract/transcribe/analyze pipeline. Local IPC only, consumed by
// `src/hooks/useVideoProgress.ts`. Keep in sync with `progress::Stage`/
// `progress::VideoProgress` in `src-tauri/src/progress.rs`.
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
  return invoke<Project>("create_project", { name });
}

export async function listProjects(): Promise<Project[]> {
  return invoke<Project[]>("list_projects");
}

export async function getProject(id: string): Promise<Project | null> {
  // Rust resolves to `null` when no project matches `id` and only rejects
  // on a real error, so a not-found and a genuine failure aren't conflated.
  return invoke<Project | null>("get_project", { id });
}

export async function importVideos(projectId: string, paths: string[]): Promise<Video[]> {
  // Rust walks the paths (recursing into folders), skips unsupported /
  // already-imported files, and returns only the newly created rows.
  // Source files stay where they are — import never copies or moves them.
  return invoke<Video[]>("import_videos", { projectId, paths });
}

export async function listVideos(projectId: string): Promise<Video[]> {
  return invoke<Video[]>("list_videos", { projectId });
}

// Looks up a single video by id (used by `LessonEditorView`, which is only
// handed a `videoId` — not its parent `projectId` — and needs `file_path`
// to build a playback URL via `convertFileSrc`). Rust resolves to `null`
// when no video matches `id`, mirroring `getProject`.
export async function getVideo(id: string): Promise<Video | null> {
  return invoke<Video | null>("get_video", { id });
}

// Marks a video row `transcript_status = 'error'` without an actual
// extraction/transcription attempt — used when the frontend itself
// short-circuits the pipeline (e.g. no OpenAI key saved), so the row still
// lands somewhere the existing Retry button can pick it up from, instead of
// being left stuck in `pending`/`audio_ready` with no way to retry.
export async function markVideoError(id: string): Promise<void> {
  await invoke("mark_video_error", { id });
}

// Runs ffmpeg/ffprobe (Rust-owned sidecars, see `src-tauri/src/ffmpeg.rs`)
// to probe the video's real duration and extract local audio, caching the
// result by content hash so re-importing an unchanged file skips the work.
// Never uploads video — see `coursecut-privacy-invariants`. `attempt` is
// stamped onto this call's "video-progress" events (1 for a fresh import,
// >1 for a Retry) — it's not incremented in Rust.
export async function extractAudioForVideo(videoId: string, attempt: number): Promise<Video> {
  return invoke<Video>("extract_audio_for_video", { videoId, attempt });
}

export interface TranscriptSegment {
  id: string;
  video_id: string;
  start: number;
  end: number;
  text: string;
  keep: boolean;
}

// Sends only the video's already-extracted local audio file (see
// `src-tauri/src/ffmpeg.rs`'s `audio_path`) to OpenAI's Whisper API — never
// the source video, never SQLite content beyond what locates that audio
// file. See `coursecut-privacy-invariants`. Skips the API call and copies
// cached segments instead if another video shares this one's content hash
// and already has a transcript (PRD §7.4). `attempt` is stamped onto this
// call's "video-progress" events, same convention as `extractAudioForVideo`.
export async function transcribeVideo(videoId: string, attempt: number): Promise<Video> {
  return invoke<Video>("transcribe_video", { videoId, attempt });
}

export async function listTranscriptSegments(videoId: string): Promise<TranscriptSegment[]> {
  return invoke<TranscriptSegment[]>("list_transcript_segments", { videoId });
}

// Transcript Mode editing (PRD §8.1) — pure local SQLite mutations, no
// OpenAI/network involvement. See `src-tauri/src/db.rs`.

export async function updateTranscriptSegment(id: string, keep: boolean): Promise<TranscriptSegment> {
  return invoke<TranscriptSegment>("update_transcript_segment", { id, keep });
}

export interface Lesson {
  id: string;
  video_id: string;
  title: string;
  summary: string | null;
  start: number;
  end: number;
  sort_order: number;
  // Nullable: unset for any future manually-created lesson that never went
  // through AI analysis.
  confidence: number | null;
  // One of "lesson" | "qna" | "discussion" | "break" | "silence" |
  // "duplicate" (PRD §7.5).
  kind: string;
  // "ai" for AI-suggested rows; reserved for future manual/edited rows.
  source: string;
}

// Sends only this video's transcript **text** (never audio, never video) to
// GPT-5.5 chat completions for lesson-boundary analysis (PRD §7.5). See
// `coursecut-privacy-invariants`. Replaces the video's AI-sourced lesson
// rows with the fresh suggestions (re-running is a clean replace, not an
// accumulation) and returns the full updated set. `attempt` is stamped onto
// this call's "video-progress" events, same convention as
// `extractAudioForVideo`/`transcribeVideo`.
export async function analyzeVideo(videoId: string, attempt: number): Promise<Lesson[]> {
  return invoke<Lesson[]>("analyze_video", { videoId, attempt });
}

export async function listLessons(videoId: string): Promise<Lesson[]> {
  return invoke<Lesson[]>("list_lessons", { videoId });
}

// One `{start, end}` range for `createLesson` below — already collapsed
// from a transcript-segment checkbox selection into contiguous runs by the
// caller (see `CreateLessonModal`), so a non-contiguous selection arrives
// here as more than one range.
export interface LessonSegmentRange {
  start: number;
  end: number;
}

// Creates a manually-built lesson (`source: "manual"`, not `"ai"`) from
// `segments`, one `lesson_segments` row per range — pure local SQLite
// mutation, see `src-tauri/src/db.rs`'s `create_lesson`. `source !==
// "ai"` means `analyzeVideo`'s re-analysis (`replace_ai_lessons_tx` in
// `openai.rs`, which deletes only `WHERE source = 'ai'`) never touches it.
export async function createLesson(
  videoId: string,
  title: string,
  segments: LessonSegmentRange[],
): Promise<Lesson> {
  return invoke<Lesson>("create_lesson", { videoId, title, segments });
}

// Lesson editing (PRD §8.1/§9) — patch/split/merge/delete/reorder, all pure
// local SQLite mutations (see `src-tauri/src/db.rs`). `updateLesson` uses
// patch semantics: omit (or pass `undefined` for) a field to leave it
// unchanged. Since `0006_lesson_segments.sql`, `start`/`end` are a cached
// bound derived from a lesson's segments and are no longer settable here —
// see `updateLessonSegment`/`addLessonSegment`/`deleteLessonSegment` below.
export async function updateLesson(
  id: string,
  patch: { title?: string; summary?: string },
): Promise<Lesson> {
  return invoke<Lesson>("update_lesson", {
    id,
    title: patch.title ?? null,
    summary: patch.summary ?? null,
  });
}

// Splits `segmentId` (which must belong to `lessonId`) into two at `atTime`
// (must be strictly inside that segment's current `[start, end)`); returns
// both resulting lesson rows.
export async function splitLesson(lessonId: string, segmentId: string, atTime: number): Promise<Lesson[]> {
  return invoke<Lesson[]>("split_lesson", { lessonId, segmentId, atTime });
}

// Merges `secondId` into `firstId` (both must belong to the same video);
// returns the merged row. `secondId`'s row is deleted.
export async function mergeLessons(firstId: string, secondId: string): Promise<Lesson> {
  return invoke<Lesson>("merge_lessons", { firstId, secondId });
}

// A lesson's segments (PRD §8.1/§9, `0006_lesson_segments.sql`) — a lesson
// is built from one or more, possibly overlapping and non-contiguous,
// segments of its source video. `lessons.start`/`.end` remain a read-only
// cached bound (min/max across these) kept in sync by Rust after every
// segment write; see `coursecut-data-model`.
export interface LessonSegment {
  id: string;
  lesson_id: string;
  start: number;
  end: number;
  sort_order: number;
}

// Result of `deleteLessonSegment`: deleting a lesson's last remaining
// segment deletes the lesson itself rather than leaving it with stale
// cached bounds — `lesson_deleted` tells the caller which happened.
export interface DeleteLessonSegmentResult {
  lesson_id: string;
  lesson_deleted: boolean;
}

// Read-only listing of a lesson's segments, in playback (`sort_order`) order.
export async function listLessonSegments(lessonId: string): Promise<LessonSegment[]> {
  return invoke<LessonSegment[]>("list_lesson_segments", { lessonId });
}

// Appends a new segment to `lessonId` (always added last); the parent
// lesson's cached `start`/`end` bound is recomputed on the Rust side. No
// overlap validation, by design — see `docs/lesson-segments-plan.md`.
export async function addLessonSegment(lessonId: string, start: number, end: number): Promise<LessonSegment> {
  return invoke<LessonSegment>("add_lesson_segment", { lessonId, start, end });
}

// Updates a segment's `start`/`end`; the parent lesson's cached bound is
// recomputed on the Rust side. Same no-overlap stance as `addLessonSegment`.
export async function updateLessonSegment(id: string, start: number, end: number): Promise<LessonSegment> {
  return invoke<LessonSegment>("update_lesson_segment", { id, start, end });
}

// Deletes a segment. If it was the lesson's only segment, the lesson itself
// is deleted instead (see `DeleteLessonSegmentResult`).
export async function deleteLessonSegment(id: string): Promise<DeleteLessonSegmentResult> {
  return invoke<DeleteLessonSegmentResult>("delete_lesson_segment", { id });
}

// Sets `sort_order` to each id's position in `orderedIds` — must be exactly
// the lesson's current set of segment ids (Rust rejects a partial/mismatched
// list rather than silently applying it). Doesn't change any segment's own
// start/end, only playback sequence.
export async function reorderLessonSegments(lessonId: string, orderedIds: string[]): Promise<void> {
  await invoke("reorder_lesson_segments", { lessonId, orderedIds });
}

export async function deleteLesson(id: string): Promise<void> {
  await invoke("delete_lesson", { id });
}

// Sets `sort_order` to each id's position in `orderedIds` — must be exactly
// the video's current set of lesson ids (Rust rejects a partial/mismatched
// list rather than silently applying it).
export async function reorderLessons(videoId: string, orderedIds: string[]): Promise<void> {
  await invoke("reorder_lessons", { videoId, orderedIds });
}

export async function deleteProject(id: string): Promise<void> {
  // Cascade delete of videos/lessons/etc. is handled by the schema's
  // ON DELETE CASCADE (see 0001_init.sql) — no app-level cascade needed.
  await invoke("delete_project", { id });
}

export async function deleteVideo(id: string): Promise<void> {
  // Cascade delete of transcript segments/lessons is handled by the
  // schema's ON DELETE CASCADE (see 0001_init.sql) — no app-level cascade
  // needed. Note: this does not remove the cached extracted-audio WAV file
  // from disk, since it's content-hash-keyed and may be shared with other
  // videos.
  await invoke("delete_video", { id });
}

// The OpenAI API key is BYOK (bring your own key) and lives in the OS
// keychain, never in SQLite — see `src-tauri/src/settings.rs`.

export interface KeyStatus {
  present: boolean;
  last_four: string | null;
}

export interface KeyTestResult {
  valid: boolean;
  message: string;
}

export async function saveOpenAiKey(key: string): Promise<void> {
  await invoke("save_openai_key", { key });
}

export async function getOpenAiKeyStatus(): Promise<KeyStatus> {
  return invoke<KeyStatus>("get_openai_key_status");
}

export async function testOpenAiKey(): Promise<KeyTestResult> {
  return invoke<KeyTestResult>("test_openai_key");
}

// Free-text user preferences (PRD §7.5) appended to the GPT-5.5 analysis
// prompt in `analyze_video` — not a secret, so this lives in SQLite's
// `app_settings` table (see `src-tauri/src/app_settings.rs`), unlike the
// API key above.
export async function saveAnalysisInstructions(instructions: string): Promise<void> {
  await invoke("save_analysis_instructions", { instructions });
}

export async function getAnalysisInstructions(): Promise<string | null> {
  return invoke<string | null>("get_analysis_instructions");
}

// Export queue (PRD §10-11, Milestone 7) — see `src-tauri/src/export.rs`.
// Purely local: cuts each of a lesson's `lesson_segments` from its
// already-imported source video into frame-accurately re-encoded clips and
// (for a multi-segment lesson) concatenates them into a single output MP4,
// run one at a time by a single app-wide background worker. Never uploads
// anything — see `coursecut-privacy-invariants`.

export interface ExportRow {
  id: string;
  lesson_id: string;
  output_path: string;
  // One of "queued" | "paused" | "running" | "done" | "failed" | "cancelled".
  status: string;
  created_at: string;
  // Fraction in [0, 1] of the lesson's own duration, updated while running.
  progress: number;
  // Set only when status === "failed".
  error: string | null;
  // Lesson/video ancestry, joined in by `list_exports` (see
  // `src-tauri/src/export.rs`) for Export History (PRD §11). Present on
  // every row `listExports` returns; other export commands (queue/pause/
  // resume/cancel/retry) return these as empty-string/zero placeholders
  // since their callers always re-fetch via `listExports` afterward rather
  // than rendering their return value directly — don't rely on these four
  // fields outside of a `listExports` result.
  lesson_title: string;
  lesson_start: number;
  lesson_end: number;
  video_file_path: string;
}

// Inserts one `queued` export row per lesson id, with an output filename
// derived from each lesson's title under `outputDir` (collision-checked so
// two lessons with the same/similar titles don't clobber each other).
// Actual encoding happens later, one at a time, in Rust's background
// worker — this only queues the work.
export async function queueExport(lessonIds: string[], outputDir: string): Promise<ExportRow[]> {
  return invoke<ExportRow[]>("queue_export", { lessonIds, outputDir });
}

// Scoped semantics (see `src-tauri/src/export.rs`'s module docs): pause/
// resume only ever apply to a job that hasn't started encoding yet
// (`queued` <-> `paused`). Calling either on a `running` export is
// rejected with a clear error rather than attempting to suspend a live
// ffmpeg process — not realistically portable across macOS/Windows.
export async function pauseExport(id: string): Promise<ExportRow> {
  return invoke<ExportRow>("pause_export", { id });
}

export async function resumeExport(id: string): Promise<ExportRow> {
  return invoke<ExportRow>("resume_export", { id });
}

// For a queued/paused job this just marks it cancelled. For a running job
// this actually kills the in-flight ffmpeg process.
export async function cancelExport(id: string): Promise<ExportRow> {
  return invoke<ExportRow>("cancel_export", { id });
}

// Resets a failed/cancelled job back to `queued` (clearing progress/error)
// so the background worker picks it up again.
export async function retryExport(id: string): Promise<ExportRow> {
  return invoke<ExportRow>("retry_export", { id });
}

// Read-only, project-scoped listing (joined through lessons -> videos),
// newest first. The editor filters this down to just the current video's
// lessons client-side.
export async function listExports(projectId: string): Promise<ExportRow[]> {
  return invoke<ExportRow[]>("list_exports", { projectId });
}

// Reveals an exported file in Finder (macOS) or Explorer (Windows).
export async function revealInFolder(path: string): Promise<void> {
  return invoke<void>("reveal_in_folder", { path });
}
