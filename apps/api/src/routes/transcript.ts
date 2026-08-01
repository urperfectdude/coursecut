// Transcript segments — the read, and Transcript Mode's keep/delete toggle
// (PRD §8.1).
//
// The toggle is a column update, never a row delete: `keep = false` is how a
// segment is "removed" from the edit, and the text has to survive so the user
// can put it back. `coursecut-data-model` is explicit about that, and it is
// the same on both apps.

import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { tx, type AppEnv } from "../http/context.js";
import { notFound } from "../http/errors.js";
import * as serialize from "../http/serialize.js";
import { transcriptSegments } from "../db/schema.js";

export const transcriptRoutes = new Hono<AppEnv>();

transcriptRoutes.get("/videos/:id/transcript", async (c) => {
  const rows = await tx(c, (t) =>
    t
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.videoId, c.req.param("id")))
      .orderBy(asc(transcriptSegments.start), asc(transcriptSegments.id)),
  );
  return c.json(rows.map(serialize.transcriptSegment));
});

transcriptRoutes.patch("/transcript-segments/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ keep?: boolean }>();

  const [row] = await tx(c, (t) =>
    t
      .update(transcriptSegments)
      .set({ keep: Boolean(body.keep) })
      .where(eq(transcriptSegments.id, id))
      .returning(),
  );
  if (!row) throw notFound("transcript segment");
  return c.json(serialize.transcriptSegment(row));
});
