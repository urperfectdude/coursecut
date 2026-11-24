/*
 * Adapted from Rescript v1.0.9 (MIT), https://github.com/wassgha/rescript/blob/fb71f82/tests/edits-test.ts
 * Copyright (c) 2026 Rescript contributors. See THIRD_PARTY_NOTICES.md.
 *
 * Changes from upstream: import paths only.
 * Run: npm test   (plain Node 24 TypeScript, no test framework)
 */
/**
 * Unit checks for flexible clip editing math (word bounds, splits, trims).
 * Run: npx tsx tests/edits-test.ts
 */

import {
  applyWordBounds,
  canSplitAt,
  carrySceneBoundaries,
  getActiveSceneBoundaries,
  getClipSegments,
  getCutRanges,
  getKeepRanges,
  getWordCutRanges,
  mapSplitsToWords,
  MIN_CLIP_DURATION,
  trimEdgeBounds,
  trimEdgeResult,
} from "./text-edit.ts";
import type { ManualCut, SceneBoundary, Word } from "./text-edit.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function word(
  id: number,
  text: string,
  start: number,
  end: number,
  deleted = false
): Word {
  return { id, text, start, end, speaker: 0, deleted };
}

function nearly(a: number, b: number, eps = 1e-3) {
  return Math.abs(a - b) < eps;
}

// --- Word cuts include silence between adjacent deletes ---
{
  const words = [
    word(1, "hello", 0, 0.5),
    word(2, "uh", 0.6, 0.8, true),
    word(3, "everyone", 1.0, 1.5),
  ];
  const cuts = getWordCutRanges(words, 2);
  assert(cuts.length === 1, "one cut from uh");
  assert(nearly(cuts[0].start, 0.6) && nearly(cuts[0].end, 0.8), "uh span");
}

// --- Manual cuts merge with word cuts ---
{
  const words = [word(1, "a", 0, 1), word(2, "b", 1, 2, true), word(3, "c", 2, 3)];
  const manual: ManualCut[] = [{ id: 1, start: 2.5, end: 2.7 }];
  const cuts = getCutRanges(words, 3, manual);
  assert(cuts.length === 2, `expected 2 cuts, got ${cuts.length}`);
}

// --- Adjusting uh start away from hello ---
{
  const words = [
    word(1, "hello", 0.0, 0.55),
    word(2, "uh", 0.45, 0.7), // overlaps hello (ASR bleed)
    word(3, "everyone", 0.8, 1.2),
  ];
  const next = applyWordBounds(words, 2, 0.55, 0.7, 2);
  assert(next !== null, "bounds applied");
  assert(nearly(next![1].start, 0.55), "uh starts after hello");
  assert(nearly(next![0].end, 0.55), "hello end stolen/aligned");
}

// --- Split subdivides keep ranges ---
{
  const words = [word(1, "a", 0, 1), word(2, "b", 1, 2), word(3, "c", 2, 3)];
  const cuts = getCutRanges(words, 3, []);
  const keeps = getKeepRanges(cuts, 3);
  const boundaries: SceneBoundary[] = [{ id: 1, time: 1.5 }];
  const clips = getClipSegments(keeps, boundaries);
  assert(clips.length === 2, `expected 2 clips, got ${clips.length}`);
  assert(nearly(clips[0].end, 1.5) && nearly(clips[1].start, 1.5), "split at 1.5");
}

// --- canSplitAt rejects cuts ---
{
  const words = [word(1, "a", 0, 1, true), word(2, "b", 1, 2)];
  const cuts = getCutRanges(words, 2, []);
  assert(!canSplitAt(0.5, 2, cuts, []), "no split inside cut");
  assert(canSplitAt(1.5, 2, cuts, []), "split inside keep ok");
}

// --- Trim shrink adds manual cut ---
{
  const words = [word(1, "a", 0, 3)];
  const result = trimEdgeResult(words, [], "in", 0, 1, 1);
  assert(result !== null, "trim ok");
  assert(result!.manualCuts.length === 1, "one manual cut");
  assert(
    nearly(result!.manualCuts[0].start, 0) && nearly(result!.manualCuts[0].end, 1),
    "cut [0,1)"
  );
}

// --- Trim marks fully covered words as deleted ---
{
  const words = [
    word(1, "keep", 0, 1),
    word(2, "gone", 1.1, 1.9),
    word(3, "also", 2.0, 2.8),
  ];
  const result = trimEdgeResult(words, [], "out", 3, 1.0, 1);
  assert(result !== null, "trim ok");
  assert(result!.words[0].deleted === false, "keep stays");
  assert(result!.words[1].deleted === true, "gone deleted");
  assert(result!.words[2].deleted === true, "also deleted");
}

