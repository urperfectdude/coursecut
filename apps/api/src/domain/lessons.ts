// Lesson and lesson-segment editing, ported from `src-tauri/src/db.rs`.
//
// This is the one part of `apps/api` that is a genuine port rather than new
// code, and it is deliberately a close one: the same invariants, the same
// validation messages, the same order of operations. The web app is supposed
// to *be* the desktop app (plan §0), and "Split at playhead" producing a
// differently-shaped result in a browser would be exactly the kind of drift
// §7.1 exists to prevent — except this half of it no `ui-drift.sh` can catch,
// because it is not UI.
//
// Two rules carried over verbatim, both worth restating because they look
// like oversights:
//
//   * **`lessons.start`/`.end` are a cached derived bound**, min/max across
//     the lesson's segments, recomputed after every segment write rather than
//     maintained by a trigger. Desktop calls this `recompute_lesson_bounds_tx`.
//   * **No overlap validation**, segment-vs-segment within a lesson or
//     lesson-vs-lesson. Desktop allows both on purpose.
//
// One addition the desktop has no need for: every insert stamps `org_id`.
// RLS's `WITH CHECK` rejects a row stamped with anyone else's, and the
// composite foreign keys make a child whose org differs from its parent's
// unrepresentable (plan §6) — so the stamping is checked twice by the
// database rather than trusted.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { badRequest, notFound } from "../http/errors.js";
import { lessonSegments, lessons, videos } from "../db/schema.js";

export const newId = () => crypto.randomUUID();

export type LessonRow = typeof lessons.$inferSelect;
export type LessonSegmentRow = typeof lessonSegments.$inferSelect;

export interface SegmentRange {
  start: number;
  end: number;
}

export async function queryLesson(tx: Tx, id: string): Promise<LessonRow> {
  const [row] = await tx.select().from(lessons).where(eq(lessons.id, id)).limit(1);
  if (!row) throw notFound(`lesson ${id}`);
  return row;
}

export async function queryLessonSegment(tx: Tx, id: string): Promise<LessonSegmentRow> {
  const [row] = await tx.select().from(lessonSegments).where(eq(lessonSegments.id, id)).limit(1);
  if (!row) throw notFound(`lesson segment ${id}`);
  return row;
}

export async function requireVideo(tx: Tx, videoId: string): Promise<void> {
  const [row] = await tx.select({ id: videos.id }).from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!row) throw notFound(`video ${videoId}`);
}

function validateRange({ start, end }: SegmentRange): void {
  if (!(start < end)) {
    throw badRequest(`invalid segment range: start (${start}) must be before end (${end})`);
  }
}

/**
 * Recomputes a lesson's cached `start`/`end` from its current segments.
 *
 * A lesson with no segments left keeps its stale bound rather than being
 * zeroed — same as desktop, and it does not matter in practice because
 * `deleteLessonSegment` deletes the lesson instead of leaving it empty.
 */
export async function recomputeLessonBounds(tx: Tx, lessonId: string): Promise<void> {
  const rows = await tx
    .select({ start: lessonSegments.start, end: lessonSegments.end })
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, lessonId));
  if (rows.length === 0) return;

  await tx
    .update(lessons)
    .set({
      start: Math.min(...rows.map((row) => row.start)),
      end: Math.max(...rows.map((row) => row.end)),
    })
    .where(eq(lessons.id, lessonId));
}

/**
 * Re-derives `sort_order` for all of a video's lessons from `start` ascending.
 *
 * Called after anything that inserts or removes a lesson, since those leave a
 * gap or a duplicate. Ordering is always by `sort_order`, never by implicit
 * row order — the data-model skill is explicit about that.
 */
export async function resequenceLessons(tx: Tx, videoId: string): Promise<void> {
  const rows = await tx
    .select({ id: lessons.id })
    .from(lessons)
    .where(eq(lessons.videoId, videoId))
    .orderBy(asc(lessons.start), asc(lessons.id));

  for (const [index, row] of rows.entries()) {
    await tx.update(lessons).set({ sortOrder: index }).where(eq(lessons.id, row.id));
  }
}

