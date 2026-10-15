// Zoom and speed regions — timed effects on a video's source timeline (see
// `db/schema.ts`'s "Effects" section for why they belong to the video rather
// than to a step).
//
// Same shape of rules `domain/steps.ts` enforces for steps: validate the
// range, and any human write leaves a zoom region `source = 'manual'`. On top
// of that, regions of one kind may not overlap each other — two zooms at once
// have no sensible single camera position, and two rates at once no sensible
// speed. Touching end-to-start is fine.

import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { badRequest, notFound } from "../http/errors.js";
import { speedRegions, videos, zoomRegions, type RenderEffects } from "../db/schema.js";

export const newId = () => crypto.randomUUID();

export type ZoomRegionRow = typeof zoomRegions.$inferSelect;
export type SpeedRegionRow = typeof speedRegions.$inferSelect;

/** Bounds a render can actually use: below 1.1× a zoom is imperceptible,
 * past 4× a 1080p recording is mush. */
export const MIN_ZOOM_SCALE = 1.1;
export const MAX_ZOOM_SCALE = 4;
/** `atempo` handles this range cleanly (chained below 0.5 — see the worker's
 * `effects.ts`); outside it narration becomes unintelligible anyway. */
export const MIN_SPEED_RATE = 0.25;
export const MAX_SPEED_RATE = 4;
/** A zoom shorter than this can't ease in and out visibly. */
const MIN_ZOOM_SECS = 0.5;
const MIN_SPEED_SECS = 0.2;

async function requireVideo(tx: Tx, videoId: string): Promise<void> {
  const [row] = await tx.select({ id: videos.id }).from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!row) throw notFound(`video ${videoId}`);
}

/**
 * Serializes region writes per video for the rest of the transaction. The
 * overlap checks below are read-then-write, so without this two concurrent
 * requests (a double click, two tabs, a suggestion job landing) could each
 * pass the check and insert overlapping regions — which the worker would
 * then stack into one exaggerated zoom the preview never showed.
 */
