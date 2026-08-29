// Videos: upload, the pipeline enqueue calls, and reads (Phase 2 —
// docs/stepcut-plan.md §8).
//
// Own copy of apps/api/src/routes/videos.ts's upload/complete/extract/
// transcribe shapes, trimmed to what Phase 2 needs. The differences from
// that reference, all deliberate:
//
//   * **No `projects` parent.** StepCut's `videos` belong directly to an org
//     (plan §3 has no `projects` table), so routes are `/videos/uploads`, not
//     `/projects/:id/uploads`.
//   * **Mounted under `/api` directly, not `/v1`.** The plan's §4 API surface
//     sketch uses `/v1/...` for the *eventual public API surface*; Phase 1's
//     `app.ts` already mounts everything at `/api`, so these routes stay
//     consistent with what is actually deployed rather than pre-empting a
//     versioning decision nothing else here has made yet.
//   * **No quota checks.** `assertCanUpload`/`assertCanTranscribe`/
//     `assertCanQueueJob` don't exist in StepCut yet — Phase 6 territory. The
//     only refusal Phase 2 has is the upload-completion `headObject`
//     re-check that the object actually landed in storage.
//   * **No `/videos/:id/analyze` or `/videos/:id/lessons`.** `analyze` and
//     `steps` are Phase 3.
//   * **A `GET /videos` list route**, not in the plan's §4 sketch but needed
//     for a usable dashboard and cheap to add.
//
// The upload-row-exists-before-the-bytes-do rationale, the presigned-PUT vs.
// multipart threshold, and the re-check-after-upload discipline are all
// unchanged from the coursecut original — see that file's header for the
// fuller account of why each exists.

import { Hono } from "hono";
import { asc, desc, eq } from "drizzle-orm";
import { param, tx, type AppEnv } from "../http/context.js";
import { badRequest, notFound } from "../http/errors.js";
import * as serialize from "../http/serialize.js";
import { transcriptSegments, videos } from "../db/schema.js";
import { cancelJobsForVideo, enqueueVideoJob } from "../jobs/queue.js";
import * as storage from "../storage.js";
import type { Tx } from "../db/client.js";

export const videoRoutes = new Hono<AppEnv>();

const newId = () => crypto.randomUUID();

