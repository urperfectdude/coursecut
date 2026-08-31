// Public, unauthenticated serving for a `'markdown'`/`'html'`-format
// render's output — the one deliberate exception to every other route in
// this package, which all sit behind `requireOrg` (`app.ts`).
//
// Why this exists: `renders.outputKey` (the stitched MP4 a `'video'`-format
// render produces) is only ever handed out as a fresh, short-TTL presigned
// GET (`routes/renders.ts`'s `GET /renders/:id`, `storage.ts`'s stated "never
// a permanently public object" discipline). That's fine for a link the app
// itself opens the moment it's minted, but wrong for the two newer formats:
// a `.md` file someone reads next week, or an HTML page someone shares,
// needs its embedded video links to still work long after any presigned
// URL's TTL would have expired.
//
// The fix here is *not* to make the storage bucket public — that bucket is
// shared with coursecut-web (`storage.ts`'s header), and Cloudflare R2 (the
// production backend) has no per-object ACL API to grant that selectively
// even if it were the right call. Instead: keep the bucket exactly as
// private as it already is, and serve these specific objects through the
// API itself, which already sits on the same droplet as everything else —
// genuinely "hosted on the same droplet," and identical in dev (MinIO) and
// prod (R2) since neither's bucket ACL matters here at all.
//
// The only thing standing between "unauthenticated" and "public to anyone
// who can guess a render id" is that a render id is a `crypto.randomUUID()`
// — the same protection model a presigned URL's signature already relies
// on, just without the expiry. Choosing to publish a render this way is the
// org's own choice (picking `'markdown'`/`'html'` at render time); this
// route only ever serves what that choice already produced.
//
// Reads via `getDb()` directly, never `tx()`/`withOrg` — there is no org
// context here to scope a transaction to (`http/context.ts`'s
// `findMembership`/`adoptDefaultOrg` are the only other places in this
// package that read this way, for the same reason: no org known yet).

import { Readable } from "node:stream";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { renderSteps, renders } from "../db/schema.js";
import * as storage from "../storage.js";
import type { AppEnv } from "../http/context.js";

export const publicExportRoutes = new Hono<AppEnv>();

/**
 * The hosted page itself for a `'html'`-format render — this *is* the
 * permanent URL `routes/renders.ts`'s `GET /renders/:id` hands back as
 * `output_url` once the render is done. 404s for anything else (wrong
 * format, not yet done, or no such render) rather than distinguishing those
 * cases in the response: none of them are actionable by whoever followed
 * the link.
 */
publicExportRoutes.get("/:renderId", async (c) => {
  const renderId = c.req.param("renderId");
  const [row] = await getDb()
    .select({ status: renders.status, format: renders.format, outputKey: renders.outputKey })
    .from(renders)
    .where(eq(renders.id, renderId))
    .limit(1);

  if (!row || row.status !== "done" || row.format !== "html" || !row.outputKey) {
    return c.notFound();
  }

  const object = await storage.getObjectStream(row.outputKey);
  if (!object) return c.notFound();

  return c.body(nodeStreamToWeb(object.body), 200, {
    "Content-Type": "text/html; charset=utf-8",
    ...(object.contentLength !== undefined ? { "Content-Length": String(object.contentLength) } : {}),
  });
});

/**
 * One step's individually-cut clip — embedded by URL in both a
 * `'markdown'`-format render's `.md` and a `'html'`-format render's page.
 * Looked up by `(id, renderId)` rather than trusting `assetKey` alone: the
 * row has to actually belong to the render named in the URL, not just
 * exist.
 */
publicExportRoutes.get("/:renderId/steps/:stepId", async (c) => {
  const renderId = c.req.param("renderId");
  const stepId = c.req.param("stepId");

  const [row] = await getDb()
    .select({ assetKey: renderSteps.assetKey })
    .from(renderSteps)
    .where(and(eq(renderSteps.id, stepId), eq(renderSteps.renderId, renderId)))
    .limit(1);

  if (!row?.assetKey) return c.notFound();

  const object = await storage.getObjectStream(row.assetKey);
  if (!object) return c.notFound();

  return c.body(nodeStreamToWeb(object.body), 200, {
    "Content-Type": "video/mp4",
    ...(object.contentLength !== undefined ? { "Content-Length": String(object.contentLength) } : {}),
  });
});

/** Node's `Readable` (what `storage.getObjectStream` returns) → the Web
 * `ReadableStream` Hono's `c.body` expects for a streamed response. */
function nodeStreamToWeb(body: Readable): ReadableStream {
  return Readable.toWeb(body) as ReadableStream;
}
