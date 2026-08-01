// Lessons and lesson segments.
//
// Every handler here is a thin shell around `domain/lessons.ts`, which is
// where the desktop semantics live. That split is deliberate: the rules about
// cached bounds, re-sequencing and all-or-nothing reorders are a port of
// `src-tauri/src/db.rs` and have to stay reviewable against it, while the HTTP
// shapes are this file's business. Mixing the two would make the port
// impossible to diff against its source.
//
// Note the route ordering: `/lessons/merge` is registered before
// `/lessons/:id` so the literal is never captured as an id — the same
// ordering the mock backend needed, for the same reason.

import { Hono } from "hono";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { badRequest } from "../http/errors.js";
import { param, tx, type AppEnv } from "../http/context.js";
import * as serialize from "../http/serialize.js";
import * as domain from "../domain/lessons.js";
import { transcriptSegments } from "../db/schema.js";
import { editLessonSegments, extractTimestampsSeconds } from "../openai.js";

/**
 * Padding either side of a lesson's own span for the transcript context sent
 * with a segment-edit prompt — enough for the model to see around the lesson's
 * current edges ("remove the tangent right before the demo starts") without
 * shipping a whole lecture's transcript for a scoped edit. Also the pad folded
 * in around any timestamp the instruction names.
 */
const LESSON_EDIT_CONTEXT_PAD_SECS = 60;

export const lessonRoutes = new Hono<AppEnv>();

function ranges(value: unknown): domain.SegmentRange[] {
  if (!Array.isArray(value)) throw badRequest("segments must be an array of {start, end}");
  return value.map((entry) => {
    const range = entry as { start?: unknown; end?: unknown };
    const start = Number(range.start);
    const end = Number(range.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw badRequest("each segment needs a numeric start and end");
    }
    return { start, end };
  });
}

function orderedIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    throw badRequest("ordered_ids must be an array of ids");
  }
  return value as string[];
}

// --- Lessons ---------------------------------------------------------------

lessonRoutes.post("/lessons/merge", async (c) => {
  const body = await c.req.json<{ first_id?: string; second_id?: string }>();
  if (!body.first_id || !body.second_id) throw badRequest("first_id and second_id are required");

  const row = await tx(c, (t) => domain.mergeLessons(t, body.first_id!, body.second_id!));
  return c.json(serialize.lesson(row));
});

lessonRoutes.post("/videos/:id/lessons", async (c) => {
  const videoId = c.req.param("id");
  const body = await c.req.json<{ title?: string; segments?: unknown }>();

  const row = await tx(c, (t) =>
    domain.createLesson(t, c.get("orgId"), videoId, body.title ?? "", ranges(body.segments)),
  );
  return c.json(serialize.lesson(row));
});

lessonRoutes.patch("/lessons/:id", async (c) => {
  const id = c.req.param("id");
  // Patch semantics, and `null` means "leave alone" rather than "clear":
  // `db.ts` sends `title: patch.title ?? null` for an omitted field, so a
  // null here is an absent field, not an intent to blank one. Desktop's
  // `Option<String>` arguments behave identically.
  const body = await c.req.json<{ title?: string | null; summary?: string | null }>();

  const patch: { title?: string; summary?: string } = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.summary === "string") patch.summary = body.summary;

  const row = await tx(c, (t) => domain.updateLesson(t, id, patch));
  return c.json(serialize.lesson(row));
});

lessonRoutes.post("/lessons/:id/split", async (c) => {
  const lessonId = c.req.param("id");
  const body = await c.req.json<{ segment_id?: string; at_time?: number }>();
  if (!body.segment_id) throw badRequest("segment_id is required");
  const atTime = Number(body.at_time);
  if (!Number.isFinite(atTime)) throw badRequest("at_time must be a number");

  const rows = await tx(c, (t) =>
    domain.splitLesson(t, c.get("orgId"), lessonId, body.segment_id!, atTime),
  );
  return c.json(rows.map(serialize.lesson));
});

lessonRoutes.delete("/lessons/:id", async (c) => {
  await tx(c, (t) => domain.deleteLesson(t, c.req.param("id")));
  return c.body(null, 204);
});

lessonRoutes.put("/videos/:id/lesson-order", async (c) => {
  const body = await c.req.json<{ ordered_ids?: unknown }>();
  await tx(c, (t) => domain.reorderLessons(t, c.req.param("id"), orderedIds(body.ordered_ids)));
  return c.body(null, 204);
});

// --- Lesson segments -------------------------------------------------------

lessonRoutes.get("/lessons/:id/segments", async (c) => {
  const rows = await tx(c, (t) => domain.listLessonSegments(t, c.req.param("id")));
  return c.json(rows.map(serialize.lessonSegment));
});

lessonRoutes.post("/lessons/:id/segments", async (c) => {
  const body = await c.req.json<{ start?: number; end?: number }>();
  const row = await tx(c, (t) =>
    domain.addLessonSegment(t, c.get("orgId"), c.req.param("id"), {
      start: Number(body.start),
      end: Number(body.end),
    }),
  );
  return c.json(serialize.lessonSegment(row));
});

