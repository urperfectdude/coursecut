/*
 * Word editing as lesson segment edits (docs/text-editing-plan.md, "Per-
 * lesson cuts"). Removing words cuts them out of the lesson's segments,
 * which splits a segment into two rows; restoring them joins rows back.
 * The segments are the only edit state, so preview and export already
 * follow them, and every edit is undone like any other segment edit.
 *
 * Pure functions over ranges in source seconds, in the lesson's own
 * segment order (which need not be time order).
 */

export interface Range {
  start: number;
  end: number;
}

/** A piece left over by a cut shorter than this is dropped, rather than
 * becoming a sliver row, unless a word starts inside it (then it's kept:
 * dropping it would silently remove a word nobody selected). */
export const MIN_PIECE_S = 0.3;
/** Two edges this close count as touching. */
const EDGE_EPS_S = 0.02;
/** Segments further apart than this are separate blocks in the Script tab:
 * the gap is shown as "not in this lesson" instead of as removed words. */
export const MAX_SCRIPT_GAP_S = 60;

/** Whether any of `starts` (sorted) is in [from, to). */
export function hasStartIn(starts: readonly number[], from: number, to: number): boolean {
  if (to <= from) return false;
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < starts.length && starts[lo] < to;
}

/** Cuts `cut` out of every segment it overlaps. A segment can become two
 * (a new row), shrink, or disappear. Order is kept. `wordStarts` (sorted)
 * protects leftover pieces that contain a word. */
export function cutRange(
  segments: readonly Range[],
  cut: Range,
  wordStarts: readonly number[] = [],
  minPiece = MIN_PIECE_S,
): Range[] {
  const keep = (piece: Range) =>
    piece.end - piece.start >= minPiece ||
    (piece.end > piece.start && hasStartIn(wordStarts, piece.start, piece.end));
  const out: Range[] = [];
  for (const segment of segments) {
    if (cut.end <= segment.start || cut.start >= segment.end) {
      out.push(segment);
      continue;
    }
    const left = { start: segment.start, end: Math.max(segment.start, cut.start) };
    const right = { start: Math.min(segment.end, cut.end), end: segment.end };
    if (keep(left)) out.push(left);
    if (keep(right)) out.push(right);
  }
  return out;
}

/** Applies several cuts in turn. */
export function cutRanges(
  segments: readonly Range[],
  cuts: readonly Range[],
  wordStarts: readonly number[] = [],
): Range[] {
  return cuts.reduce<Range[]>((acc, cut) => cutRange(acc, cut, wordStarts), [...segments]);
}

/**
 * Puts `restore` back into the lesson:
 *
 * - **In a gap between two consecutive rows that run forward in time** (a
 *   gap a cut made): covering the whole gap joins the rows; reaching one
 *   side extends that row; the middle of a gap becomes a new row between.
 * - **Just before the lesson's first row of a block, or just after its last**
 *   (a cut at the lesson's edge): that row is extended, or a new row is
 *   added beside it if removed words lie in between.
 *
 * "Reaching a side" means no word starts in the bit of gap left over, so
 * restoring words one by one doesn't leave invisible silent cuts between
 * them. Without `wordStarts`, it means within `EDGE_EPS_S`.
 *
 * `within`, if given, limits the outer-edge case to rows overlapping it
 * (the block the words are shown under), so a reordered lesson's other
 * blocks are never extended by mistake. Restore one gap or edge piece at a
 * time (see `subtractRows`).
 */