// --- Expanding trim restores covered deleted words ---
{
  const words = [
    word(1, "a", 0, 1),
    word(2, "b", 1, 2, true),
    word(3, "c", 2, 3),
  ];
  const manual: ManualCut[] = [{ id: 1, start: 1, end: 2 }];
  const result = trimEdgeResult(words, manual, "in", 2, 1, 10);
  assert(result !== null, "expand ok");
  assert(result!.words[1].deleted === false, "b restored");
  assert(result!.manualCuts.length === 0, "manual cut reclaimed");
}

// --- A trim edge may close the gap beside it, but not cross the next clip ---
{
  const words = [word(1, "a", 0, 5), word(2, "b", 5, 10, true), word(3, "c", 10, 20)];
  const cuts = getCutRanges(words, 20, []);
  const clips = getClipSegments(getKeepRanges(cuts, 20), []);
  assert(clips.length === 2, `two clips, got ${clips.length}`);

  const out = trimEdgeBounds(clips[0], "out", cuts);
  assert(nearly(out.hi, clips[1].start), "out edge stops at the next clip's start");
  assert(nearly(out.lo, clips[0].start + MIN_CLIP_DURATION), "out edge floor");

  const inb = trimEdgeBounds(clips[1], "in", cuts);
  assert(nearly(inb.lo, clips[0].end), "in edge stops at the previous clip's end");
  assert(nearly(inb.hi, clips[1].end - MIN_CLIP_DURATION), "in edge ceiling");
}

// --- Clips only touching via a scene boundary can't absorb each other ---
{
  const words = [word(1, "a", 0, 3)];
  const cuts = getCutRanges(words, 3, []);
  const clips = getClipSegments(getKeepRanges(cuts, 3), [{ id: 1, time: 1.5 }]);
  assert(clips.length === 2, "split into two adjacent clips");
  assert(nearly(trimEdgeBounds(clips[0], "out", cuts).hi, clips[0].end), "no gap to reclaim");
  assert(nearly(trimEdgeBounds(clips[1], "in", cuts).lo, clips[1].start), "no gap to reclaim");
}

// --- Closing a gap merges the two keep ranges (no leftover cut) ---
{
  const words = [word(1, "a", 0, 5), word(2, "b", 5, 10, true), word(3, "c", 10, 20)];
  const cuts = getCutRanges(words, 20, []);
  const clips = getClipSegments(getKeepRanges(cuts, 20), []);
  const { hi } = trimEdgeBounds(clips[0], "out", cuts);
  const result = trimEdgeResult(words, [], "out", clips[0].end, hi, 1);
  assert(result !== null, "reclaim ok");
  assert(result!.words[1].deleted === false, "b restored");
  const merged = getKeepRanges(getCutRanges(result!.words, 20, result!.manualCuts), 20);
  assert(merged.length === 1, `keeps merged into one, got ${merged.length}`);
}

// --- Dragging an edge out and back leaves no residue ---
{
  const words = [word(1, "a", 0, 4), word(2, "b", 4, 5)];
  let state = { words, manualCuts: [] as ManualCut[], nextCutId: 1 };
  // Shrink 5 -> 4.5 -> 4.2 in steps, the way a drag applies deltas.
  for (const [from, to] of [[5, 4.5], [4.5, 4.2]] as const) {
    const r = trimEdgeResult(state.words, state.manualCuts, "out", from, to, state.nextCutId);
    state = { words: r!.words, manualCuts: r!.manualCuts, nextCutId: r!.nextCutId };
  }
  assert(state.manualCuts.length === 1, "steps merge into one cut");
  assert(nearly(state.manualCuts[0].start, 4.2), "cut starts where the drag stopped");
  // Drag back to where it started.
  const back = trimEdgeResult(state.words, state.manualCuts, "out", 4.2, 5, state.nextCutId);
  assert(back!.manualCuts.length === 0, "no leftover cut after returning");
  assert(back!.words.every((w) => !w.deleted), "no words left deleted");
}

