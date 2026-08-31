// Template routes — Phase 5 (docs/stepcut-plan.md §8: "Templates & render"),
// slice 1.
//
// Thin shells over `domain/templates.ts`, same split `routes/steps.ts` and
// `routes/videos.ts` use. The presigned-upload-then-complete shape for a
// template's intro/outro/logo assets mirrors `routes/videos.ts`'s
// `/videos/uploads` → `/videos/:id/complete` flow, trimmed to the single-shot
// path only — a template asset (a short clip or a still image) is never big
// enough to need the multipart branch that exists for a source video.
//
// Mounted under `/api` directly, not `/v1` — same call the other route files
// in this package already make; see `routes/videos.ts`'s header.
//
// Unlike a video, there is no server-stored "pending" key for an asset
// upload: `/uploads` mints the key and hands it straight back, and the
// caller echoes it into `/complete`'s body. There is nowhere else for that
// key to come from — a template's `intro_key`/`outro_key`/`logo_key` column
// only gets written once `/complete`'s `headObject` check passes.

import { Hono } from "hono";
import { param, tx, type AppEnv } from "../http/context.js";
import { badRequest } from "../http/errors.js";
import * as serialize from "../http/serialize.js";
import * as domain from "../domain/templates.js";
import * as storage from "../storage.js";

export const templateRoutes = new Hono<AppEnv>();

const ASSET_KINDS = ["intro", "outro", "logo"] as const;

function isAssetKind(value: string): value is domain.AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(value);
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  return n;
}

interface TemplateBody {
  project_id?: string;
  name?: string;
  brand_primary_hex?: string | null;
  brand_secondary_hex?: string | null;
  target_width?: number;
  target_height?: number;
  target_fps?: number;
}

templateRoutes.post("/templates", async (c) => {
  const body = await c.req.json<TemplateBody>();
  const name = body.name;
  if (typeof name !== "string") throw badRequest("name is required");
  const projectId = body.project_id;
  if (!projectId) throw badRequest("project_id is required");

  const row = await tx(c, (t) =>
    domain.createTemplate(t, c.get("orgId"), projectId, {
      name,
      brandPrimaryHex: body.brand_primary_hex ?? undefined,
      brandSecondaryHex: body.brand_secondary_hex ?? undefined,
      targetWidth: optionalNumber(body.target_width, "target_width"),
      targetHeight: optionalNumber(body.target_height, "target_height"),
      targetFps: optionalNumber(body.target_fps, "target_fps"),
    }),
  );
  return c.json(serialize.template(row));
});

/** A project's templates, newest first — same convention `GET /videos` uses. */
templateRoutes.get("/templates", async (c) => {
  const projectId = c.req.query("project_id");
  if (!projectId) throw badRequest("project_id is required");
  const rows = await tx(c, (t) => domain.listTemplates(t, projectId));
  return c.json(rows.map(serialize.template));
});

templateRoutes.get("/templates/:id", async (c) => {
  const row = await tx(c, (t) => domain.queryTemplate(t, param(c, "id")));
  return c.json(serialize.template(row));
});

templateRoutes.patch("/templates/:id", async (c) => {
  const id = param(c, "id");
  const body = await c.req.json<TemplateBody>();

  const row = await tx(c, (t) =>
    domain.updateTemplate(t, id, {
      name: body.name,
      brandPrimaryHex: body.brand_primary_hex,
      brandSecondaryHex: body.brand_secondary_hex,
      targetWidth: optionalNumber(body.target_width, "target_width"),
      targetHeight: optionalNumber(body.target_height, "target_height"),
      targetFps: optionalNumber(body.target_fps, "target_fps"),
    }),
  );
  return c.json(serialize.template(row));
});

templateRoutes.delete("/templates/:id", async (c) => {
  const id = param(c, "id");
  const removed = await tx(c, (t) => domain.deleteTemplate(t, id));

  // Post-commit and best-effort: the asset objects are this template's alone,
  // under its own `stepcut/{org}/templates/{template}/` prefix — same split
  // `videoRoutes`'s `DELETE /videos/:id` uses.
  await storage.deletePrefix(storage.templatePrefix(removed.orgId, removed.id));

  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Assets: presigned upload, single-shot only (see this file's header).
// ---------------------------------------------------------------------------

templateRoutes.post("/templates/:id/assets/:kind/uploads", async (c) => {
  const id = param(c, "id");
  const kind = param(c, "kind");
  if (!isAssetKind(kind)) throw badRequest(`kind must be one of ${ASSET_KINDS.join(", ")}`);

  const body = await c.req.json<{ filename?: string; content_type?: string }>();
  const filename = (body.filename ?? "").trim();
  if (filename.length === 0) throw badRequest("filename is required");
  const contentType = body.content_type || "application/octet-stream";

  const orgId = c.get("orgId");
  await tx(c, (t) => domain.queryTemplate(t, id));

  const key = storage.templateAssetKey(orgId, id, kind, filename);
  return c.json({ url: await storage.presignPut(key, contentType), storage_key: key });
});

/**
 * Confirms the object actually landed and writes its key onto the template
 * row. `storage_key` is the key `/uploads` just minted, echoed back by the
 * client — there is no pending key stored server-side to look up instead
 * (see this file's header).
 *
 * `storage_key` is client-supplied, so it is checked against this exact
 * `(org, template, kind)`'s own prefix before anything is done with it —
 * `storage.headObject` has no org boundary of its own (object isolation is
 * only the key-prefix convention), so without this a caller who knew any
 * object key in the shared bucket could point this template's asset column
 * at a foreign object.
 */
templateRoutes.post("/templates/:id/assets/:kind/complete", async (c) => {
  const id = param(c, "id");
  const kind = param(c, "kind");
  if (!isAssetKind(kind)) throw badRequest(`kind must be one of ${ASSET_KINDS.join(", ")}`);

  const body = await c.req.json<{ storage_key?: string }>();
  const key = body.storage_key;
  if (!key) throw badRequest("storage_key is required");

  const orgId = c.get("orgId");
  await tx(c, (t) => domain.queryTemplate(t, id));
  const prefix = `${storage.templatePrefix(orgId, id)}${kind}/`;
  if (!key.startsWith(prefix)) throw badRequest("storage_key does not belong to this template asset");

  const head = await storage.headObject(key);
  if (!head) throw badRequest("the upload did not arrive in storage");

  const row = await tx(c, (t) => domain.setTemplateAssetKey(t, id, kind, key));
  return c.json(serialize.template(row));
});