export function restoreRange(
  segments: readonly Range[],
  restore: Range,
  wordStarts?: readonly number[],
  within?: Range,
): Range[] {
  const out = segments.map((segment) => ({ ...segment }));
  // Nothing but silence in [from, to)?
  const empty = (from: number, to: number) =>
    wordStarts ? !hasStartIn(wordStarts, from - EDGE_EPS_S, to - EDGE_EPS_S) : to - from <= EDGE_EPS_S;
  let consumed = false;
  let i = 0;
  while (i + 1 < out.length) {
    const a = out[i];
    const b = out[i + 1];
    const gapStart = a.end;
    const gapEnd = b.start;
    if (gapEnd < gapStart - EDGE_EPS_S || gapEnd - gapStart > MAX_SCRIPT_GAP_S) {
      i++;
      continue; // not a cut gap (reordered, overlapping, or a jump)
    }
    const lo = Math.max(restore.start, gapStart);
    const hi = Math.min(restore.end, gapEnd);
    if (hi - lo <= 0) {
      i++;
      continue;
    }
    consumed = true;
    const touchesLeft = empty(gapStart, lo);
    const touchesRight = empty(hi, gapEnd);
    if (touchesLeft && touchesRight) {
      out.splice(i, 2, { start: a.start, end: b.end });
      continue; // re-check the joined row against the next one
    }
    if (touchesLeft) a.end = hi;
    else if (touchesRight) b.start = lo;
    else out.splice(i + 1, 0, { start: lo, end: hi });
    i++;
  }
  if (consumed) return out;

  // Outer edges: the nearest row just after the restored words…
  const overlapsAny = (range: Range) => out.some((s) => s.start < range.end && range.start < s.end);
  const candidate = (row: Range) => !within || (row.start < within.end && within.start < row.end);
  let best = -1;
  for (let k = 0; k < out.length; k++) {
    if (!candidate(out[k])) continue;
    const gap = out[k].start - restore.end;
    if (gap >= -EDGE_EPS_S && gap <= MAX_SCRIPT_GAP_S && (best < 0 || gap < out[best].start - restore.end)) best = k;
  }
  if (best >= 0 && restore.start < out[best].start && !overlapsAny({ start: restore.start, end: out[best].start - EDGE_EPS_S })) {
    const row = out[best];
    if (empty(restore.end, row.start)) row.start = restore.start;
    else out.splice(best, 0, { start: restore.start, end: restore.end });
    return out;
  }
  // …or just before them.
  best = -1;
  for (let k = 0; k < out.length; k++) {
    if (!candidate(out[k])) continue;
    const gap = restore.start - out[k].end;
    if (gap >= -EDGE_EPS_S && gap <= MAX_SCRIPT_GAP_S && (best < 0 || gap < restore.start - out[best].end)) best = k;
  }
  if (best >= 0 && restore.end > out[best].end && !overlapsAny({ start: out[best].end + EDGE_EPS_S, end: restore.end })) {
    const row = out[best];
    if (empty(row.end, restore.start)) row.end = restore.end;
    else out.splice(best + 1, 0, { start: restore.start, end: restore.end });
  }
  return out;
}

/** The parts of `range` not covered by any of `rows`, in time order. */
export function subtractRows(range: Range, rows: readonly Range[]): Range[] {
  const covering = rows
    .filter((row) => row.start < range.end && range.start < row.end)
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  let cursor = range.start;
  for (const row of covering) {
    if (row.start > cursor) out.push({ start: cursor, end: Math.min(row.start, range.end) });
    cursor = Math.max(cursor, row.end);
    if (cursor >= range.end) break;
  }
  if (cursor < range.end) out.push({ start: cursor, end: range.end });
  return out.filter((piece) => piece.end - piece.start > 1e-6);
}

export interface ScriptBlock<S extends Range> {
  /** Index (in lesson order) of the block's first and last segment. */
  first: number;
  last: number;
  start: number;
  end: number;
  segments: S[];
}

/** Groups consecutive segments that run forward in time with gaps of at
 * most `maxGap` seconds: within a block, the gaps are cuts and their words
 * show as removed. */
export function scriptBlocks<S extends Range>(segments: readonly S[], maxGap = MAX_SCRIPT_GAP_S): ScriptBlock<S>[] {
  const blocks: ScriptBlock<S>[] = [];
  segments.forEach((segment, index) => {
    const current = blocks[blocks.length - 1];
    const previous = segments[index - 1];
    const continues =
      current !== undefined &&
      previous !== undefined &&
      segment.start >= previous.end - EDGE_EPS_S &&
      segment.start - previous.end <= maxGap;
    if (continues) {
      current.last = index;
      current.end = Math.max(current.end, segment.end);
      current.segments.push(segment);
    } else {
      blocks.push({ first: index, last: index, start: segment.start, end: segment.end, segments: [segment] });
    }
  });
  return blocks;
}

/** Whether `time` is inside any of `segments` (half-open). */
export function isInSegments(time: number, segments: readonly Range[]): boolean {
  return segments.some((segment) => time >= segment.start && time < segment.end);
}

/** How much of `range` the segments keep. */
export function keptLength(range: Range, segments: readonly Range[]): number {
  let kept = 0;
  for (const segment of segments) {
    const overlap = Math.min(range.end, segment.end) - Math.max(range.start, segment.start);
    if (overlap > 0) kept += overlap;
  }
  return Math.min(kept, range.end - range.start);
}

export function totalLength(segments: readonly Range[]): number {
  return segments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);
}