/** Appends a segment (always last), then resyncs bounds and lesson ordering. */
export async function addLessonSegment(
  tx: Tx,
  orgId: string,
  lessonId: string,
  range: SegmentRange,
): Promise<LessonSegmentRow> {
  validateRange(range);
  const lesson = await queryLesson(tx, lessonId);

  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, lessonId));

  const [row] = await tx
    .insert(lessonSegments)
    .values({
      id: newId(),
      orgId,
      lessonId,
      start: range.start,
      end: range.end,
      sortOrder: count,
    })
    .returning();

  await recomputeLessonBounds(tx, lessonId);
  await resequenceLessons(tx, lesson.videoId);
  return row;
}

export async function updateLessonSegment(
  tx: Tx,
  id: string,
  range: SegmentRange,
): Promise<LessonSegmentRow> {
  validateRange(range);
  const existing = await queryLessonSegment(tx, id);

  const [row] = await tx
    .update(lessonSegments)
    .set({ start: range.start, end: range.end })
    .where(eq(lessonSegments.id, id))
    .returning();

  await recomputeLessonBounds(tx, existing.lessonId);
  const lesson = await queryLesson(tx, existing.lessonId);
  await resequenceLessons(tx, lesson.videoId);
  return row;
}

export interface DeleteLessonSegmentResult {
  lesson_id: string;
  lesson_deleted: boolean;
}

/**
 * Deletes a segment — or, if it was the lesson's last one, the lesson itself.
 * A lesson with zero segments is not meaningful and would be left rendering a
 * stale cached bound, so the caller is told which happened instead.
 */
export async function deleteLessonSegment(tx: Tx, id: string): Promise<DeleteLessonSegmentResult> {
  const segment = await queryLessonSegment(tx, id);

  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, segment.lessonId));

  if (count <= 1) {
    // The lesson's ON DELETE CASCADE takes this segment with it.
    await deleteLesson(tx, segment.lessonId);
    return { lesson_id: segment.lessonId, lesson_deleted: true };
  }

  await tx.delete(lessonSegments).where(eq(lessonSegments.id, id));
  await recomputeLessonBounds(tx, segment.lessonId);
  const lesson = await queryLesson(tx, segment.lessonId);
  await resequenceLessons(tx, lesson.videoId);
  return { lesson_id: segment.lessonId, lesson_deleted: false };
}

/**
 * All-or-nothing reorder: `orderedIds` must be exactly the current set. A
 * partial list is rejected rather than silently applied, which would leave
 * `sort_order` in a mixed state nobody can reason about.
 *
 * Doesn't touch the lesson's cached bound — reordering changes playback
 * sequence, not any segment's own range, so min/max cannot have moved.
 */
export async function reorderLessonSegments(
  tx: Tx,
  lessonId: string,
  orderedIds: string[],
): Promise<void> {
  const existing = await tx
    .select({ id: lessonSegments.id })
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, lessonId));

  assertExactSet(
    orderedIds,
    existing.map((row) => row.id),
    `ordered_ids must exactly match lesson ${lessonId}'s current segments — no missing or extra ids`,
  );

  for (const [index, id] of orderedIds.entries()) {
    await tx.update(lessonSegments).set({ sortOrder: index }).where(eq(lessonSegments.id, id));
  }
}

function assertExactSet(given: string[], existing: string[], message: string): void {
  const givenSet = new Set(given);
  if (givenSet.size !== given.length) throw badRequest("ordered_ids contains duplicate ids");
  const existingSet = new Set(existing);
  if (givenSet.size !== existingSet.size || [...givenSet].some((id) => !existingSet.has(id))) {
    throw badRequest(message);
  }
}

/**
 * A manually-built lesson: `source = 'manual'`, `confidence = NULL`,
 * `kind = 'lesson'`, one segment row per range in the order given.
 *
 * `source !== 'ai'` is what keeps re-analysis from deleting it — the analyze
 * job replaces only the AI-sourced rows.
 *
 * `start`/`end` and `sort_order` go in as placeholders and are corrected by
 * the two resync calls, rather than being computed twice in two places. The
 * effect on ordering is worth knowing: the new lesson lands wherever its
 * earliest segment falls chronologically, not last.
 */