lessonRoutes.patch("/lesson-segments/:id", async (c) => {
  const body = await c.req.json<{ start?: number; end?: number }>();
  const row = await tx(c, (t) =>
    domain.updateLessonSegment(t, c.req.param("id"), {
      start: Number(body.start),
      end: Number(body.end),
    }),
  );
  return c.json(serialize.lessonSegment(row));
});

lessonRoutes.delete("/lesson-segments/:id", async (c) => {
  const result = await tx(c, (t) => domain.deleteLessonSegment(t, c.req.param("id")));
  return c.json(result);
});

lessonRoutes.put("/lessons/:id/segment-order", async (c) => {
  const body = await c.req.json<{ ordered_ids?: unknown }>();
  await tx(c, (t) =>
    domain.reorderLessonSegments(t, c.req.param("id"), orderedIds(body.ordered_ids)),
  );
  return c.body(null, 204);
});

// --- Per-lesson AI segment edit -------------------------------------------
//
// The review popup on `LessonSegmentsView`. Proposing is a pure read that
// calls GPT-5.5 and writes nothing; applying is a pure write that calls
// nothing. The popup is the seam between them, which is what makes the
// proposal reviewable rather than applied.

/**
 * Proposes a revised segment list. Writes nothing — the popup's Apply is the
 * only thing that does, and it never calls the model.
 *
 * `baseline` is absent for the prompt box's first submission (the lesson's
 * current segments are the baseline) and present for a refinement typed inside
 * the popup — in which case it is the *previous, not-yet-applied* proposal,
 * not the rows, since nothing has been written yet.
 *
 * The transcript context window is always sized from the lesson's **own real**
 * segments, never the resolved baseline, so a refinement's window does not
 * drift just because the hypothetical proposal has moved away from the
 * lesson's actual footprint. It is then widened around any timestamp the
 * instruction names, so a time reaching outside the lesson still has real
 * transcript behind it rather than asking the model about a stretch it was
 * shown nothing for.
 *
 * Only transcript text and the instruction reach OpenAI — never audio, never
 * video (plan §9).
 */
lessonRoutes.post("/lessons/:id/segment-edit/preview", async (c) => {
  const lessonId = param(c, "id");
  const body = await c.req.json<{ instruction?: string; baseline?: unknown }>();
  const instruction = (body.instruction ?? "").trim();
  if (instruction.length === 0) {
    throw badRequest("Describe the change you want before previewing it.");
  }
  const baseline =
    body.baseline == null
      ? undefined
      : ranges(body.baseline).map((range) => [range.start, range.end] as [number, number]);

  const context = await tx(c, async (t) => {
    const lesson = await domain.queryLesson(t, lessonId);
    const own = await domain.listLessonSegments(t, lessonId);

    // A lesson always has at least one segment while it exists (deleting the
    // last one deletes the lesson), so the cached-bound fallback is
    // defense in depth rather than an expected path.
    let windowStart =
      own.length > 0 ? Math.min(...own.map((segment) => segment.start)) : lesson.start;
    let windowEnd = own.length > 0 ? Math.max(...own.map((segment) => segment.end)) : lesson.end;
    windowStart -= LESSON_EDIT_CONTEXT_PAD_SECS;
    windowEnd += LESSON_EDIT_CONTEXT_PAD_SECS;

    for (const timestamp of extractTimestampsSeconds(instruction)) {
      windowStart = Math.min(windowStart, timestamp - LESSON_EDIT_CONTEXT_PAD_SECS);
      windowEnd = Math.max(windowEnd, timestamp + LESSON_EDIT_CONTEXT_PAD_SECS);
    }

    const transcript = await t
      .select({
        start: transcriptSegments.start,
        end: transcriptSegments.end,
        text: transcriptSegments.text,
      })
      .from(transcriptSegments)
      .where(
        and(
          eq(transcriptSegments.videoId, lesson.videoId),
          eq(transcriptSegments.keep, true),
          gte(transcriptSegments.end, windowStart),
          lte(transcriptSegments.start, windowEnd),
        ),
      )
      .orderBy(asc(transcriptSegments.start), asc(transcriptSegments.id));

    return {
      baseline: baseline ?? own.map((segment) => [segment.start, segment.end] as [number, number]),
      transcript,
    };
  });

  // Outside the transaction on purpose: a model call can take a minute, and
  // holding a pinned transaction open for it would tie up a pooled connection
  // (and its row locks) for the duration.
  const proposed = await editLessonSegments(context.baseline, context.transcript, instruction);
  return c.json(proposed.map(([start, end]) => ({ start, end })));
});

lessonRoutes.post("/lessons/:id/segment-edit/apply", async (c) => {
  const body = await c.req.json<{ segments?: unknown }>();
  const rows = await tx(c, (t) =>
    domain.replaceLessonSegments(t, c.get("orgId"), c.req.param("id"), ranges(body.segments)),
  );
  return c.json(rows.map(serialize.lessonSegment));
});
