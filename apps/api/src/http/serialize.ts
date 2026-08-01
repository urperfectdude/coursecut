// Database rows → the JSON shapes `apps/web/src/db.ts` declares.
//
// This is the translation layer that keeps the copied views compiling without
// edits, and it does exactly three things:
//
//   * **snake_case on the wire.** Drizzle rows are camelCase because that is
//     how TypeScript reads; `db.ts`'s interfaces are snake_case because that
//     is what desktop's Rust structs serialize to. The views are copied from
//     desktop, so the wire follows desktop.
//   * **Dates as ISO-8601 strings.** Desktop stores strings because SQLite has
//     no date type; Postgres has one, and this is where that difference stops
//     (schema.ts's header makes the same promise).
//   * **The two storage renames, undone.** `storage_key` → `file_path` and
//     `output_key` → `output_path`. The rename is a storage-model fact and
//     never a UI one — plan §6 renames the columns, D2/D5 keep the field names
//     the views already use. `db.ts`'s own comments spell out that the value
//     is a key rather than a path.
//
// Nothing here invents a field the desktop app does not have, and nothing
// drops one it does. A response that needs a web-only field is a sign the
// change belongs in `apps/web/src/auth/`, not in a copied view.

import type { InferSelectModel } from "drizzle-orm";
import type {
  exports as exportsTable,
  lessonSegments as lessonSegmentsTable,
  lessons as lessonsTable,
  projects as projectsTable,
  transcriptSegments as transcriptSegmentsTable,
  videos as videosTable,
} from "../db/schema.js";

type ProjectRow = InferSelectModel<typeof projectsTable>;
type VideoRow = InferSelectModel<typeof videosTable>;
type TranscriptSegmentRow = InferSelectModel<typeof transcriptSegmentsTable>;
type LessonRow = InferSelectModel<typeof lessonsTable>;
type LessonSegmentRow = InferSelectModel<typeof lessonSegmentsTable>;
type ExportRow = InferSelectModel<typeof exportsTable>;

const iso = (value: Date) => value.toISOString();

export function project(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export function video(row: VideoRow) {
  return {
    id: row.id,
    project_id: row.projectId,
    // D2: the R2 object key, under desktop's field name.
    file_path: row.storageKey,
    duration: row.duration,
    transcript_status: row.transcriptStatus,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
    audio_path: row.audioKey,
  };
}

export function transcriptSegment(row: TranscriptSegmentRow) {
  return {
    id: row.id,
    video_id: row.videoId,
    start: row.start,
    end: row.end,
    text: row.text,
    keep: row.keep,
  };
}

export function lesson(row: LessonRow) {
  return {
    id: row.id,
    video_id: row.videoId,
    title: row.title,
    summary: row.summary,
    start: row.start,
    end: row.end,
    sort_order: row.sortOrder,
    confidence: row.confidence,
    kind: row.kind,
    source: row.source,
  };
}

export function lessonSegment(row: LessonSegmentRow) {
  return {
    id: row.id,
    lesson_id: row.lessonId,
    start: row.start,
    end: row.end,
    sort_order: row.sortOrder,
  };
}

/**
 * The lesson/video ancestry Export History renders. `db.ts` documents these
 * four as present on every `listExports` row and as placeholders elsewhere,
 * so the placeholder branch is spelled out rather than left to `undefined` —
 * a missing key would serialize as absent and break the declared type.
 */
export interface ExportAncestry {
  lesson_title: string;
  lesson_start: number;
  lesson_end: number;
  video_file_path: string;
}

export const NO_ANCESTRY: ExportAncestry = {
  lesson_title: "",
  lesson_start: 0,
  lesson_end: 0,
  video_file_path: "",
};

export function exportRow(row: ExportRow, ancestry: ExportAncestry = NO_ANCESTRY) {
  return {
    id: row.id,
    lesson_id: row.lessonId,
    // D5: the output object key, under desktop's field name.
    output_path: row.outputKey,
    status: row.status,
    created_at: iso(row.createdAt),
    progress: row.progress,
    error: row.error,
    ...ancestry,
  };
}
