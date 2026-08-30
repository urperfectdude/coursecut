// Step editing routes — Phase 4 (docs/stepcut-plan.md §8: "Manual editing").
//
// Thin shells around `domain/steps.ts`, same split `apps/api/src/routes/
// lessons.ts` uses and for the same reason: the editing rules have to stay
// reviewable against that file's port of desktop's semantics, while the HTTP
// shapes are this file's business.
//
// Mounted under `/api` directly, not `/v1` — same call `routes/videos.ts`'s
// header already makes: `/v1/...` is the plan's sketch of the *eventual
// public API surface* (plan §4), and nothing about the API-key auth that
// surface needs (plan §8 Phase 6) exists yet. These routes stay consistent
// with what's actually deployed.

import { Hono } from "hono";
import { param, tx, type AppEnv } from "../http/context.js";
import { badRequest } from "../http/errors.js";
import * as serialize from "../http/serialize.js";
import * as domain from "../domain/steps.js";

export const stepRoutes = new Hono<AppEnv>();

function numberField(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  return n;
}

stepRoutes.patch("/steps/:id", async (c) => {
  const id = param(c, "id");
  const body = await c.req.json<{
    start?: number;
    end?: number;
    title?: string | null;
    summary?: string | null;
  }>();

  const patch: domain.StepPatch = {};
  if (body.start !== undefined) patch.start = numberField(body.start, "start");
  if (body.end !== undefined) patch.end = numberField(body.end, "end");
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.summary === "string") patch.summary = body.summary;

  const row = await tx(c, (t) => domain.updateStep(t, id, patch));
  return c.json(serialize.step(row));
});

stepRoutes.post("/steps/:id/split", async (c) => {
  const id = param(c, "id");
  const body = await c.req.json<{ at?: number }>();
  const at = numberField(body.at, "at");

  const rows = await tx(c, (t) => domain.splitStep(t, c.get("orgId"), id, at));
  return c.json(rows.map(serialize.step));
});

stepRoutes.delete("/steps/:id", async (c) => {
  const id = param(c, "id");
  await tx(c, (t) => domain.deleteStep(t, id));
  return c.body(null, 204);
});

stepRoutes.post("/videos/:id/steps", async (c) => {
  const videoId = param(c, "id");
  const body = await c.req.json<{ start?: number; end?: number; title?: string; summary?: string }>();

  const row = await tx(c, (t) =>
    domain.addStep(t, c.get("orgId"), videoId, {
      start: numberField(body.start, "start"),
      end: numberField(body.end, "end"),
      title: body.title ?? "",
      summary: body.summary,
    }),
  );
  return c.json(serialize.step(row));
});
