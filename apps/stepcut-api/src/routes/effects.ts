// Zoom/speed region routes and the zoom-suggestion trigger — thin shells
// around `domain/effects.ts`, the same split `routes/steps.ts` keeps.
//
// Mounted under `/api` like every other route here (see `routes/steps.ts`'s
// header for why not `/v1`).

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { param, tx, type AppEnv } from "../http/context.js";
import { badRequest, notFound } from "../http/errors.js";
import * as serialize from "../http/serialize.js";
import * as domain from "../domain/effects.js";
import { videos } from "../db/schema.js";
import { enqueueVideoJob } from "../jobs/queue.js";

export const effectRoutes = new Hono<AppEnv>();

function requiredNumber(value: unknown, field: string): number {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  return n;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  return value === undefined || value === null ? undefined : requiredNumber(value, field);
}

effectRoutes.get("/videos/:id/effects", async (c) => {
  const { zooms, speeds } = await tx(c, (t) => domain.listEffects(t, param(c, "id")));
  return c.json({ zooms: zooms.map(serialize.zoomRegion), speeds: speeds.map(serialize.speedRegion) });
});

// --- Zoom regions ----------------------------------------------------------

type ZoomBody = { start?: unknown; end?: unknown; scale?: unknown; focus_x?: unknown; focus_y?: unknown };

effectRoutes.post("/videos/:id/zooms", async (c) => {
  const videoId = param(c, "id");
  const body = await c.req.json<ZoomBody>();
  const row = await tx(c, (t) =>
    domain.addZoom(t, c.get("orgId"), videoId, {
      start: requiredNumber(body.start, "start"),
      end: requiredNumber(body.end, "end"),
      scale: requiredNumber(body.scale, "scale"),
      focusX: requiredNumber(body.focus_x, "focus_x"),
      focusY: requiredNumber(body.focus_y, "focus_y"),
    }),
  );
  return c.json(serialize.zoomRegion(row));
});

/** Also how a suggestion is accepted: any PATCH, even `{}`, marks it manual. */
effectRoutes.patch("/zooms/:id", async (c) => {
  const id = param(c, "id");
  const body = await c.req.json<ZoomBody>().catch((): ZoomBody => ({}));
  const row = await tx(c, (t) =>
    domain.updateZoom(t, id, {
      start: optionalNumber(body.start, "start"),
      end: optionalNumber(body.end, "end"),
      scale: optionalNumber(body.scale, "scale"),
      focusX: optionalNumber(body.focus_x, "focus_x"),
      focusY: optionalNumber(body.focus_y, "focus_y"),
    }),
  );
  return c.json(serialize.zoomRegion(row));
});

effectRoutes.delete("/zooms/:id", async (c) => {
  await tx(c, (t) => domain.deleteZoom(t, param(c, "id")));
  return c.body(null, 204);
});

/**
 * Queues the `zooms` job, which scans the recording's frames for localized
 * on-screen change and writes `'suggested'` zoom regions. Runs entirely on
 * the worker — nothing about this reaches OpenAI.
 */
effectRoutes.post("/videos/:id/zooms/suggest", async (c) => {
  const videoId = param(c, "id");
  const job = await tx(c, async (t) => {
    const [video] = await t.select().from(videos).where(eq(videos.id, videoId)).limit(1);
    if (!video) throw notFound(`video ${videoId}`);
    if (video.uploadStatus !== "uploaded") throw badRequest("this video has not finished uploading yet");
    return enqueueVideoJob(t, c.get("orgId"), "zooms", videoId, 1);
  });
  return c.json(serialize.job(job), 202);
});

effectRoutes.delete("/videos/:id/zooms/suggestions", async (c) => {
  await tx(c, (t) => domain.dismissZoomSuggestions(t, param(c, "id")));
  return c.body(null, 204);
});

// --- Speed regions ---------------------------------------------------------

type SpeedBody = { start?: unknown; end?: unknown; rate?: unknown };

effectRoutes.post("/videos/:id/speeds", async (c) => {
  const videoId = param(c, "id");
  const body = await c.req.json<SpeedBody>();
  const row = await tx(c, (t) =>
    domain.addSpeed(t, c.get("orgId"), videoId, {
      start: requiredNumber(body.start, "start"),
      end: requiredNumber(body.end, "end"),
      rate: requiredNumber(body.rate, "rate"),
    }),
  );
  return c.json(serialize.speedRegion(row));
});

effectRoutes.patch("/speeds/:id", async (c) => {
  const id = param(c, "id");
  const body = await c.req.json<SpeedBody>();
  const row = await tx(c, (t) =>
    domain.updateSpeed(t, id, {
      start: optionalNumber(body.start, "start"),
      end: optionalNumber(body.end, "end"),
      rate: optionalNumber(body.rate, "rate"),
    }),
  );
  return c.json(serialize.speedRegion(row));
});

effectRoutes.delete("/speeds/:id", async (c) => {
  await tx(c, (t) => domain.deleteSpeed(t, param(c, "id")));
  return c.body(null, 204);
});
