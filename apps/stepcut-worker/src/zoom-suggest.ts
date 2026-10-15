// Zoom suggestions from on-screen change — the one piece of automated visual
// analysis StepCut runs (see `docs/stepcut-plan.md` §10 for why that's no
// longer ruled out, and why it's only ever a *suggestion*).
//
// StepCut's recordings are uploaded files with the cursor already baked in,
// so there is no click/cursor telemetry to drive auto-zoom the way a
// recorder that captured it can. What an uploaded file does have is pixels:
// when a user types into a field, opens a dropdown, or a dialog appears,
// a small part of the screen changes while the rest holds still. That
// localized change is what this scans for.
//
// The heuristics, in order:
//   1. Diff consecutive low-resolution grayscale frames; count changed pixels
//      and their bounding box.
//   2. A frame where a large share of the screen changed is a page change or
//      scroll — not a zoom target — and breaks any activity cluster in
//      progress.
//   3. Localized changes close together in time and space join one cluster.
//   4. Clusters over the same spot a few seconds apart (something appearing,
//      then disappearing) merge into one.
//   5. A cluster with enough total change becomes a suggestion: its span
//      padded a little before and after, focused on the cluster's box, scaled
//      so the box fills most of the frame.
//
// Pure — no ffmpeg, no database — so the tuning can be exercised on synthetic
// frames.

import type { ZoomRegion } from "./effects.js";

export const ANALYSIS_WIDTH = 320;
export const ANALYSIS_HEIGHT = 180;
export const ANALYSIS_FPS = 4;

/** Luma difference (0..255) that counts a pixel as changed — above typical
 * compression noise, below any real UI change. */
const PIXEL_DIFF_THRESHOLD = 28;
/** Share of the frame changing at once that means "page change or scroll". */
const GLOBAL_CHANGE_FRACTION = 0.2;
/** Fewer changed pixels than this in a frame is noise (or a cursor blink). */
const MIN_FRAME_CHANGED_PIXELS = 12;
/** A later change joins the running cluster if it lands within this long. */
const CLUSTER_GAP_SECS = 1.5;
/** …and the cluster's combined box stays under this share of the frame. */
const MAX_CLUSTER_AREA = 0.3;
/** A cluster needs this much change overall to be worth a zoom. A cursor
 * gliding across a still screen changes a few dozen pixels a frame; typing a
 * word or opening a menu changes far more. */
const MIN_CLUSTER_CHANGED_PIXELS = 400;
/** Two clusters over overlapping parts of the screen this close together are
 * one moment — a dropdown opening and, a few seconds later, closing — not
 * two separate zooms. */
const MERGE_GAP_SECS = 4;
const LEAD_IN_SECS = 0.6;
const HOLD_AFTER_SECS = 1.6;
const MIN_REGION_SECS = 2;
/** The box should fill about this share of the zoomed frame. */
const TARGET_FILL = 0.6;
const MIN_SCALE = 1.3;
const MAX_SCALE = 2.4;
/** At most one suggestion per this many seconds of video — more than that and
 * the result reads as a seasick render rather than emphasis. */
const SECS_PER_SUGGESTION = 6;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Cluster {
  firstT: number;
  lastT: number;
  box: Box;
  changed: number;
}

export interface ZoomSuggestion extends ZoomRegion {
  /** Total changed pixels in the cluster — how confident the suggestion is,
   * roughly; used to keep the strongest when there are too many. */
  strength: number;
}

