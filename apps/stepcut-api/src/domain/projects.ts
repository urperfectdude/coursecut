// Project CRUD — the grouping unit `apps/stepcut`'s Home screen lists and
// creates. Modeled on `domain/templates.ts` for validation style
// (`badRequest`/`notFound` from `http/errors.ts`) and patch semantics.
//
// No `deleteProject`: cascading a delete through a project's videos would
// also need to purge each video's/template's storage prefix the same
// post-commit way `routes/videos.ts`'s `DELETE /videos/:id` already does for
// a single video, and that fan-out is future work, not this pass's.

import { desc, eq } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { badRequest, notFound } from "../http/errors.js";
import { projects } from "../db/schema.js";

export const newId = () => crypto.randomUUID();

export type ProjectRow = typeof projects.$inferSelect;

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw badRequest("project name must not be empty");
  return trimmed;
}

export async function queryProject(tx: Tx, id: string): Promise<ProjectRow> {
  const [row] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!row) throw notFound(`project ${id}`);
  return row;
}

/** The org's projects, newest first. RLS already scopes the transaction to
 * the caller's org (same as `domain/templates.ts`'s `listTemplates`), so
 * there is no explicit `org_id` filter here — only on the insert below. */
export async function listProjects(tx: Tx): Promise<ProjectRow[]> {
  return tx.select().from(projects).orderBy(desc(projects.createdAt));
}

export async function createProject(tx: Tx, orgId: string, name: string): Promise<ProjectRow> {
  const [row] = await tx
    .insert(projects)
    .values({ id: newId(), orgId, name: requireName(name) })
    .returning();
  return row;
}

export async function renameProject(tx: Tx, id: string, name: string): Promise<ProjectRow> {
  await queryProject(tx, id);
  const [row] = await tx
    .update(projects)
    .set({ name: requireName(name), updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning();
  return row;
}