// --- Split, pull the second clip away, then close the gap from the first ---
{
  // The reported repro: an orphan clip used to appear between clip 1 and the gap.
  const words = [word(1, "a", 0, 8), word(2, "b", 8, 16), word(3, "c", 16, 24)];
  const duration = 24;
  let st = {
    words,
    manualCuts: [] as ManualCut[],
    boundaries: [{ id: 1, time: 8 }] as SceneBoundary[],
    nextCutId: 1,
  };
  const clipsOf = (s: typeof st) =>
    getClipSegments(
      getKeepRanges(getCutRanges(s.words, duration, s.manualCuts), duration),
      s.boundaries
    );
  const trim = (edge: "in" | "out", from: number, to: number) => {
    const r = trimEdgeResult(st.words, st.manualCuts, edge, from, to, st.nextCutId);
    assert(r !== null, `trim ${edge} ${from}->${to}`);
    st = {
      words: r!.words,
      manualCuts: r!.manualCuts,
      boundaries: carrySceneBoundaries(st.boundaries, from, to),
      nextCutId: r!.nextCutId,
    };
  };

  assert(clipsOf(st).length === 2, "split gives two clips");

  // Drag clip 2's start right to 10, opening a gap.
  trim("in", 8, 10);
  let clips = clipsOf(st);
  assert(clips.length === 2, `still two clips, got ${clips.length}`);
  assert(nearly(clips[0].end, 8) && nearly(clips[1].start, 10), "gap 8–10");

  // Drag clip 1's end right toward the gap, one pointer step at a time.
  let edge = 8;
  for (const to of [8.5, 9, 9.5, 10]) {
    trim("out", edge, to);
    edge = to;
    clips = clipsOf(st);
    assert(clips.length === 2, `no orphan clip at ${to}, got ${clips.length}`);
    assert(nearly(clips[0].end, to), `clip 1 ends at the dragged edge (${to})`);
  }
  assert(st.manualCuts.length === 0, "gap fully reclaimed");
  assert(nearly(clips[1].start, 10), "clip 2 untouched");
  assert(st.words.every((w) => !w.deleted), "words restored");
}

// --- Boundary carrying keeps a trim reversible ---
{
  const boundaries: SceneBoundary[] = [{ id: 1, time: 8 }];
  assert(nearly(carrySceneBoundaries(boundaries, 8, 10)[0].time, 10), "carried along");
  assert(nearly(carrySceneBoundaries(boundaries, 5, 6)[0].time, 8), "unrelated edge");
  assert(
    carrySceneBoundaries([{ id: 1, time: 8 }, { id: 2, time: 10 }], 8, 10).length === 1,
    "collapsed duplicates"
  );
}

// --- Split markers: only where clips touch, anchored to the nearest word gap ---
{
  const words = [
    word(1, "a", 0, 1),
    word(2, "b", 1, 2),
    word(3, "c", 2, 3, true), // deleted -> cut [2,3)
    word(4, "d", 3, 4),
  ];
  const keeps = getKeepRanges(getCutRanges(words, 4), 4);

  // A split inside a kept run divides two touching clips; one sitting on the cut
  // edge does not (the skipped region already separates them).
  const inside: SceneBoundary[] = [{ id: 1, time: 1 }];
  const onCutEdge: SceneBoundary[] = [{ id: 2, time: 2 }];
  assert(getActiveSceneBoundaries(inside, keeps).length === 1, "split inside a clip");
  assert(getActiveSceneBoundaries(onCutEdge, keeps).length === 0, "split on a cut edge");

  // Anchoring: exactly in a gap, and mid-word snapping to the nearer side.
  assert(mapSplitsToWords(words, inside).get(2)?.id === 1, "sits in front of 'b'");
  assert(
    mapSplitsToWords(words, [{ id: 3, time: 1.2 }]).get(2)?.id === 3,
    "early in 'b' snaps before it"
  );
  assert(
    mapSplitsToWords(words, [{ id: 4, time: 1.8 }]).get(3)?.id === 4,
    "late in 'b' snaps after it"
  );
  assert(
    mapSplitsToWords(words, [{ id: 5, time: 3.9 }]).size === 0,
    "split in trailing silence has no anchor word"
  );
}

// --- A word's edge drags its cut edge with it (cuts derive from word bounds) ---
{
  const words = [
    word(1, "hello", 0.0, 0.55),
    word(2, "uh", 0.45, 0.7, true), // overlaps hello (ASR bleed)
    word(3, "everyone", 0.8, 1.2),
  ];
  assert(nearly(getCutRanges(words, 2)[0].start, 0.45), "cut bleeds into hello");

  // Pulling the deleted word's start off "hello" moves the cut edge too, so the
  // wordbar handles are the only thing needed to refine a cut.
  const next = applyWordBounds(words, 2, 0.55, 0.7, 2);
  assert(next !== null, "word bounds applied");
  assert(nearly(getCutRanges(next!, 2)[0].start, 0.55), "cut start follows the word");
  assert(nearly(next![0].end, 0.55), "hello keeps its audio");
}

console.log("edits-test: all passed");
