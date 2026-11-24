/*
 * Unit checks for transcript-words.ts. Run: npm test
 */

import {
  findActiveWordIndex,
  findPauses,
  formatLength,
  groupIntoParagraphs,
  groupLessonParagraphs,
  pauseCut,
  punctuateWords,
} from "./transcript-words.ts";
import { findFillerWordIdxs, isFillerWord } from "./fillers.ts";
import type { TranscriptSegment, TranscriptWord } from "../db.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function eq<T>(actual: T, expected: T, msg: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(actual)}`);
}

function word(idx: number, text: string, start: number, end: number, removed = false): TranscriptWord {
  return {
    id: `w${idx}`,
    video_id: "v",
    idx,
    text,
    original_text: null,
    start,
    end,
    removed,
    suggested: null,
  };
}

function segment(id: string, start: number, end: number, text = ""): TranscriptSegment {
  return { id, video_id: "v", start, end, text, keep: true };
}

const w = (text: string) => ({ text });

// --- punctuateWords ---
eq(
  punctuateWords("Okay, so this is what Saurav is mentioning.", [
    w("Okay"), w("so"), w("this"), w("is"), w("what"), w("Saurav"), w("is"), w("mentioning"),
  ]),
  ["Okay,", "so", "this", "is", "what", "Saurav", "is", "mentioning."],
  "punctuation and casing copied from segment text",
);
eq(
  punctuateWords("It's 3.1 kilometers away", [w("it's"), w("3.1"), w("kilometers"), w("away")]),
  ["It's", "3.1", "kilometers", "away"],
  "apostrophes and decimals match",
);
eq(
  punctuateWords("So — uh, here we go", [w("So"), w("uh"), w("here"), w("we"), w("go")]),
  ["So", "uh,", "here", "we", "go"],
  "lone dash token skipped",
);
eq(
  punctuateWords("Hello there, world.", [w("hello"), w("world")]),
  ["Hello", "world."],
  "extra segment token skipped",
);
eq(
  punctuateWords("Hello world.", [w("hello"), w("um"), w("world")]),
  ["Hello", "um", "world."],
  "extra word keeps its own text",
);
eq(
  punctuateWords("vidya iyer: completely different text", [w("something"), w("else")]),
  ["something", "else"],
  "no match keeps word text",
);

eq(
  punctuateWords("Well, first we open the admin panel, then we check in.", [w("then"), w("we"), w("check"), w("in")]),
  ["then", "we", "check", "in."],
  "words starting mid-segment still pick up punctuation",
);

// --- groupIntoParagraphs ---
{
  const segments = [segment("a", 1, 5), segment("b", 6, 9)];
  const words = [word(0, "pre", 0.2, 0.5), word(1, "x", 2, 2.5), word(2, "gap", 5.5, 5.8), word(3, "y", 7, 7.5)];
  const paragraphs = groupIntoParagraphs(segments, words);
  eq(paragraphs.map((p) => p.words.map((wd) => wd.text)), [["pre", "x", "gap"], ["y"]], "words grouped by segment");

  const previous = new Map(paragraphs.map((p) => [p.segment.id, p.words]));
  const edited = [words[0], words[1], words[2], { ...words[3], removed: true }];
  const again = groupIntoParagraphs(segments, edited, previous);
  assert(again[0].words === paragraphs[0].words, "untouched paragraph reuses its array");
  assert(again[1].words !== paragraphs[1].words, "edited paragraph gets a new array");
}

// --- findActiveWordIndex ---
{
  const words = [word(0, "a", 1, 1.5), word(1, "b", 2, 2.5)];
  eq(findActiveWordIndex(words, 0.5), -1, "before first word");
  eq(findActiveWordIndex(words, 1.2), 0, "inside a");
  eq(findActiveWordIndex(words, 1.6), 0, "just after a still counts");
  eq(findActiveWordIndex(words, 1.8), -1, "gap");
  eq(findActiveWordIndex(words, 2.1), 1, "inside b");
}

// --- formatLength ---
eq(formatLength(65), "1:05", "minutes");
eq(formatLength(3723), "1:02:03", "hours");

// --- pauses ---
{
  const words = [word(0, "a", 0, 1), word(1, "b", 1.2, 2), word(2, "c", 4, 5), word(3, "d", 5.5, 6)];
  const pauses = findPauses(words);
  eq(pauses.map((p) => [p.afterIdx, p.start, p.end]), [[1, 2, 4]], "only the 2 s gap is long");
  eq(pauseCut(pauses[0], "shorten"), { start: 2.15, end: 3.85 }, "shorten keeps 0.3 s");
  eq(pauseCut(pauses[0], "remove"), { start: 2.05, end: 3.95 }, "remove keeps edge pads");
  eq(pauseCut(pauses[0], "keep"), null, "keep cuts nothing");
  eq(pauseCut(pauses[0], undefined), null, "undecided cuts nothing");
}

// --- fillers ---
assert(isFillerWord("Um,") && isFillerWord("uh-huh") && isFillerWord("hmm."), "fillers detected");
assert(!isFillerWord("like") && !isFillerWord("so") && !isFillerWord("umbrella"), "real words kept");
eq(
  findFillerWordIdxs([word(0, "um", 0, 1), word(1, "ok", 1, 2), word(2, "uh", 2, 3, true)]),
  [0],
  "only unremoved fillers",
);

// --- lesson script ---
{
  const tsegs = [segment("t1", 0, 5, "One two."), segment("t2", 5, 10, "Three four.")];
  const words = [word(0, "one", 1, 1.5), word(1, "two", 2, 2.5), word(2, "three", 6, 6.5), word(3, "four", 8, 8.5)];
  // Lesson plays 5–10 first, then 0–3 (reordered), and skips "two".
  const lesson = [
    { id: "L1", start: 5, end: 10 },
    { id: "L2", start: 0, end: 2 },
  ];
  const paras = groupLessonParagraphs(lesson, tsegs, words);
  eq(paras.map((p) => [p.key, p.header ?? "", p.words.map((w) => w.text)]), [
    ["L1:t2", "Segment 1", ["three", "four"]],
    ["L2:t1", "Segment 2", ["one"]],
  ], "lesson order, clipped to lesson ranges");

  const previous = new Map(paras.map((p) => [p.key, p.words]));
  const edited = [words[0], words[1], { ...words[2], removed: true }, words[3]];
  const again = groupLessonParagraphs(lesson, tsegs, edited, previous);
  assert(again[1].words === paras[1].words, "untouched lesson paragraph reused");
  assert(again[0].words !== paras[0].words, "edited lesson paragraph replaced");
}

console.log("transcript-words-test: all passed");