async function requireVideoRow(t: Tx, id: string) {
  const [row] = await t.select().from(videos).where(eq(videos.id, id)).limit(1);
  if (!row) throw notFound("video");
  return row;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Mints the row and the upload ticket. One call per file, before any bytes
 * move.
 *
 * The response tells the client which of the two upload shapes to use,
 * rather than letting it decide: the threshold is a storage-side fact and
 * belongs next to the storage module, not in the browser.
 */
videoRoutes.post("/videos/uploads", async (c) => {
  const body = await c.req.json<{ filename?: string; size?: number; content_type?: string }>();
  const filename = (body.filename ?? "").trim();
  if (filename.length === 0) throw badRequest("filename is required");
  const size = Number(body.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) throw badRequest("size must be a positive number");
  const contentType = body.content_type || "application/octet-stream";

  const orgId = c.get("orgId");
  const videoId = newId();
  const key = storage.videoKey(orgId, videoId, filename);

  await tx(c, (t) =>
    t.insert(videos).values({
      id: videoId,
      orgId,
      storageKey: key,
      uploadStatus: "pending",
    }),
  );

  if (size <= storage.MULTIPART_THRESHOLD) {
    return c.json({
      video_id: videoId,
      storage_key: key,
      upload: { mode: "single" as const, url: await storage.presignPut(key, contentType) },
    });
  }

  const uploadId = await storage.createMultipartUpload(key, contentType);
  return c.json({
    video_id: videoId,
    storage_key: key,
    upload: {
      mode: "multipart" as const,
      upload_id: uploadId,
      part_size: storage.PART_SIZE,
      part_count: storage.partCount(size),
    },
  });
});

/**
 * Signs a batch of part URLs.
 *
 * On demand rather than all up front, so a long upload cannot outlive its
 * signatures — the retry of a single failed part also gets a fresh
 * signature for free.
 */
videoRoutes.post("/videos/:id/upload/part-urls", async (c) => {
  const body = await c.req.json<{ upload_id?: string; part_numbers?: number[] }>();
  const uploadId = body.upload_id;
  const partNumbers = body.part_numbers ?? [];
  if (!uploadId) throw badRequest("upload_id is required");
  if (partNumbers.length === 0) throw badRequest("part_numbers must not be empty");

  const video = await tx(c, (t) => requireVideoRow(t, param(c, "id")));
  const urls = await Promise.all(
    partNumbers.map(async (partNumber) => ({
      part_number: partNumber,
      url: await storage.presignUploadPart(video.storageKey, uploadId, partNumber),
    })),
  );
  return c.json({ urls });
});

/**
 * Finishes the upload: assembles the parts if there were any, confirms the
 * object is really there, and flips the row to `uploaded`.
 *
 * `duration` stays null — the extract job fills it in via ffprobe.
 */
videoRoutes.post("/videos/:id/complete", async (c) => {
  const id = param(c, "id");
  const body = await c.req
    .json<{ upload_id?: string; parts?: Array<{ part_number: number; etag: string }> }>()
    .catch(() => ({}) as { upload_id?: string; parts?: Array<{ part_number: number; etag: string }> });

  const video = await tx(c, (t) => requireVideoRow(t, id));

  if (body.upload_id) {
    await storage.completeMultipartUpload(
      video.storageKey,
      body.upload_id,
      (body.parts ?? []).map((part) => ({ partNumber: part.part_number, etag: part.etag })),
    );
  }

  const head = await storage.headObject(video.storageKey);
  if (!head) {
    // The row stays `pending` and the client can retry the upload against
    // the same row rather than orphaning it.
    throw badRequest("the upload did not arrive in storage");
  }

  const [row] = await tx(c, (t) =>
    t
      .update(videos)
      .set({ uploadStatus: "uploaded", sizeBytes: head.size, updatedAt: new Date() })
      .where(eq(videos.id, id))
      .returning(),
  );
  return c.json(serialize.video(row));
});

/** Gives up on an upload, so its parts stop being billed. */
videoRoutes.post("/videos/:id/upload/abort", async (c) => {
  const body = await c.req.json<{ upload_id?: string }>();
  const video = await tx(c, (t) => requireVideoRow(t, param(c, "id")));
  if (body.upload_id) await storage.abortMultipartUpload(video.storageKey, body.upload_id);
  await tx(c, (t) =>
    t.update(videos).set({ uploadStatus: "failed", updatedAt: new Date() }).where(eq(videos.id, video.id)),
  );
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The org's videos, newest first — the dashboard's list. */
videoRoutes.get("/videos", async (c) => {
  const rows = await tx(c, (t) => t.select().from(videos).orderBy(desc(videos.createdAt)));
  return c.json(rows.map(serialize.video));
});

videoRoutes.get("/videos/:id", async (c) => {
  const row = await tx(c, (t) => requireVideoRow(t, param(c, "id")));
  return c.json(serialize.video(row));
});

videoRoutes.get("/videos/:id/transcript", async (c) => {
  const id = param(c, "id");
  const rows = await tx(c, async (t) => {
    await requireVideoRow(t, id);
    return t
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.videoId, id))
      .orderBy(asc(transcriptSegments.start), asc(transcriptSegments.id));
  });
  return c.json(rows.map(serialize.transcriptSegment));
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function attemptOf(body: { attempt?: number }): number {
  const attempt = Number(body.attempt ?? 1);
  return Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
}

/**
 * Queues audio extraction.
 *
 * A successful extract chains to transcription itself, in the worker — see
 * `apps/stepcut-worker/src/tasks/video.ts` — so nothing here does that
 * chaining.
 */
videoRoutes.post("/videos/:id/extract", async (c) => {
  const id = param(c, "id");
  const attempt = attemptOf(await c.req.json<{ attempt?: number }>().catch(() => ({})));

  const row = await tx(c, async (t) => {
    const video = await requireVideoRow(t, id);
    if (video.uploadStatus !== "uploaded") {
      throw badRequest("this video has not finished uploading yet");
    }
    await enqueueVideoJob(t, c.get("orgId"), "extract", id, attempt);
    return video;
  });
  return c.json(serialize.video(row));
});

/**
 * Queues transcription directly — a manual retry without re-extracting. As
 * on extract, only the **extracted audio** ever reaches OpenAI, never the
 * source video.
 */
videoRoutes.post("/videos/:id/transcribe", async (c) => {
  const id = param(c, "id");
  const attempt = attemptOf(await c.req.json<{ attempt?: number }>().catch(() => ({})));

  const row = await tx(c, async (t) => {
    const video = await requireVideoRow(t, id);
    await enqueueVideoJob(t, c.get("orgId"), "transcribe", id, attempt);
    return video;
  });
  return c.json(serialize.video(row));
});

videoRoutes.delete("/videos/:id", async (c) => {
  const id = param(c, "id");

  const removed = await tx(c, async (t) => {
    const video = await requireVideoRow(t, id);
    // Nothing should be queued against a row that is about to stop existing.
    await cancelJobsForVideo(t, id);
    // transcript_segments and jobs go via ON DELETE CASCADE.
    await t.delete(videos).where(eq(videos.id, id));
    return video;
  });

  // Post-commit and best-effort: the source object is this video's alone,
  // under its own `stepcut/{org}/{video}/` prefix.
  await storage.deletePrefix(storage.videoPrefix(removed.orgId, removed.id));

  return c.body(null, 204);
});
