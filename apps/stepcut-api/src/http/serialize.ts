// Database rows → the JSON shapes `apps/stepcut`'s frontend consumes.
//
// Copied in spirit from apps/api/src/http/serialize.ts: snake_case on the
// wire, dates as ISO-8601 strings. Unlike that file, there is no field-name
// rename to undo here (`storage_key` goes out as `storage_key`, not
// `file_path`) — StepCut has no desktop counterpart to stay wire-compatible
// with, so there is no legacy field-name debt to honour.

import type { InferSelectModel } from "drizzle-orm";
import type {
  jobs as jobsTable,
  steps as stepsTable,
  transcriptSegments as transcriptSegmentsTable,
  videos as videosTable,
} from "../db/schema.js";

type VideoRow = InferSelectModel<typeof videosTable>;
type TranscriptSegmentRow = InferSelectModel<typeof transcriptSegmentsTable>;
type JobRow = InferSelectModel<typeof jobsTable>;
type StepRow = InferSelectModel<typeof stepsTable>;

const iso = (value: Date) => value.toISOString();

export function video(row: VideoRow) {
  return {
    id: row.id,
    storage_key: row.storageKey,
    upload_status: row.uploadStatus,
    duration: row.duration,
    transcript_status: row.transcriptStatus,
    size_bytes: row.sizeBytes,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export function transcriptSegment(row: TranscriptSegmentRow) {
  return {
    id: row.id,
    video_id: row.videoId,
    start: row.start,
    end: row.end,
    text: row.text,
  };
}

export function job(row: JobRow) {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    video_id: row.videoId,
    attempt: row.attempt,
    progress: row.progress,
    detail: row.detail,
    error: row.error,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export function step(row: StepRow) {
  return {
    id: row.id,
    video_id: row.videoId,
    sort_order: row.sortOrder,
    start: row.start,
    end: row.end,
    title: row.title,
    summary: row.summary,
    source: row.source,
    confidence: row.confidence,
    updated_at: iso(row.updatedAt),
  };
}
