// Template CRUD — Phase 5 (docs/stepcut-plan.md §8: "Templates & render"),
// slice 1.
//
// A template holds an org's reusable render config: brand colors, target
// output dimensions, and optional intro/outro/logo assets uploaded the same
// presigned-PUT way a video is. Nothing here queues a render or touches
// `renders`/`render_steps` — those, and the routes that trigger a render,
// arrive in a later slice of this phase.
//
// Patch semantics mirror `domain/steps.ts`'s `updateStep`: an absent field is
// left unchanged, and validation on `updateTemplate` is identical to
// `createTemplate`'s for whichever field is actually present.

import { desc, eq } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { badRequest, notFound } from "../http/errors.js";
import { templates } from "../db/schema.js";

export const newId = () => crypto.randomUUID();

export type TemplateRow = typeof templates.$inferSelect;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw badRequest("template name must not be empty");
  return trimmed;
}

function validateHex(field: string, value: string): string {
  if (!HEX_COLOR.test(value)) throw badRequest(`${field} must be a 6-digit hex color, e.g. "#1a2b3c"`);
  return value;
}

function validatePositiveInt(field: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw badRequest(`${field} must be a positive integer`);
  return value;
}

export async function queryTemplate(tx: Tx, id: string): Promise<TemplateRow> {
  const [row] = await tx.select().from(templates).where(eq(templates.id, id)).limit(1);
  if (!row) throw notFound(`template ${id}`);
  return row;
}

/** A project's templates, newest first. RLS already scopes the transaction
 * to the caller's org (same as `videoRoutes`'s `GET /videos`); the explicit
 * `project_id` filter here is the grouping, not the security boundary. */
export async function listTemplates(tx: Tx, projectId: string): Promise<TemplateRow[]> {
  return tx.select().from(templates).where(eq(templates.projectId, projectId)).orderBy(desc(templates.createdAt));
}

export interface TemplateInput {
  name: string;
  brandPrimaryHex?: string;
  brandSecondaryHex?: string;
  targetWidth?: number;
  targetHeight?: number;
  targetFps?: number;
}

export async function createTemplate(
  tx: Tx,
  orgId: string,
  projectId: string,
  input: TemplateInput,
): Promise<TemplateRow> {
  const name = requireName(input.name);
  if (input.brandPrimaryHex !== undefined) validateHex("brand_primary_hex", input.brandPrimaryHex);
  if (input.brandSecondaryHex !== undefined) validateHex("brand_secondary_hex", input.brandSecondaryHex);
  const targetWidth =
    input.targetWidth !== undefined ? validatePositiveInt("target_width", input.targetWidth) : 1920;
  const targetHeight =
    input.targetHeight !== undefined ? validatePositiveInt("target_height", input.targetHeight) : 1080;
  const targetFps = input.targetFps !== undefined ? validatePositiveInt("target_fps", input.targetFps) : 30;

  const [row] = await tx
    .insert(templates)
    .values({
      id: newId(),
      orgId,
      projectId,
      name,
      brandPrimaryHex: input.brandPrimaryHex ?? null,
      brandSecondaryHex: input.brandSecondaryHex ?? null,
      targetWidth,
      targetHeight,
      targetFps,
    })
    .returning();
  return row;
}

export interface TemplatePatch {
  name?: string;
  brandPrimaryHex?: string | null;
  brandSecondaryHex?: string | null;
  targetWidth?: number;
  targetHeight?: number;
  targetFps?: number;
}

export async function updateTemplate(tx: Tx, id: string, patch: TemplatePatch): Promise<TemplateRow> {
  await queryTemplate(tx, id);

  const set: Partial<TemplateRow> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = requireName(patch.name);
  if (patch.brandPrimaryHex !== undefined) {
    set.brandPrimaryHex = patch.brandPrimaryHex === null ? null : validateHex("brand_primary_hex", patch.brandPrimaryHex);
  }
  if (patch.brandSecondaryHex !== undefined) {
    set.brandSecondaryHex =
      patch.brandSecondaryHex === null ? null : validateHex("brand_secondary_hex", patch.brandSecondaryHex);
  }
  if (patch.targetWidth !== undefined) set.targetWidth = validatePositiveInt("target_width", patch.targetWidth);
  if (patch.targetHeight !== undefined) set.targetHeight = validatePositiveInt("target_height", patch.targetHeight);
  if (patch.targetFps !== undefined) set.targetFps = validatePositiveInt("target_fps", patch.targetFps);

  const [row] = await tx.update(templates).set(set).where(eq(templates.id, id)).returning();
  return row;
}

/** Deletes a template's row. The caller (routes/templates.ts) purges its
 * storage prefix post-commit, best-effort — same split `videoRoutes`'s
 * `DELETE /videos/:id` uses. */
export async function deleteTemplate(tx: Tx, id: string): Promise<TemplateRow> {
  const existing = await queryTemplate(tx, id);
  await tx.delete(templates).where(eq(templates.id, id));
  return existing;
}

export type AssetKind = "intro" | "outro" | "logo";

/** Writes the storage key for one of a template's assets, once `headObject`
 * has confirmed it actually landed (routes/templates.ts's job). */
export async function setTemplateAssetKey(
  tx: Tx,
  id: string,
  kind: AssetKind,
  key: string,
): Promise<TemplateRow> {
  await queryTemplate(tx, id);
  const set: Partial<TemplateRow> = { updatedAt: new Date() };
  if (kind === "intro") set.introKey = key;
  else if (kind === "outro") set.outroKey = key;
  else set.logoKey = key;

  const [row] = await tx.update(templates).set(set).where(eq(templates.id, id)).returning();
  return row;
}