export async function createLesson(
  tx: Tx,
  orgId: string,
  videoId: string,
  title: string,
  segments: SegmentRange[],
): Promise<LessonRow> {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw badRequest("lesson title must not be empty");
  const first = segments[0];
  if (!first) throw badRequest("a lesson needs at least one segment");
  segments.forEach(validateRange);

  await requireVideo(tx, videoId);

  const id = newId();
  await tx.insert(lessons).values({
    id,
    orgId,
    videoId,
    title: trimmed,
    summary: null,
    start: first.start,
    end: first.end,
    sortOrder: 0,
    confidence: null,
    kind: "lesson",
    source: "manual",
  });

  await tx.insert(lessonSegments).values(
    segments.map((range, index) => ({
      id: newId(),
      orgId,
      lessonId: id,
      start: range.start,
      end: range.end,
      sortOrder: index,
    })),
  );

  await recomputeLessonBounds(tx, id);
  await resequenceLessons(tx, videoId);
  return queryLesson(tx, id);
}

/**
 * Splits one of a lesson's segments at `atTime`, which must fall strictly
 * inside that segment's `[start, end)` — equal to either boundary would
 * produce a zero-length segment.
 *
 * The segment is truncated to `[start, atTime)`; a **new lesson** takes
 * `[atTime, end)`, copying title (with " (cont.)"), summary, kind, confidence
 * and source. Returns both lessons.
 */
export async function splitLesson(
  tx: Tx,
  orgId: string,
  lessonId: string,
  segmentId: string,
  atTime: number,
): Promise<LessonRow[]> {
  const original = await queryLesson(tx, lessonId);
  const segment = await queryLessonSegment(tx, segmentId);

  if (segment.lessonId !== original.id) {
    throw badRequest(`segment ${segmentId} does not belong to lesson ${lessonId}`);
  }
  if (!(atTime > segment.start && atTime < segment.end)) {
    throw badRequest(
      `split time ${atTime} must be strictly between the segment's start (${segment.start}) and end (${segment.end})`,
    );
  }

  await tx.update(lessonSegments).set({ end: atTime }).where(eq(lessonSegments.id, segmentId));

  const newLessonId = newId();
  await tx.insert(lessons).values({
    id: newLessonId,
    orgId,
    videoId: original.videoId,
    title: `${original.title} (cont.)`,
    summary: original.summary,
    start: atTime,
    end: segment.end,
    sortOrder: original.sortOrder,
    confidence: original.confidence,
    kind: original.kind,
    source: original.source,
  });
  await tx.insert(lessonSegments).values({
    id: newId(),
    orgId,
    lessonId: newLessonId,
    start: atTime,
    end: segment.end,
    sortOrder: 0,
  });

  await recomputeLessonBounds(tx, lessonId);
  await recomputeLessonBounds(tx, newLessonId);
  await resequenceLessons(tx, original.videoId);

  return [await queryLesson(tx, lessonId), await queryLesson(tx, newLessonId)];
}

/**
 * Merges `secondId` into `firstId`: the second's segments are re-pointed and
 * appended after the first's, concatenating the two segment lists rather than
 * widening a single range. Title is left alone; summaries are newline-joined
 * when both are non-empty. `secondId`'s row is deleted.
 */
export async function mergeLessons(tx: Tx, firstId: string, secondId: string): Promise<LessonRow> {
  const first = await queryLesson(tx, firstId);
  const second = await queryLesson(tx, secondId);

  if (first.videoId !== second.videoId) {
    throw badRequest("cannot merge lessons belonging to different videos");
  }

  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, firstId));

  const moving = await tx
    .select({ id: lessonSegments.id })
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, secondId))
    .orderBy(asc(lessonSegments.sortOrder), asc(lessonSegments.id));

  for (const [offset, row] of moving.entries()) {
    await tx
      .update(lessonSegments)
      .set({ lessonId: firstId, sortOrder: count + offset })
      .where(eq(lessonSegments.id, row.id));
  }

  const nonEmpty = (summary: string | null) => {
    const text = summary?.trim();
    return text ? text : null;
  };
  const a = nonEmpty(first.summary);
  const b = nonEmpty(second.summary);
  const mergedSummary = a && b ? `${a}\n${b}` : (a ?? b);

  await tx.update(lessons).set({ summary: mergedSummary }).where(eq(lessons.id, firstId));
  await tx.delete(lessons).where(eq(lessons.id, secondId));

  await recomputeLessonBounds(tx, firstId);
  await resequenceLessons(tx, first.videoId);
  return queryLesson(tx, firstId);
}

