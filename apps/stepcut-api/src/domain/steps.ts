// Step editing — Phase 4 (docs/stepcut-plan.md §8: "Manual editing").
//
// Modeled on apps/api/src/domain/lessons.ts's split/merge/delete/patch
// semantics, simplified for a step's single `start`/`end` range: there is no
// `lesson_segments`-style child table here (schema.ts's header explains why),
// so there is no cached-bound recompute and no per-segment CRUD — a step's
// own `start`/`end` *is* the bound, settable directly by `updateStep`.
//
// The one rule carried over verbatim is `source`: any write here always
// leaves the row `source = 'manual'`, the same "AI proposes, a manual edit
// sticks" rule that keeps `analyze`'s replace-only-`'ai'`-rows pass
// (`apps/stepcut-worker/src/tasks/video.ts`'s `replaceAiSteps`) from ever
// clobbering something a human touched.

import { asc, eq } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { badRequest, notFound } from "../http/errors.js";
import { steps, videos } from "../db/schema.js";

export const newId = () => crypto.randomUUID();

export type StepRow = typeof steps.$inferSelect;

export async function queryStep(tx: Tx, id: string): Promise<StepRow> {
  const [row] = await tx.select().from(steps).where(eq(steps.id, id)).limit(1);
  if (!row) throw notFound(`step ${id}`);
  return row;
}

async function requireVideo(tx: Tx, videoId: string): Promise<void> {
  const [row] = await tx.select({ id: videos.id }).from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!row) throw notFound(`video ${videoId}`);
}

function validateRange(start: number, end: number): void {
  if (!(start < end)) {
    throw badRequest(`invalid step range: start (${start}) must be before end (${end})`);
  }
}

function requireTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw badRequest("step title must not be empty");
  return trimmed;
}

/**
 * Re-derives `sort_order` for all of a video's steps from `start` ascending.
 *
 * Own copy of `apps/api/src/domain/lessons.ts`'s `resequenceLessons` — called
 * after anything that inserts, removes, or moves a step's `start`, since any
 * of those can leave `sort_order` out of step with playback order. Ordering
 * is always by `sort_order` (`GET /videos/:id/steps`'s own query), never by
 * implicit row order.
 */
export async function resequenceSteps(tx: Tx, videoId: string): Promise<void> {
  const rows = await tx
    .select({ id: steps.id })
    .from(steps)
    .where(eq(steps.videoId, videoId))
    .orderBy(asc(steps.start), asc(steps.id));

  for (const [index, row] of rows.entries()) {
    await tx.update(steps).set({ sortOrder: index }).where(eq(steps.id, row.id));
  }
}

export interface StepPatch {
  start?: number;
  end?: number;
  title?: string;
  summary?: string;
}

/**
 * Patch semantics: an absent field is left unchanged. Any call here — even
 * one that only touches `title`/`summary` — flips `source` to `'manual'`, the
 * same "any touched row sticks" rule the plan's §5 step 4 calls out; a
 * boundary drag and a retitle are both "the human decided this," not just
 * the one that moves `start`/`end`.
 *
 * `confidence` is left alone rather than nulled out on a title-only edit —
 * it is informational (`serialize.step` still shows it), and only ever
 * matters for an AI-sourced row a human hasn't touched yet.
 */
export async function updateStep(tx: Tx, id: string, patch: StepPatch): Promise<StepRow> {
  const existing = await queryStep(tx, id);
  const nextStart = patch.start ?? existing.start;
  const nextEnd = patch.end ?? existing.end;
  if (patch.start !== undefined || patch.end !== undefined) validateRange(nextStart, nextEnd);

  const set: Partial<StepRow> = { start: nextStart, end: nextEnd, source: "manual", updatedAt: new Date() };
  if (patch.title !== undefined) set.title = requireTitle(patch.title);
  if (patch.summary !== undefined) set.summary = patch.summary;

  const [row] = await tx.update(steps).set(set).where(eq(steps.id, id)).returning();

  if (patch.start !== undefined) await resequenceSteps(tx, existing.videoId);
  return row;
}

/**
 * Splits a step at `atTime`, which must fall strictly inside its current
 * `[start, end)` — equal to either bound would produce a zero-length step.
 *
 * The original is truncated to `[start, atTime)`; a new step takes
 * `[atTime, end)`, copying its title (with " (cont.)", same convention
 * `splitLesson` uses) and summary. Both rows end up `source = 'manual'` —
 * splitting is itself a manual edit, on both halves.
 */
export async function splitStep(tx: Tx, orgId: string, id: string, atTime: number): Promise<StepRow[]> {
  const original = await queryStep(tx, id);
  if (!(atTime > original.start && atTime < original.end)) {
    throw badRequest(
      `split time ${atTime} must be strictly between the step's start (${original.start}) and end (${original.end})`,
    );
  }

  const [updatedOriginal] = await tx
    .update(steps)
    .set({ end: atTime, source: "manual", updatedAt: new Date() })
    .where(eq(steps.id, id))
    .returning();

  const newStepId = newId();
  const [created] = await tx
    .insert(steps)
    .values({
      id: newStepId,
      orgId,
      videoId: original.videoId,
      sortOrder: original.sortOrder,
      start: atTime,
      end: original.end,
      title: `${original.title} (cont.)`,
      summary: original.summary,
      source: "manual",
      confidence: null,
    })
    .returning();

  await resequenceSteps(tx, original.videoId);
  return [updatedOriginal, created];
}

/** Deletes a step. Unlike a lesson segment, a step has no child rows and no
 * "last one deletes the parent" special case — the video it belongs to is
 * untouched either way. */
export async function deleteStep(tx: Tx, id: string): Promise<void> {
  const existing = await queryStep(tx, id);
  await tx.delete(steps).where(eq(steps.id, id));
  await resequenceSteps(tx, existing.videoId);
}

/**
 * Adds a step by hand: `source = 'manual'`, `confidence = null`, same as any
 * other manually-produced row.
 */
export async function addStep(
  tx: Tx,
  orgId: string,
  videoId: string,
  input: { start: number; end: number; title: string; summary?: string },
): Promise<StepRow> {
  validateRange(input.start, input.end);
  const title = requireTitle(input.title);
  await requireVideo(tx, videoId);

  const [row] = await tx
    .insert(steps)
    .values({
      id: newId(),
      orgId,
      videoId,
      sortOrder: 0,
      start: input.start,
      end: input.end,
      title,
      summary: input.summary ?? null,
      source: "manual",
      confidence: null,
    })
    .returning();

  await resequenceSteps(tx, videoId);
  return row;
}
