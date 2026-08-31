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
  projects as projectsTable,
  renders as rendersTable,
  steps as stepsTable,
  templates as templatesTable,
  transcriptSegments as transcriptSegmentsTable,
  videos as videosTable,
} from "../db/schema.js";

type ProjectRow = InferSelectModel<typeof projectsTable>;
type VideoRow = InferSelectModel<typeof videosTable>;
type TranscriptSegmentRow = InferSelectModel<typeof transcriptSegmentsTable>;
type JobRow = InferSelectModel<typeof jobsTable>;
type StepRow = InferSelectModel<typeof stepsTable>;
type TemplateRow = InferSelectModel<typeof templatesTable>;
type RenderRow = InferSelectModel<typeof rendersTable>;

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

/**
 * `output_key`/`download_expires_at`/`webhook_last_error` stay off the wire —
 * internal bookkeeping the frontend doesn't need directly. `output_url` is
 * not here either: it requires an async presign call this file's other
 * functions don't make, so `routes/renders.ts`'s `GET /renders/:id` adds it
 * itself, spread over this function's result — same "always include, `null`
 * when absent" convention every other field on this row follows.
 */
export function render(row: RenderRow) {
  return {
    id: row.id,
    project_id: row.projectId,
    video_id: row.videoId,
    template_id: row.templateId,
    status: row.status,
    progress: row.progress,
    error: row.error,
    callback_url: row.callbackUrl,
    size_bytes: row.sizeBytes,
    webhook_status: row.webhookStatus,
    webhook_attempts: row.webhookAttempts,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export function template(row: TemplateRow) {
  return {
    id: row.id,
    project_id: row.projectId,
    name: row.name,
    intro_key: row.introKey,
    outro_key: row.outroKey,
    logo_key: row.logoKey,
    brand_primary_hex: row.brandPrimaryHex,
    brand_secondary_hex: row.brandSecondaryHex,
    target_width: row.targetWidth,
    target_height: row.targetHeight,
    target_fps: row.targetFps,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}
