/*
 * Unit checks for transcript-words.ts. Run: npm test
 */

import {
  findActiveWordIndex,
  formatLength,
  groupIntoParagraphs,
  punctuateWords,
  summarizeEdits,
} from "./transcript-words.ts";
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

// --- summarizeEdits ---
{
  const words = [word(0, "a", 0, 1), word(1, "um", 2, 2.5, true), word(2, "b", 4, 5)];
  const { cuts, editedDuration } = summarizeEdits(words, 10);
  eq(cuts, [{ start: 2, end: 2.5 }], "one cut for the removed word");
  eq(editedDuration, 9.5, "edited duration");
  eq(summarizeEdits(words, 0).editedDuration, 0, "unknown duration");
}

// --- formatLength ---
eq(formatLength(65), "1:05", "minutes");
eq(formatLength(3723), "1:02:03", "hours");

console.log("transcript-words-test: all passed");