/**
 * Patch semantics for `title`/`summary`: an absent field is left unchanged.
 *
 * `start`/`end` are deliberately not settable — since 0006 they are a cached
 * bound derived from the lesson's segments, moved only by segment CRUD or
 * split/merge.
 */
export async function updateLesson(
  tx: Tx,
  id: string,
  patch: { title?: string; summary?: string },
): Promise<LessonRow> {
  const existing = await queryLesson(tx, id);
  if (patch.title === undefined && patch.summary === undefined) return existing;

  const [row] = await tx.update(lessons).set(patch).where(eq(lessons.id, id)).returning();
  return row;
}

export async function deleteLesson(tx: Tx, id: string): Promise<void> {
  const lesson = await queryLesson(tx, id);
  await tx.delete(lessons).where(eq(lessons.id, id));
  await resequenceLessons(tx, lesson.videoId);
}

export async function reorderLessons(tx: Tx, videoId: string, orderedIds: string[]): Promise<void> {
  const existing = await tx
    .select({ id: lessons.id })
    .from(lessons)
    .where(eq(lessons.videoId, videoId));

  assertExactSet(
    orderedIds,
    existing.map((row) => row.id),
    `ordered_ids must exactly match video ${videoId}'s current lessons — no missing or extra ids`,
  );

  for (const [index, id] of orderedIds.entries()) {
    await tx.update(lessons).set({ sortOrder: index }).where(eq(lessons.id, id));
  }
}

/**
 * Replaces a lesson's segments wholesale — what "Apply" on the AI segment-edit
 * review popup commits.
 *
 * An empty list is rejected rather than being allowed to delete the lesson as
 * a side effect: the popup's job is to edit a lesson, and a prompt that
 * happens to select nothing should fail visibly, not silently destroy work.
 */
export async function replaceLessonSegments(
  tx: Tx,
  orgId: string,
  lessonId: string,
  ranges: SegmentRange[],
): Promise<LessonSegmentRow[]> {
  if (ranges.length === 0) throw badRequest("An edit must leave at least one segment.");
  ranges.forEach(validateRange);

  const lesson = await queryLesson(tx, lessonId);
  await tx.delete(lessonSegments).where(eq(lessonSegments.lessonId, lessonId));
  await tx.insert(lessonSegments).values(
    ranges.map((range, index) => ({
      id: newId(),
      orgId,
      lessonId,
      start: range.start,
      end: range.end,
      sortOrder: index,
    })),
  );

  await recomputeLessonBounds(tx, lessonId);
  await resequenceLessons(tx, lesson.videoId);
  return listLessonSegments(tx, lessonId);
}

/** A lesson's segments in playback (`sort_order`) order. */
export function listLessonSegments(tx: Tx, lessonId: string): Promise<LessonSegmentRow[]> {
  return tx
    .select()
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, lessonId))
    .orderBy(asc(lessonSegments.sortOrder), asc(lessonSegments.id));
}

/** Lessons for a video, in the order the UI renders them. */
export function listLessons(tx: Tx, videoId: string): Promise<LessonRow[]> {
  return tx
    .select()
    .from(lessons)
    .where(eq(lessons.videoId, videoId))
    .orderBy(asc(lessons.sortOrder), asc(lessons.start));
}

/** Lessons by id, used to validate an export request's whole batch at once. */
export function lessonsByIds(tx: Tx, ids: string[]): Promise<LessonRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return tx.select().from(lessons).where(inArray(lessons.id, ids));
}

/** Lessons a re-analysis is allowed to replace — the AI-sourced ones only. */
export function aiLessonIds(tx: Tx, videoId: string) {
  return tx
    .select({ id: lessons.id })
    .from(lessons)
    .where(and(eq(lessons.videoId, videoId), eq(lessons.source, "ai")));
}
