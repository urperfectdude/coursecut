// Projects — `db.ts`'s `createProject`/`listProjects`/`getProject`/
// `deleteProject`.
//
// Org scoping does not appear in a single query below, and that is the point:
// `requireOrg` established the tenant and `tx()` pins it, so `select().from(
// projects)` already means "this org's projects". Plan §4.1 puts it exactly
// that way — `HomeView` lists the active org's projects, and for a single-org
// user that renders identically to desktop.

import { Hono } from "hono";
import { asc, desc, eq } from "drizzle-orm";
import { tx, type AppEnv } from "../http/context.js";
import { badRequest, notFound } from "../http/errors.js";
import { newId } from "../domain/lessons.js";
import * as serialize from "../http/serialize.js";
import { projects, videos } from "../db/schema.js";
import { deletePrefix, projectPrefix } from "../storage.js";

export const projectRoutes = new Hono<AppEnv>();

projectRoutes.post("/projects", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name ?? "").trim();
  if (name.length === 0) throw badRequest("project name must not be empty");

  const [row] = await tx(c, (t) =>
    t.insert(projects).values({ id: newId(), orgId: c.get("orgId"), name }).returning(),
  );
  return c.json(serialize.project(row));
});

projectRoutes.get("/projects", async (c) => {
  const rows = await tx(c, (t) =>
    t.select().from(projects).orderBy(desc(projects.updatedAt)),
  );
  return c.json(rows.map(serialize.project));
});

projectRoutes.get("/projects/:id", async (c) => {
  const [row] = await tx(c, (t) =>
    t.select().from(projects).where(eq(projects.id, c.req.param("id"))).limit(1),
  );
  // 404, not an empty body: `getProject` maps a 404 to `null` and lets
  // anything else reject, so a missing project and a broken server stay
  // distinguishable — same contract as desktop's `Option<Project>`.
  if (!row) throw notFound("project");
  return c.json(serialize.project(row));
});

projectRoutes.get("/projects/:id/videos", async (c) => {
  const rows = await tx(c, (t) =>
    t
      .select()
      .from(videos)
      .where(eq(videos.projectId, c.req.param("id")))
      .orderBy(asc(videos.createdAt), asc(videos.id)),
  );
  return c.json(rows.map(serialize.video));
});

projectRoutes.delete("/projects/:id", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("orgId");

  const deleted = await tx(c, async (t) => {
    // Videos → transcript_segments/lessons → lesson_segments → exports all go
    // with it via ON DELETE CASCADE, as on desktop. The `returning()` is what
    // tells us whether anything was there: under RLS, another tenant's id
    // simply matches no row.
    const rows = await t.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
    return rows.length > 0;
  });
  if (!deleted) throw notFound("project");

  // Plan §9 promises a deleted project has its objects purged — a dropped row
  // must not leave video sitting in a bucket the user was told it had left.
  // After the commit and outside the transaction: a storage failure must not
  // roll back a delete the user already saw succeed, and M7's retention sweep
  // is the backstop for the orphans that leaves.
  await deletePrefix(projectPrefix(orgId, id));

  return c.body(null, 204);
});
