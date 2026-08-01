// Videos: upload (D1), playback (D2) and the pipeline enqueue calls (D3).
//
// Three of the plan's forced deviations land in this one file, so it is worth
// being explicit about which line is which.
//
// **D1 — upload.** Desktop takes filesystem paths from a native dialog and
// leaves the files where they are. A browser has neither, so a `videos` row is
// created first, in `upload_status = 'pending'`, and the browser then PUTs the
// bytes **straight to storage** with a presigned URL. The API never sees a
// byte of video (plan §3.2) — proxying multi-GB lectures through the droplet
// would burn its bandwidth and RAM for nothing. Above 64 MiB the upload is
// split into parts, which is what makes a multi-GB file possible at all: a
// one-shot PUT restarts from zero on any network blip, and S3 caps it anyway.
//
// The row existing before the bytes do is deliberate. A browser that dies
// mid-upload leaves a `pending` row to garbage-collect rather than an object
// with nothing pointing at it.
//
// **D2 — playback.** Desktop calls `convertFileSrc` on a local path. Here the
// API mints a short-TTL presigned GET, and it does so by *looking the key up*
// in the caller's own rows rather than signing whatever string it is handed.
// Under RLS another tenant's key matches no row, so the answer is 404.
//
// **D3 — the pipeline.** Desktop runs ffmpeg and the OpenAI calls inline and
// returns when they finish. Here each call writes a job row and returns
// immediately; completion arrives on the progress stream. See `jobs/queue.ts`.

import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { tx, type AppEnv } from "../http/context.js";
import { badRequest, notFound } from "../http/errors.js";
import { newId } from "../domain/lessons.js";
import * as serialize from "../http/serialize.js";
import { lessons, projects, videos } from "../db/schema.js";
import { cancelJobsForVideo, enqueueVideoJob } from "../jobs/queue.js";
import { assertCanQueueJob, assertCanTranscribe, assertCanUpload } from "../quota.js";
import * as storage from "../storage.js";
import type { Tx } from "../db/client.js";

export const videoRoutes = new Hono<AppEnv>();

async function requireVideoRow(t: Tx, id: string) {
  const [row] = await t.select().from(videos).where(eq(videos.id, id)).limit(1);
  if (!row) throw notFound("video");
  return row;
}

// ---------------------------------------------------------------------------
// Upload (D1)
// ---------------------------------------------------------------------------

/**
 * Mints the row and the upload ticket. One call per file, before any bytes
 * move.
 *
 * The response tells the client which of the two upload shapes to use, rather
 * than letting it decide: the threshold is a storage-side fact and belongs
 * next to the storage module, not in the browser.
 */
