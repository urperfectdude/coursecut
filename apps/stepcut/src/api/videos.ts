// Typed wrappers over `apps/stepcut-api`'s Phase 2 video routes
// (docs/stepcut-plan.md §8: "Upload & transcript").
//
// Modeled on apps/web/src/db.ts's `importVideos` (the presigned-upload
// technique is the same one plan §1 calls out as copied, not shared), but
// original to apps/stepcut rather than a port: this app has no desktop
// counterpart, so there is no existing `db.ts` shape to stay compatible
// with. `uploadVideo` does more than that reference's `importVideos` on
// purpose — it also queues extraction once the upload lands, so the whole
// pipeline (upload → extract → transcribe) runs from one user gesture, per
// the plan's "one upload button" requirement for this phase's dashboard.

import { putPart, putToStorage, request } from "./http";

export interface Video {
  id: string;
  project_id: string;
  storage_key: string;
  upload_status: string;
  duration: number | null;
  transcript_status: string;
  size_bytes: number | null;
  created_at: string;
  updated_at: string;
}

export interface TranscriptSegment {
  id: string;
  video_id: string;
  start: number;
  end: number;
  text: string;
}

/** A proposed (or, from Phase 4 on, edited) step. */
export interface Step {
  id: string;
  video_id: string;
  sort_order: number;
  start: number;
  end: number;
  title: string;
  summary: string | null;
  source: string;
  confidence: number | null;
  updated_at: string;
}

