// Exports (D5, D6) — queue, the four state transitions, Export History's
// listing, and the download URL that stands in for "Reveal in Finder".
//
// **D5 — no output directory.** Desktop asks for a folder and writes the MP4
// into it, picking a non-colliding filename under that folder. A browser
// cannot write to an arbitrary folder, so the worker writes to object storage
// instead and the UI offers a download. `queueExport` keeps its `outputDir`
// parameter so the copied call sites match desktop's, and it is ignored here.
//
// Collision handling therefore disappears rather than being ported: desktop's
// `unique_output_path` exists because two lessons named the same thing would
// otherwise overwrite each other in one folder. Here the key is
// `{org}/{project}/exports/{export id}/{title}.mp4` — unique by construction,
// because the export's own id is in it.
//
// **D6 — reveal becomes download.** No OS shell in a browser, so "Reveal"
// mints a short-TTL presigned GET with a `Content-Disposition` that makes the
// browser save it. `db.ts` keeps the desktop name; only the label is a lie,
// which the view corrects.
//
// The state machine is ported exactly, including which transitions are
// refused. Pause/resume only ever apply to a job that has not started
// encoding — suspending a live ffmpeg process is not something either app
// attempts.

import { Hono } from "hono";
import { desc, eq, inArray } from "drizzle-orm";
import { param, tx, type AppEnv } from "../http/context.js";
import { badRequest, notFound } from "../http/errors.js";
import { newId } from "../domain/lessons.js";
import * as serialize from "../http/serialize.js";
import { exports as exportsTable, lessons, videos } from "../db/schema.js";
import { cancelJobsForExport, enqueueExportJob, requeueExport } from "../jobs/queue.js";
import { assertCanExport } from "../quota.js";
import * as storage from "../storage.js";
import type { Tx } from "../db/client.js";

export const exportRoutes = new Hono<AppEnv>();

/**
 * Desktop's `sanitize_filename`, ported: alphanumerics and `-` survive, every
 * run of anything else collapses to a single `_`, leading/trailing `_` are
 * trimmed, and an empty result becomes "lesson". Ported rather than replaced
 * because the downloaded file's name is user-visible, and a lesson exported
 * from the desktop app and the same lesson exported from the web one should
 * not arrive with different names.
 */
function sanitizeTitle(title: string): string {
  let out = "";
  let lastWasUnderscore = false;
  for (const ch of title) {
    if (/[\p{L}\p{N}]/u.test(ch) || ch === "-") {
      out += ch;
      lastWasUnderscore = false;
    } else if (!lastWasUnderscore) {
      out += "_";
      lastWasUnderscore = true;
    }
  }
  const trimmed = out.replace(/^_+|_+$/g, "");
  return trimmed.length > 0 ? trimmed : "lesson";
}

async function requireExport(t: Tx, id: string) {
  const [row] = await t.select().from(exportsTable).where(eq(exportsTable.id, id)).limit(1);
  if (!row) throw notFound("export");
  return row;
}

exportRoutes.post("/exports", async (c) => {
  const body = await c.req.json<{ lesson_ids?: string[] }>();
  const lessonIds = body.lesson_ids ?? [];
  if (lessonIds.length === 0) throw badRequest("no lessons selected to export");

  const orgId = c.get("orgId");

  const rows = await tx(c, async (t) => {
    // M7: storage headroom and the active-job cap, checked once for the batch.
    // Per-lesson would be no stricter — the rows are all written in this one
    // transaction, so nothing between them can change the answer — and would
    // fail a twenty-lesson export halfway through with ten rows already
    // committed.
    await assertCanExport(t, orgId);

    // One query for the batch, then a per-id lookup, so a bad id in a batch of
    // twenty names itself instead of failing anonymously.
    const found = await t
      .select({ id: lessons.id, title: lessons.title, videoId: lessons.videoId })
      .from(lessons)
      .where(inArray(lessons.id, lessonIds));
    const byId = new Map(found.map((lesson) => [lesson.id, lesson]));

    const created = [];
    for (const lessonId of lessonIds) {
      const lesson = byId.get(lessonId);
      if (!lesson) throw notFound(`lesson ${lessonId}`);

      const [video] = await t
        .select({ projectId: videos.projectId })
        .from(videos)
        .where(eq(videos.id, lesson.videoId))
        .limit(1);
      if (!video) throw notFound(`video ${lesson.videoId}`);

      const exportId = newId();
      const [row] = await t
        .insert(exportsTable)
        .values({
          id: exportId,
          orgId,
          lessonId,
          outputKey: storage.exportKey(
            orgId,
            video.projectId,
            exportId,
            `${sanitizeTitle(lesson.title)}.mp4`,
          ),
          status: "queued",
          progress: 0,
        })
        .returning();
      await enqueueExportJob(t, orgId, exportId);
      created.push(row);
    }
    return created;
  });

  // Placeholder ancestry, exactly as desktop returns: the frontend always
  // re-fetches via `listExports` after queuing rather than rendering this.
  return c.json(rows.map((row) => serialize.exportRow(row)));
});