async function lockVideoEffects(tx: Tx, videoId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`effects:${videoId}`}))`);
}

function validateRange(start: number, end: number, minLength: number, what: string): void {
  if (!(start >= 0)) throw badRequest(`${what} start must not be negative`);
  if (!(end - start >= minLength)) {
    throw badRequest(`${what} must be at least ${minLength}s long (start ${start}, end ${end})`);
  }
}

function validateBetween(field: string, value: number, min: number, max: number): number {
  if (!(value >= min && value <= max)) throw badRequest(`${field} must be from ${min} to ${max}`);
  return value;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listEffects(
  tx: Tx,
  videoId: string,
): Promise<{ zooms: ZoomRegionRow[]; speeds: SpeedRegionRow[] }> {
  await requireVideo(tx, videoId);
  const [zooms, speeds] = await Promise.all([
    tx.select().from(zoomRegions).where(eq(zoomRegions.videoId, videoId)).orderBy(asc(zoomRegions.start)),
    tx.select().from(speedRegions).where(eq(speedRegions.videoId, videoId)).orderBy(asc(speedRegions.start)),
  ]);
  return { zooms, speeds };
}

/** What `createRender` snapshots: accepted zooms only — an unaccepted
 * suggestion is a proposal, not part of the video yet. */
export async function snapshotEffects(tx: Tx, videoId: string): Promise<RenderEffects> {
  const { zooms, speeds } = await listEffects(tx, videoId);
  return {
    zooms: zooms
      .filter((z) => z.source === "manual")
      .map((z) => ({ start: z.start, end: z.end, scale: z.scale, focus_x: z.focusX, focus_y: z.focusY })),
    speeds: speeds.map((s) => ({ start: s.start, end: s.end, rate: s.rate })),
  };
}

// ---------------------------------------------------------------------------
// Zoom regions
// ---------------------------------------------------------------------------

export interface ZoomInput {
  start: number;
  end: number;
  scale: number;
  focusX: number;
  focusY: number;
}

function validateZoom(input: ZoomInput): void {
  validateRange(input.start, input.end, MIN_ZOOM_SECS, "zoom");
  validateBetween("scale", input.scale, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE);
  validateBetween("focus_x", input.focusX, 0, 1);
  validateBetween("focus_y", input.focusY, 0, 1);
}

/**
 * Refuses a zoom that overlaps another *accepted* one. A pending suggestion
 * in the way is removed instead — the person just placed a zoom there by
 * hand, which is the clearest possible answer to that suggestion.
 */
async function clearZoomSpace(tx: Tx, videoId: string, range: ZoomInput, exceptId?: string): Promise<void> {
  const others = await tx
    .select()
    .from(zoomRegions)
    .where(
      exceptId
        ? and(eq(zoomRegions.videoId, videoId), ne(zoomRegions.id, exceptId))
        : eq(zoomRegions.videoId, videoId),
    );
  for (const other of others) {
    if (!overlaps(other, range)) continue;
    if (other.source === "suggested") {
      await tx.delete(zoomRegions).where(eq(zoomRegions.id, other.id));
      continue;
    }
    throw badRequest(`this zoom overlaps another one (${other.start.toFixed(2)}s–${other.end.toFixed(2)}s)`);
  }
}

export async function addZoom(tx: Tx, orgId: string, videoId: string, input: ZoomInput): Promise<ZoomRegionRow> {
  validateZoom(input);
  await requireVideo(tx, videoId);
  await lockVideoEffects(tx, videoId);
  await clearZoomSpace(tx, videoId, input);
  const [row] = await tx
    .insert(zoomRegions)
    .values({ id: newId(), orgId, videoId, ...input, source: "manual" })
    .returning();
  return row;
}

async function queryZoom(tx: Tx, id: string): Promise<ZoomRegionRow> {
  const [row] = await tx.select().from(zoomRegions).where(eq(zoomRegions.id, id)).limit(1);
  if (!row) throw notFound(`zoom region ${id}`);
  return row;
}

/** Patch semantics like `updateStep`: absent fields are unchanged, and any
 * write — including an empty patch, which is how the UI accepts a
 * suggestion as-is — leaves the row `'manual'`. */
export async function updateZoom(tx: Tx, id: string, patch: Partial<ZoomInput>): Promise<ZoomRegionRow> {
  const existing = await queryZoom(tx, id);
  const next: ZoomInput = {
    start: patch.start ?? existing.start,
    end: patch.end ?? existing.end,
    scale: patch.scale ?? existing.scale,
    focusX: patch.focusX ?? existing.focusX,
    focusY: patch.focusY ?? existing.focusY,
  };
  validateZoom(next);
  await lockVideoEffects(tx, existing.videoId);
  await clearZoomSpace(tx, existing.videoId, next, id);
  const [row] = await tx
    .update(zoomRegions)
    .set({ ...next, source: "manual", updatedAt: new Date() })
    .where(eq(zoomRegions.id, id))
    .returning();
  return row;
}

export async function deleteZoom(tx: Tx, id: string): Promise<void> {
  await queryZoom(tx, id);
  await tx.delete(zoomRegions).where(eq(zoomRegions.id, id));
}

/** Removes every pending suggestion on a video — "Dismiss all". */
export async function dismissZoomSuggestions(tx: Tx, videoId: string): Promise<void> {
  await requireVideo(tx, videoId);
  await tx.delete(zoomRegions).where(and(eq(zoomRegions.videoId, videoId), eq(zoomRegions.source, "suggested")));
}

/**
 * Replaces a video's pending suggestions with `suggestions` — the worker's
 * `zooms` job. Accepted (`'manual'`) regions are never touched, and a
 * suggestion that would overlap one is skipped rather than inserted.
 */
export async function replaceZoomSuggestions(
  tx: Tx,
  orgId: string,
  videoId: string,
  suggestions: readonly ZoomInput[],
): Promise<void> {
  await lockVideoEffects(tx, videoId);
  await tx.delete(zoomRegions).where(and(eq(zoomRegions.videoId, videoId), eq(zoomRegions.source, "suggested")));
  const accepted = await tx.select().from(zoomRegions).where(eq(zoomRegions.videoId, videoId));
  const placed: Array<{ start: number; end: number }> = [...accepted];
  for (const suggestion of suggestions) {
    try {
      validateZoom(suggestion);
    } catch {
      continue;
    }
    if (placed.some((range) => overlaps(range, suggestion))) continue;
    await tx.insert(zoomRegions).values({ id: newId(), orgId, videoId, ...suggestion, source: "suggested" });
    placed.push(suggestion);
  }
}

// ---------------------------------------------------------------------------
// Speed regions
// ---------------------------------------------------------------------------

export interface SpeedInput {
  start: number;
  end: number;
  rate: number;
}

function validateSpeed(input: SpeedInput): void {
  validateRange(input.start, input.end, MIN_SPEED_SECS, "speed region");
  validateBetween("rate", input.rate, MIN_SPEED_RATE, MAX_SPEED_RATE);
}

async function assertSpeedSpace(tx: Tx, videoId: string, range: SpeedInput, exceptId?: string): Promise<void> {
  const others = await tx
    .select()
    .from(speedRegions)
    .where(
      exceptId
        ? and(eq(speedRegions.videoId, videoId), ne(speedRegions.id, exceptId))
        : eq(speedRegions.videoId, videoId),
    );
  const clash = others.find((other) => overlaps(other, range));
  if (clash) {
    throw badRequest(
      `this speed region overlaps another one (${clash.start.toFixed(2)}s–${clash.end.toFixed(2)}s)`,
    );
  }
}

export async function addSpeed(tx: Tx, orgId: string, videoId: string, input: SpeedInput): Promise<SpeedRegionRow> {
  validateSpeed(input);
  await requireVideo(tx, videoId);
  await lockVideoEffects(tx, videoId);
  await assertSpeedSpace(tx, videoId, input);
  const [row] = await tx.insert(speedRegions).values({ id: newId(), orgId, videoId, ...input }).returning();
  return row;
}

async function querySpeed(tx: Tx, id: string): Promise<SpeedRegionRow> {
  const [row] = await tx.select().from(speedRegions).where(eq(speedRegions.id, id)).limit(1);
  if (!row) throw notFound(`speed region ${id}`);
  return row;
}

export async function updateSpeed(tx: Tx, id: string, patch: Partial<SpeedInput>): Promise<SpeedRegionRow> {
  const existing = await querySpeed(tx, id);
  const next: SpeedInput = {
    start: patch.start ?? existing.start,
    end: patch.end ?? existing.end,
    rate: patch.rate ?? existing.rate,
  };
  validateSpeed(next);
  await lockVideoEffects(tx, existing.videoId);
  await assertSpeedSpace(tx, existing.videoId, next, id);
  const [row] = await tx
    .update(speedRegions)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(speedRegions.id, id))
    .returning();
  return row;
}

export async function deleteSpeed(tx: Tx, id: string): Promise<void> {
  await querySpeed(tx, id);
  await tx.delete(speedRegions).where(eq(speedRegions.id, id));
}
