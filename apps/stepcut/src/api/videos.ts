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

export function listVideos(): Promise<Video[]> {
  return request<Video[]>("GET", "/videos");
}

export function getVideo(id: string): Promise<Video> {
  return request<Video>("GET", `/videos/${id}`);
}

export function getTranscript(id: string): Promise<TranscriptSegment[]> {
  return request<TranscriptSegment[]>("GET", `/videos/${id}/transcript`);
}

function createUploadTicket(filename: string, size: number, contentType: string): Promise<UploadTicket> {
  return request<UploadTicket>("POST", "/videos/uploads", {
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
 */
export async function uploadVideo(file: File): Promise<Video> {
  const contentType = file.type || "application/octet-stream";
  const ticket = await createUploadTicket(file.name, file.size, contentType);

  if (ticket.upload.mode === "single") {
    await putToStorage(ticket.upload.url, file, contentType);
    await request<Video>("POST", `/videos/${ticket.video_id}/complete`, {});
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