export interface Job {
  id: string;
  kind: string;
  state: string;
  video_id: string | null;
  attempt: number;
  progress: number | null;
  detail: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

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

/** How many parts are in flight at once — enough to keep a fast connection
 * busy, few enough that a failure costs at most this many parts' worth of
 * retry. Same value apps/web's uploader uses. */
const PART_CONCURRENCY = 3;

export function listVideos(projectId: string): Promise<Video[]> {
  return request<Video[]>("GET", `/videos?project_id=${encodeURIComponent(projectId)}`);
}

export function getVideo(id: string): Promise<Video> {
  return request<Video>("GET", `/videos/${id}`);
}

export function getTranscript(id: string): Promise<TranscriptSegment[]> {
  return request<TranscriptSegment[]>("GET", `/videos/${id}/transcript`);
}

export function getSteps(id: string): Promise<Step[]> {
  return request<Step[]>("GET", `/videos/${id}/steps`);
}

/** Most recent first — a polling caller reads `jobs[0]` for `kind === "analyze"`. */
export function getJobs(id: string): Promise<Job[]> {
  return request<Job[]>("GET", `/videos/${id}/jobs`);
}

/**
 * Queues step analysis. Returns the video's steps as they stand now (empty,
 * for a fresh analysis) — the caller should poll `getJobs`/`getSteps` rather
 * than treat this response as the finished result.
 */
export function analyzeVideo(videoId: string): Promise<Step[]> {
  return request<Step[]>("POST", `/videos/${videoId}/analyze`);
}

function createUploadTicket(
  projectId: string,
  filename: string,
  size: number,
  contentType: string,
): Promise<UploadTicket> {
  return request<UploadTicket>("POST", "/videos/uploads", {
    project_id: projectId,
    filename,
    size,
    content_type: contentType,
  });
}

function extractVideo(videoId: string): Promise<Video> {
  return request<Video>("POST", `/videos/${videoId}/extract`);
}

export function transcribeVideo(videoId: string): Promise<Video> {
  return request<Video>("POST", `/videos/${videoId}/transcribe`);
}

export function deleteVideo(id: string): Promise<void> {
  return request<void>("DELETE", `/videos/${id}`);
}

/** A short-TTL presigned GET for a video's source object — what `useVideoSrc`
 * feeds an HTML `<video>`. Never a permanently public URL (plan §6). */
export function getPlaybackUrl(storageKey: string): Promise<string> {
  return request<{ url: string }>("POST", "/videos/playback-url", { storage_key: storageKey }).then(
    (res) => res.url,
  );
}

// ---------------------------------------------------------------------------
// Steps: editing (Phase 4 — docs/stepcut-plan.md §8: "Manual editing")
// ---------------------------------------------------------------------------

/** Patches a step's boundary/title/summary. Any call here flips `source` to
 * `"manual"` server-side — see `apps/stepcut-api/src/domain/steps.ts`. */
export function updateStep(
  id: string,
  patch: { start?: number; end?: number; title?: string; summary?: string },
): Promise<Step> {
  return request<Step>("PATCH", `/steps/${id}`, patch);
}

/** Splits a step at `at` (seconds, strictly inside its current range) into
 * two manual steps. Returns both, original first. */
export function splitStep(id: string, at: number): Promise<Step[]> {
  return request<Step[]>("POST", `/steps/${id}/split`, { at });
}

export function deleteStep(id: string): Promise<void> {
  return request<void>("DELETE", `/steps/${id}`);
}

/** A proposed step from a free-text AI edit — same shape a real `Step` uses
 * for the fields the model can propose, minus the ones only a persisted row
 * has (`id`, `source`, `confidence`, ...). */
export interface StepEdit {
  start: number;
  end: number;
  title: string;
  summary: string;
}

/**
 * Proposes a revised step list for `videoId`, per `instruction`. Writes
 * nothing — see `apps/stepcut-api/src/routes/steps.ts`'s `.../edit/preview`.
 *
 * `baseline` is omitted for the prompt box's first submission (the video's
 * current steps are the baseline); pass the previous, not-yet-applied
 * proposal when refining inside the review dialog.
 */
export function previewStepsEdit(
  videoId: string,
  instruction: string,
  baseline?: StepEdit[],
): Promise<StepEdit[]> {
  return request<StepEdit[]>("POST", `/videos/${videoId}/steps/edit/preview`, {
    instruction,
    baseline,
  });
}

/** Replaces `videoId`'s entire step list with `steps` — the Apply half of
 * the AI edit dialog. Every resulting row lands `source = "manual"`. */
export function applyStepsEdit(videoId: string, steps: StepEdit[]): Promise<Step[]> {
  return request<Step[]>("POST", `/videos/${videoId}/steps/edit/apply`, { steps });
}

/** Adds a manual step to a video. */
export function addStep(
  videoId: string,
  input: { start: number; end: number; title: string; summary?: string },
): Promise<Step> {
  return request<Step>("POST", `/videos/${videoId}/steps`, input);
}

/**
 * Uploads `file`'s parts and returns the (part number, ETag) list the
 * completion call needs. Part URLs are signed a batch at a time rather than
 * all at once — signatures are short-lived, and a large upload over a slow
 * line would outlive URLs minted at the start.
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
        const start = (part_number - 1) * upload.part_size;
        const chunk = file.slice(start, Math.min(start + upload.part_size, file.size));
        return { part_number, etag: await putPart(url, chunk) };
      }),
    );
    uploaded.push(...results);
  }

  return uploaded;
}

/**
 * Uploads `file` (single-shot or multipart, whichever the API's ticket
 * says), completes the upload, and immediately queues extraction — so a
 * dashboard's "upload" button is one call that runs the whole pipeline up to
 * "waiting for the worker" rather than three separate steps a caller has to
 * remember to chain.
 *
 * Both branches now abort-on-failure (`/upload/abort` flips the row to
 * `failed` even with no `upload_id` — `routes/videos.ts` only uses it to
 * clean up multipart parts, which single-shot has none of). Before this, a
 * single-shot failure between the PUT and `/complete` left its row stuck at
 * `upload_status: "pending"` forever: `statusLabel` reads that as
 * "Uploading" indefinitely, with only Delete available — the permanently
 * stuck ghost tile a re-attempted upload was leaving behind.
 */
export async function uploadVideo(projectId: string, file: File): Promise<Video> {
  const contentType = file.type || "application/octet-stream";
  const ticket = await createUploadTicket(projectId, file.name, file.size, contentType);

  if (ticket.upload.mode === "single") {
    try {
      await putToStorage(ticket.upload.url, file, contentType);
      await request<Video>("POST", `/videos/${ticket.video_id}/complete`, {});
    } catch (err) {
      await request("POST", `/videos/${ticket.video_id}/upload/abort`, {}).catch(() => undefined);
      throw err;
    }
    return extractVideo(ticket.video_id);
  }

  const upload = ticket.upload;
  try {
    const parts = await uploadParts(ticket.video_id, upload, file);
    await request<Video>("POST", `/videos/${ticket.video_id}/complete`, {
      upload_id: upload.upload_id,
      parts,
    });
    return extractVideo(ticket.video_id);
  } catch (err) {
    // Abandoned parts are billed until they are cleaned up, so a failed
    // upload tells storage to forget them. Best-effort: the original failure
    // is what the caller needs to see.
    await request("POST", `/videos/${ticket.video_id}/upload/abort`, {
      upload_id: upload.upload_id,
    }).catch(() => undefined);
    throw err;
  }
}