/**
 * The four transitions, each refusing the same states desktop refuses.
 *
 * `requeue` is the one thing desktop has no need for. Its worker polls the
 * `exports` table, so flipping a status back to `queued` is all it takes for
 * the job to be picked up again. Here the queue is a separate table, and a row
 * that says `queued` with no queue entry behind it would sit there looking
 * scheduled forever — so the two transitions that re-open a job put one back.
 */
function transition(
  path: string,
  allowed: string[],
  next: string,
  refusal: (id: string, status: string) => string,
  extra: Partial<typeof exportsTable.$inferInsert> = {},
  requeue = false,
) {
  exportRoutes.post(path, async (c) => {
    const id = param(c, "id");
    const row = await tx(c, async (t) => {
      const existing = await requireExport(t, id);
      if (!allowed.includes(existing.status)) throw badRequest(refusal(id, existing.status));
      // A transition that puts work back on the queue is a new job as far as
      // the caps are concerned: Retry on a failed export of a suspended org,
      // or on an org that is out of storage, must be refused for the same
      // reasons the original queueing would have been. Pause and cancel take
      // work *off* the queue and are never refused.
      if (requeue) await assertCanExport(t, c.get("orgId"));
      const [updated] = await t
        .update(exportsTable)
        .set({ status: next, ...extra })
        .where(eq(exportsTable.id, id))
        .returning();
      if (requeue) await requeueExport(t, c.get("orgId"), id);
      // A cancelled export's `jobs` row would otherwise sit `queued` forever,
      // holding a slot of the org's active-job budget for work that will never
      // run. The queue entry itself is left alone, exactly as
      // `cancelJobsForVideo` leaves it: it will run, see a row that is not
      // `queued`, and return.
      if (next === "cancelled") await cancelJobsForExport(t, id);
      return updated;
    });
    return c.json(serialize.exportRow(row));
  });
}

transition(
  "/exports/:id/pause",
  ["queued"],
  "paused",
  (id, status) =>
    `cannot pause export ${id}: only a queued export can be paused (current status: ${status})`,
);

transition(
  "/exports/:id/resume",
  ["paused"],
  "queued",
  (id, status) =>
    `cannot resume export ${id}: only a paused export can be resumed (current status: ${status})`,
  {},
  true,
);

// Cancelling a `running` export marks the row and lets the worker notice.
// Desktop can kill the ffmpeg child directly because it owns the process;
// here the worker does, and its post-encode status check is what makes
// cancellation stick — it will not overwrite `cancelled` with `done`.
transition(
  "/exports/:id/cancel",
  ["queued", "paused", "running"],
  "cancelled",
  (id, status) => `cannot cancel export ${id}: already ${status}`,
);

transition(
  "/exports/:id/retry",
  ["failed", "cancelled"],
  "queued",
  (id, status) =>
    `cannot retry export ${id}: only a failed or cancelled export can be retried (current status: ${status})`,
  { progress: 0, error: null },
  true,
);

/**
 * Export History's listing: a project's exports, newest first, with the
 * lesson/video ancestry joined in so a row renders without a round trip per
 * row. Same join and same order as desktop's `list_exports`.
 */
exportRoutes.get("/projects/:id/exports", async (c) => {
  const projectId = c.req.param("id");

  const rows = await tx(c, (t) =>
    t
      .select({
        row: exportsTable,
        lesson_title: lessons.title,
        lesson_start: lessons.start,
        lesson_end: lessons.end,
        video_file_path: videos.storageKey,
      })
      .from(exportsTable)
      .innerJoin(lessons, eq(lessons.id, exportsTable.lessonId))
      .innerJoin(videos, eq(videos.id, lessons.videoId))
      .where(eq(videos.projectId, projectId))
      .orderBy(desc(exportsTable.createdAt), desc(exportsTable.id)),
  );

  return c.json(
    rows.map(({ row, ...ancestry }) => serialize.exportRow(row, ancestry)),
  );
});

/**
 * D6: a download URL for a finished export.
 *
 * Like the playback endpoint, the key is *resolved* against the caller's own
 * rows rather than signed as given — RLS makes another tenant's key match
 * nothing. The `Content-Disposition` filename is the export's own key basename,
 * which is the sanitized lesson title, so the file arrives named the way the
 * desktop app would have named it.
 */
exportRoutes.post("/exports/download-url", async (c) => {
  const body = await c.req.json<{ output_key?: string }>();
  const key = body.output_key;
  if (!key) throw badRequest("output_key is required");

  const [row] = await tx(c, (t) =>
    t
      .select({ status: exportsTable.status })
      .from(exportsTable)
      .where(eq(exportsTable.outputKey, key))
      .limit(1),
  );
  if (!row) throw notFound("export");
  if (row.status !== "done") throw badRequest("this export has not finished yet");

  const filename = key.split("/").pop() ?? "lesson.mp4";
  return c.json({ url: await storage.presignGet(key, { downloadAs: filename }) });
});
