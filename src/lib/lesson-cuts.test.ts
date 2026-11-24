/*
 * Unit checks for lesson-cuts.ts. Run: npm test
 */

import {
  cutRange,
  cutRanges,
  hasStartIn,
  keptLength,
  restoreRange,
  scriptBlocks,
  subtractRows,
  totalLength,
} from "./lesson-cuts.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function eq<T>(actual: T, expected: T, msg: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(actual)}`);
}

const r = (start: number, end: number) => ({ start, end });

// --- cutRange ---
eq(cutRange([r(14, 39)], r(21, 22)), [r(14, 21), r(22, 39)], "middle cut splits into two rows");
eq(cutRange([r(14, 39)], r(14, 16)), [r(16, 39)], "cut at the start trims");
eq(cutRange([r(14, 39)], r(38.9, 40)), [r(14, 38.9)], "cut at the end trims");
eq(cutRange([r(14, 39)], r(14.1, 38.9)), [], "slivers under 0.3 s are dropped");
eq(cutRange([r(14, 20), r(30, 40)], r(19, 31)), [r(14, 19), r(31, 40)], "cut spanning two rows");
eq(cutRange([r(30, 40), r(0, 10)], r(5, 6)), [r(30, 40), r(0, 5), r(6, 10)], "lesson order kept");
eq(cutRanges([r(0, 10)], [r(2, 3), r(6, 7)]), [r(0, 2), r(3, 6), r(7, 10)], "several cuts");

// --- restoreRange ---
eq(restoreRange([r(14, 21), r(22, 39)], r(21, 22)), [r(14, 39)], "restoring the whole gap joins the rows");
eq(restoreRange([r(14, 21), r(22, 39)], r(20.5, 22.5)), [r(14, 39)], "a wider restore still joins");
eq(restoreRange([r(0, 2), r(5, 9)], r(2, 3)), [r(0, 3), r(5, 9)], "touching the left side extends it");
eq(restoreRange([r(0, 2), r(5, 9)], r(4, 5)), [r(0, 2), r(4, 9)], "touching the right side extends it");
eq(restoreRange([r(0, 2), r(5, 9)], r(3, 4)), [r(0, 2), r(3, 4), r(5, 9)], "middle of a gap is a new row");
eq(restoreRange([r(0, 2), r(3, 4), r(5, 9)], r(2, 5)), [r(0, 9)], "restore across two gaps joins all");
eq(restoreRange([r(30, 40), r(0, 10)], r(10, 30)), [r(10, 40), r(0, 10)], "reordered rows: no gap to join, so the following row's edge extends");
eq(restoreRange([r(30, 40), r(0, 10)], r(35, 36)), [r(30, 40), r(0, 10)], "already kept: nothing");
{
  const cut = cutRanges([r(0, 30)], [r(5, 6), r(10, 12)]);
  eq(restoreRange(restoreRange(cut, r(10, 12)), r(5, 6)), [r(0, 30)], "cut then restore round-trips");
}

// --- word-aware cuts and restores ---
{
  // Words A [2.0,2.5], B [2.6,2.85] (short), C [2.95,3.3] in [0,10].
  const starts = [2.0, 2.6, 2.95];
  const cutAC = cutRanges([r(0, 10)], [r(2.0, 2.5), r(2.95, 3.3)], starts);
  eq(cutAC, [r(0, 2), r(2.5, 2.95), r(3.3, 10)], "a short unselected word between two cuts is kept");
  eq(cutRange([r(0, 10)], r(0.1, 2), starts), [r(2, 10)], "a silent sliver is still dropped");

  // Cut A..C, then restore B, A, C one at a time: no hidden micro-cuts.
  const cut = cutRange([r(0, 10)], r(2.0, 3.3), starts);
  let back = restoreRange(cut, r(2.6, 2.85), starts);
  back = restoreRange(back, r(2.0, 2.5), starts);
  back = restoreRange(back, r(2.95, 3.3), starts);
  eq(back, [r(0, 10)], "word-by-word restore rejoins fully");
  eq(restoreRange(cut, r(2.6, 2.85), starts), [r(0, 2), r(2.6, 2.85), r(3.3, 10)], "middle word alone is its own row");
}

// --- outer edges ---
{
  const starts = [14.0, 14.5, 38.0, 38.6];
  eq(restoreRange([r(14.5, 39)], r(14.0, 14.4), starts), [r(14, 39)], "restore before the first row extends it");
  eq(restoreRange([r(14, 38.0)], r(38.0, 38.5), starts), [r(14, 38.5)], "restore after the last row extends it");
  eq(
    restoreRange([r(14.5, 37)], r(14.0, 14.3), [14.0, 14.35, 14.5]),
    [r(14, 14.3), r(14.5, 37)],
    "a removed word in between: new row instead of silently restoring it",
  );
  eq(restoreRange([r(100, 110)], r(0, 1), starts), [r(100, 110)], "far away: nothing");
}

// --- mixed and reordered restores (as LessonScript drives them) ---
{
  const starts = Array.from({ length: 60 }, (_, i) => i * 0.5);
  const restoreAll = (rows: { start: number; end: number }[], run: { start: number; end: number }, within?: { start: number; end: number }) =>
    subtractRows(run, rows).reduce((acc, piece) => restoreRange(acc, piece, starts, within), rows);
  eq(subtractRows(r(8, 22), [r(10, 14), r(16, 20)]), [r(8, 10), r(14, 16), r(20, 22)], "subtractRows");
  eq(restoreAll([r(10, 20)], r(8, 12.4)), [r(8, 20)], "struck lead-in plus kept words");
  eq(restoreAll([r(10, 20)], r(18, 22.4)), [r(10, 22.4)], "kept words plus struck tail");
  eq(restoreAll([r(10, 14), r(16, 20)], r(8, 17)), [r(8, 20)], "edge and inner gap together");
  eq(
    restoreAll([r(30, 40), r(10, 20)], r(20, 21.9), r(10, 22)),
    [r(30, 40), r(10, 21.9)],
    "reordered: the tail extends its own block's row",
  );
}

assert(hasStartIn([1, 2, 3], 1.5, 2.5) && !hasStartIn([1, 2, 3], 2.1, 2.9), "hasStartIn");

// --- scriptBlocks ---
{
  const blocks = scriptBlocks([r(0, 5), r(6, 10), r(200, 210), r(50, 60)]);
  eq(
    blocks.map((b) => [b.first, b.last, b.start, b.end]),
    [
      [0, 1, 0, 10],
      [2, 2, 200, 210],
      [3, 3, 50, 60],
    ],
    "forward small gaps join a block; big or backward gaps start a new one",
  );
}

// --- lengths ---
eq(keptLength(r(4, 8), [r(0, 5), r(7, 10)]), 2, "kept part of a range");
eq(totalLength([r(0, 5), r(7, 10)]), 8, "total length");

console.log("lesson-cuts-test: all passed");