function union(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function intersects(a: Box, b: Box): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

function area(box: Box, width: number, height: number): number {
  return ((box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1)) / (width * height);
}

/** Changed-pixel count and bounding box between two frames. */
function diffFrames(prev: Uint8Array, next: Uint8Array, width: number): { changed: number; box: Box | undefined } {
  let changed = 0;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < next.length; i++) {
    if (Math.abs(next[i] - prev[i]) <= PIXEL_DIFF_THRESHOLD) continue;
    changed++;
    const x = i % width;
    const y = (i - x) / width;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { changed, box: changed > 0 ? { x0, y0, x1, y1 } : undefined };
}

function toSuggestion(cluster: Cluster, width: number, height: number, duration: number): ZoomSuggestion | undefined {
  if (cluster.changed < MIN_CLUSTER_CHANGED_PIXELS) return undefined;

  const boxW = (cluster.box.x1 - cluster.box.x0 + 1) / width;
  const boxH = (cluster.box.y1 - cluster.box.y0 + 1) / height;
  const fit = Math.min(TARGET_FILL / boxW, TARGET_FILL / boxH);
  if (fit < MIN_SCALE) return undefined; // too much of the screen to be worth zooming into
  const scale = Math.round(Math.min(MAX_SCALE, fit) * 10) / 10;

  let start = Math.max(0, cluster.firstT - LEAD_IN_SECS);
  let end = Math.min(duration, cluster.lastT + HOLD_AFTER_SECS);
  if (end - start < MIN_REGION_SECS) {
    end = Math.min(duration, start + MIN_REGION_SECS);
    start = Math.max(0, end - MIN_REGION_SECS);
  }
  if (end - start < MIN_REGION_SECS / 2) return undefined;

  return {
    start: Math.round(start * 100) / 100,
    end: Math.round(end * 100) / 100,
    scale,
    focusX: Math.round(((cluster.box.x0 + cluster.box.x1 + 1) / 2 / width) * 1000) / 1000,
    focusY: Math.round(((cluster.box.y0 + cluster.box.y1 + 1) / 2 / height) * 1000) / 1000,
    strength: cluster.changed,
  };
}

/**
 * Scans `frames` (grayscale, `width × height`, sampled at `fps`) and returns
 * non-overlapping zoom suggestions in source seconds, sorted by start, that
 * avoid every range in `occupied` (the video's existing zoom regions).
 */
export async function suggestZooms(
  frames: AsyncIterable<Uint8Array>,
  options: {
    width: number;
    height: number;
    fps: number;
    duration: number;
    occupied: ReadonlyArray<{ start: number; end: number }>;
  },
): Promise<ZoomSuggestion[]> {
  const { width, height, fps, duration } = options;
  const frameArea = width * height;
  const clusters: Cluster[] = [];
  let cluster: Cluster | undefined;
  let prev: Uint8Array | undefined;
  let index = 0;
  // A page change between two clusters means they're on different screens,
  // however close in time and position — never merge across one.
  let pageChangedSinceLastCluster = false;

  const close = () => {
    if (!cluster) return;
    const last = clusters.at(-1);
    const joined = last ? union(last.box, cluster.box) : cluster.box;
    if (
      last &&
      !pageChangedSinceLastCluster &&
      cluster.firstT - last.lastT <= MERGE_GAP_SECS &&
      intersects(last.box, cluster.box) &&
      area(joined, width, height) <= MAX_CLUSTER_AREA
    ) {
      last.lastT = cluster.lastT;
      last.box = joined;
      last.changed += cluster.changed;
    } else {
      clusters.push(cluster);
    }
    cluster = undefined;
    pageChangedSinceLastCluster = false;
  };

  for await (const frame of frames) {
    const t = index / fps;
    index++;
    if (prev) {
      const { changed, box } = diffFrames(prev, frame, width);
      if (changed / frameArea >= GLOBAL_CHANGE_FRACTION) {
        close();
        pageChangedSinceLastCluster = true;
      } else if (box && changed >= MIN_FRAME_CHANGED_PIXELS) {
        const joined = cluster ? union(cluster.box, box) : box;
        if (cluster && t - cluster.lastT <= CLUSTER_GAP_SECS && area(joined, width, height) <= MAX_CLUSTER_AREA) {
          cluster.lastT = t;
          cluster.box = joined;
          cluster.changed += changed;
        } else {
          close();
          cluster = { firstT: t, lastT: t, box, changed };
        }
      } else if (cluster && t - cluster.lastT > CLUSTER_GAP_SECS) {
        close();
      }
    }
    prev = frame;
  }
  close();

  const candidates = clusters.flatMap((c) => toSuggestion(c, width, height, duration) ?? []);

  // Too many: keep the strongest, then restore time order.
  const limit = Math.max(1, Math.ceil(duration / SECS_PER_SUGGESTION));
  const kept = [...candidates].sort((a, b) => b.strength - a.strength).slice(0, limit);
  kept.sort((a, b) => a.start - b.start);

  // Never overlap an existing region or each other: trim the later one's
  // start, dropping it if too little is left.
  const taken: Array<{ start: number; end: number }> = [...options.occupied];
  const result: ZoomSuggestion[] = [];
  for (const suggestion of kept) {
    let start = suggestion.start;
    for (const range of taken) {
      if (range.start < suggestion.end && range.end > start) start = Math.max(start, range.end);
    }
    const overlapsLater = taken.some((range) => range.start >= start && range.start < suggestion.end);
    if (overlapsLater || suggestion.end - start < MIN_REGION_SECS / 2) continue;
    const trimmed = { ...suggestion, start: Math.round(start * 100) / 100 };
    result.push(trimmed);
    taken.push(trimmed);
  }
  return result;
}