videoRoutes.post("/projects/:id/uploads", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json<{ filename?: string; size?: number; content_type?: string }>();
  const filename = (body.filename ?? "").trim();
  if (filename.length === 0) throw badRequest("filename is required");
  const size = Number(body.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) throw badRequest("size must be a positive number");
  const contentType = body.content_type || "application/octet-stream";

  const orgId = c.get("orgId");
  const videoId = newId();
  const key = storage.videoKey(orgId, projectId, videoId, filename);

  await tx(c, async (t) => {
    const [project] = await t
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw notFound("project");

    // M7: refused here, before a single byte moves and before an upload id
    // exists. The browser sends the size it is about to upload, and it is the
    // only place the size is known in advance — after this the next chance to
    // refuse is a completed multi-gigabyte object we are already paying to
    // store.
    await assertCanUpload(t, orgId, size);

    await t.insert(videos).values({
      id: videoId,
      orgId,
      projectId,
      storageKey: key,
      uploadStatus: "pending",
    });
  });

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
 * signatures: a 20 GB file over a slow connection would otherwise be handed
 * URLs that expire halfway through, and the retry of a single failed part
 * gets a fresh signature for free.
 */
videoRoutes.post("/videos/:id/upload/part-urls", async (c) => {
  const body = await c.req.json<{ upload_id?: string; part_numbers?: number[] }>();
  const uploadId = body.upload_id;
  const partNumbers = body.part_numbers ?? [];
  if (!uploadId) throw badRequest("upload_id is required");
  if (partNumbers.length === 0) throw badRequest("part_numbers must not be empty");

  const video = await tx(c, (t) => requireVideoRow(t, c.req.param("id")));
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
 * `duration` stays null. Desktop probes it with ffprobe, which this process
 * does not have and should not grow — the extract job fills it in at M5, and a
 * null duration is already the state the UI handles for a freshly imported
 * video.
 */
videoRoutes.post("/videos/:id/complete", async (c) => {
  const id = c.req.param("id");
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
    // The row stays `pending` and the client can retry the upload against the
    // same row rather than orphaning it.
    throw badRequest("the upload did not arrive in storage");
  }

  // M7: the size the ticket was issued against was the browser's claim; this
  // is the object that actually arrived. Re-checking here is what makes the
  // upload quota an enforcement rather than an honour system — a client that
  // asked for a 10 MB ticket and PUT 10 GB is refused now, and the object goes
  // with the refusal so we are not storing what we just declined.
  //
  // Deliberately after the bytes rather than instead of the check above: this
  // one can only run once the upload is paid for, and refusing early is worth
  // far more than refusing accurately.
  const overrun = await tx(c, async (t) => {
    try {
      await assertCanUpload(t, video.orgId, head.size);
      return null;
    } catch (err) {
      return err;
    }
  });
  if (overrun) {
    await tx(c, (t) =>
      t.update(videos).set({ uploadStatus: "failed", updatedAt: new Date() }).where(eq(videos.id, id)),
    );
    await storage.deleteObject(video.storageKey).catch(() => undefined);
    throw overrun;
  }

  const [row] = await tx(c, (t) =>
    t
      .update(videos)
      // `size_bytes` is the storage meter (M7). Recorded from the head request
      // the completion already had to make, so the meter costs nothing.
      .set({ uploadStatus: "uploaded", sizeBytes: head.size, updatedAt: new Date() })
      .where(eq(videos.id, id))
      .returning(),
  );
  return c.json(serialize.video(row));
});

/** Gives up on an upload, so its parts stop being billed. */
videoRoutes.post("/videos/:id/upload/abort", async (c) => {
  const body = await c.req.json<{ upload_id?: string }>();
  const video = await tx(c, (t) => requireVideoRow(t, c.req.param("id")));
  if (body.upload_id) await storage.abortMultipartUpload(video.storageKey, body.upload_id);
  await tx(c, (t) =>
    t.update(videos).set({ uploadStatus: "failed", updatedAt: new Date() }).where(eq(videos.id, video.id)),
  );
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Playback (D2)
// ---------------------------------------------------------------------------
//
// Registered before `/videos/:id` so the literal path is never read as an id.

videoRoutes.post("/videos/playback-url", async (c) => {
  const body = await c.req.json<{ storage_key?: string }>();
  const key = body.storage_key;
  if (!key) throw badRequest("storage_key is required");

  // Resolved against the caller's own rows — never signed as given. This is
  // the whole security property of the endpoint: RLS means a key belonging to
  // another org matches nothing, so a guessed or leaked key is a 404 rather
  // than a signed URL.
  const [row] = await tx(c, (t) =>
    t.select({ id: videos.id }).from(videos).where(eq(videos.storageKey, key)).limit(1),
  );
  if (!row) throw notFound("video");

  return c.json({ url: await storage.presignGet(key) });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

videoRoutes.get("/videos/:id", async (c) => {
  const row = await tx(c, (t) => requireVideoRow(t, c.req.param("id")));
  return c.json(serialize.video(row));
});

videoRoutes.get("/videos/:id/lessons", async (c) => {
  const rows = await tx(c, (t) =>
    t
      .select()
      .from(lessons)
      .where(eq(lessons.videoId, c.req.param("id")))
      .orderBy(asc(lessons.sortOrder), asc(lessons.start)),
  );
  return c.json(rows.map(serialize.lesson));
});

// ---------------------------------------------------------------------------
// Pipeline (D3)
// ---------------------------------------------------------------------------

function attemptOf(body: { attempt?: number }): number {
  const attempt = Number(body.attempt ?? 1);
  return Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
}

/**
 * Queues audio extraction.
 *
 * Returns the video row unchanged apart from its status — `audio_path` is
 * still null, because nothing has run yet. That is a real difference from
 * desktop worth naming: `ProjectDetailView` chains extract → transcribe on
 * `audio_path` being set, and against a job queue that branch simply does not
 * fire. The chain moves server-side instead — the extract job queues
 * transcription on success (M5) — which is D3 working as intended rather than
 * a gap. The view is left alone; editing a copied view for a web-only reason
 * is what §7.1 forbids.
 */
videoRoutes.post("/videos/:id/extract", async (c) => {
  const id = c.req.param("id");
  const attempt = attemptOf(await c.req.json<{ attempt?: number }>().catch(() => ({})));

  const row = await tx(c, async (t) => {
    const video = await requireVideoRow(t, id);
    if (video.uploadStatus !== "uploaded") {
      throw badRequest("this video has not finished uploading yet");
    }
    // Extraction is the head of the chain — it queues transcription itself on
    // success (M5) — so the transcription quota is checked here rather than
    // one job later, where a refusal would be a failed row instead of a
    // sentence the user reads.
    await assertCanTranscribe(t, c.get("orgId"));
    await assertCanQueueJob(t, c.get("orgId"));
    await enqueueVideoJob(t, c.get("orgId"), "extract", id, attempt);
    return video;
  });
  return c.json(serialize.video(row));
});

/**
 * Queues transcription. As on desktop, only the **extracted audio** ever
 * reaches OpenAI — never the source video (plan §9). The content-hash cache
 * still applies but is scoped per-org, which the schema's unique index
 * enforces; a shared cache would tell one tenant that another holds the same
 * video.
 */
videoRoutes.post("/videos/:id/transcribe", async (c) => {
  const id = c.req.param("id");
  const attempt = attemptOf(await c.req.json<{ attempt?: number }>().catch(() => ({})));

  const row = await tx(c, async (t) => {
    const video = await requireVideoRow(t, id);
    await assertCanTranscribe(t, c.get("orgId"));
    await assertCanQueueJob(t, c.get("orgId"));
    await enqueueVideoJob(t, c.get("orgId"), "transcribe", id, attempt);
    return video;
  });
  return c.json(serialize.video(row));
});

/**
 * Queues lesson-boundary analysis. Only the transcript **text** goes to
 * GPT-5.5 — never audio, never video (plan §9).
 *
 * Returns the video's lessons as they stand now, which for a fresh analysis is
 * the empty list. Desktop returns the new lessons because it has them by the
 * time it returns; here the replacement happens in the worker and the UI
 * re-reads when the progress stream says analysis finished.
 */
videoRoutes.post("/videos/:id/analyze", async (c) => {
  const id = c.req.param("id");
  const attempt = attemptOf(await c.req.json<{ attempt?: number }>().catch(() => ({})));

  const rows = await tx(c, async (t) => {
    await requireVideoRow(t, id);
    // No transcription check: analysis reads a transcript that has already
    // been paid for, and its cost rides along with the minutes that produced
    // it (see `quota.ts`). The queue cap still applies, because a loop of
    // re-analyses is still a loop.
    await assertCanQueueJob(t, c.get("orgId"));
    await enqueueVideoJob(t, c.get("orgId"), "analyze", id, attempt);
    return t
      .select()
      .from(lessons)
      .where(eq(lessons.videoId, id))
      .orderBy(asc(lessons.sortOrder), asc(lessons.start));
  });
  return c.json(rows.map(serialize.lesson));
});

/**
 * Marks a video errored without an attempt having been made — desktop's
 * escape hatch for a frontend that short-circuits the pipeline itself. D7
 * removed its only caller (the missing-key pre-flight), but it stays because
 * `db.ts` mirrors desktop's surface and because any future client-side
 * refusal (a quota, say) needs a row Retry can pick up.
 */
videoRoutes.post("/videos/:id/error", async (c) => {
  const id = c.req.param("id");
  const updated = await tx(c, (t) =>
    t
      .update(videos)
      .set({ transcriptStatus: "error", updatedAt: new Date() })
      .where(eq(videos.id, id))
      .returning({ id: videos.id }),
  );
  if (updated.length === 0) throw notFound("video");
  return c.body(null, 204);
});

videoRoutes.delete("/videos/:id", async (c) => {
  const id = c.req.param("id");

  const removed = await tx(c, async (t) => {
    const video = await requireVideoRow(t, id);
    // Nothing should be queued against a row that is about to stop existing.
    await cancelJobsForVideo(t, id);
    // transcript_segments and lessons (and their segments and exports) go via
    // ON DELETE CASCADE, as on desktop.
    await t.delete(videos).where(eq(videos.id, id));
    return video;
  });

  // Unlike desktop — which deliberately keeps its content-hash-keyed WAV cache
  // on disk because another video may share it — the source object here is
  // this video's alone, under its own `{org}/{project}/{video}/` prefix. Plan
  // §9 says a delete purges, so it purges. Post-commit and best-effort, for
  // the same reason as the project delete.
  await storage.deletePrefix(storage.videoPrefix(removed.orgId, removed.projectId, removed.id));

  return c.body(null, 204);
});
