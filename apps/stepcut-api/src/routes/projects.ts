// Project routes — the grouping unit `apps/stepcut`'s Home screen lists and
// creates. Thin shells over `domain/projects.ts`, same split
// `routes/templates.ts` uses.

import { Hono } from "hono";
import { param, tx, type AppEnv } from "../http/context.js";
import { badRequest } from "../http/errors.js";
import * as serialize from "../http/serialize.js";
import * as domain from "../domain/projects.js";

export const projectRoutes = new Hono<AppEnv>();

projectRoutes.get("/projects", async (c) => {
  const rows = await tx(c, (t) => domain.listProjects(t));
  return c.json(rows.map(serialize.project));
});

projectRoutes.post("/projects", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  if (typeof body.name !== "string") throw badRequest("name is required");

  const row = await tx(c, (t) => domain.createProject(t, c.get("orgId"), body.name!));
  return c.json(serialize.project(row));
});

projectRoutes.get("/projects/:id", async (c) => {
  const row = await tx(c, (t) => domain.queryProject(t, param(c, "id")));
  return c.json(serialize.project(row));
});

projectRoutes.patch("/projects/:id", async (c) => {
  const id = param(c, "id");
  const body = await c.req.json<{ name?: string }>();
  if (typeof body.name !== "string") throw badRequest("name is required");

  const row = await tx(c, (t) => domain.renameProject(t, id, body.name!));
  return c.json(serialize.project(row));
});
