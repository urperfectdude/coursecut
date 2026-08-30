// Render routes — Phase 5 (docs/stepcut-plan.md §8: "Templates & render"),
// this slice.
//
// Thin shells over `domain/renders.ts`, same split `routes/steps.ts` and
// `routes/templates.ts` use. Mounted under `/api` directly, not `/v1` — same
// call the other route files in this package already make; see
// `routes/videos.ts`'s header for why.
//
// This slice never sets `status` past `'queued'`/`'cancelled'` itself —
// `running`/`done`/`failed` are the render worker task's job, which is the
// next slice of this phase and does not exist yet.

import { Hono } from "hono";
import { param, tx, type AppEnv } from "../http/context.js";
import { badRequest } from "../http/errors.js";
import * as serialize from "../http/serialize.js";
import * as domain from "../domain/renders.js";
import { cancelJobsForRender, enqueueRenderJob } from "../jobs/queue.js";
import * as storage from "../storage.js";

export const renderRoutes = new Hono<AppEnv>();

/**
 * Queues a render. Snapshots the video's current steps into `render_steps`
 * (`createRender`) and queues the worker job in the same transaction, so a
 * render row never exists without a queue entry behind it — matches
 * `jobs/queue.ts`'s documented "the enqueue is transactional" rule.
 *
 * `202` with just `{ id, status }`, per docs/stepcut-plan.md §4's documented
 * response shape for `POST /v1/renders` — the client polls `GET /renders/:id`
 * for everything else.
 */
renderRoutes.post("/renders", async (c) => {
  const body = await c.req.json<{ video_id?: string; template_id?: string; callback_url?: string }>();
  const videoId = body.video_id;
  const templateId = body.template_id;
  if (!videoId) throw badRequest("video_id is required");
  if (!templateId) throw badRequest("template_id is required");

  const row = await tx(c, async (t) => {
    const render = await domain.createRender(t, c.get("orgId"), videoId, templateId, body.callback_url);
    await enqueueRenderJob(t, c.get("orgId"), render.id);
    return render;
  });

  return c.json({ id: row.id, status: row.status }, 202);
});

/**
 * Mints a fresh `output_url` for a finished render rather than storing one —
 * same "never a permanently public object, minted fresh on every read"
 * discipline `routes/videos.ts`'s `/videos/playback-url` follows (plan §6).
 */
renderRoutes.get("/renders/:id", async (c) => {
  const id = param(c, "id");
  const row = await tx(c, (t) => domain.queryRender(t, id));

  const outputUrl = row.status === "done" && row.outputKey ? await storage.presignGet(row.outputKey) : null;
  return c.json({ ...serialize.render(row), output_url: outputUrl });
});

/**
 * The one lifecycle transition a caller can request. Cancelling the `renders`
 * row and cancelling its outstanding queue entry happen in the same
 * transaction, same pairing `apps/api/src/routes/exports.ts`'s cancel
 * transition uses.
 */
renderRoutes.post("/renders/:id/cancel", async (c) => {
  const id = param(c, "id");
  const row = await tx(c, async (t) => {
    const updated = await domain.cancelRender(t, id);
    await cancelJobsForRender(t, id);
    return updated;
  });
  return c.json(serialize.render(row));
});

/** A video's renders, newest first. */
renderRoutes.get("/videos/:id/renders", async (c) => {
  const videoId = param(c, "id");
  const rows = await tx(c, (t) => domain.listRendersForVideo(t, videoId));
  return c.json(rows.map(serialize.render));
});
