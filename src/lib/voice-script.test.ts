/*
 * Unit checks for voice-script.ts and the text-edit helpers it uses.
 * Run: npm test
 */

import { buildVoiceLines } from "./voice-script.ts";
import { displayWordTexts, spreadEditedText } from "./transcript-words.ts";
import type { TranscriptSegment, TranscriptWord } from "../db.ts";

function eq<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: got ${JSON.stringify(actual)}`);
  }
}

function word(idx: number, text: string, start: number, original: string | null = null): TranscriptWord {
  return {
    id: `w${idx}`,
    video_id: "v",
    idx,
    text,
    original_text: original,
    start,
    end: start + 0.4,
    removed: false,
    suggested: null,
  };
}

function seg(id: string, start: number, end: number, text: string): TranscriptSegment {
  return { id, video_id: "v", start, end, text, keep: true } as TranscriptSegment;
}

// spreadEditedText
eq(spreadEditedText(1, "  key  "), ["key"], "one for one");
eq(spreadEditedText(2, "a b c"), ["a b", "c"], "more words than slots");
eq(spreadEditedText(3, "a"), ["a", "", ""], "fewer words than slots");
eq(spreadEditedText(2, "a b"), ["a", "b"], "same count");

// displayWordTexts: an edited word shows its text, neighbours keep punctuation.
eq(
  displayWordTexts("Okay, so this is wrold.", [
    word(0, "okay", 0),
    word(1, "so", 1),
    word(2, "this", 2),
    word(3, "is", 3),
    word(4, "world.", 4, "wrold"),
  ]),
  ["Okay,", "so", "this", "is", "world."],
  "edited word aligned by its Whisper text",
);

// buildVoiceLines
{
  const tsegs = [seg("t1", 0, 4, "Hello there, all."), seg("t2", 4, 10, "Today we learn things.")];
  const words = [
    word(0, "hello", 0),
    word(1, "there", 1),
    word(2, "all", 2),
    word(3, "today", 4),
    word(4, "we", 5),
    word(5, "learn", 6),
    word(6, "things", 8),
  ];
  // "there" cut out (lesson keeps [0,1) and [2,10)); one sentence still one line.
  const lines = buildVoiceLines(
    [
      { start: 0, end: 1 },
      { start: 2, end: 10 },
    ],
    tsegs,
    words,
  );
  eq(
    lines.map((l) => [l.text, l.start, l.end, l.sourceStart]),
    [
      ["Hello all.", 0, 3, 0],
      ["Today we learn things.", 3, 9, 4],
    ],
    "lines per sentence on the lesson timeline",
  );

  // An emptied word is skipped; an edit shows.
  const edited = words.map((w) => (w.idx === 5 ? { ...w, text: "", original_text: "learn" } : w));
  edited[6] = { ...edited[6], text: "stuff.", original_text: "things" };
  eq(
    buildVoiceLines([{ start: 4, end: 10 }], tsegs, edited).map((l) => l.text),
    ["Today we stuff."],
    "edits and empty words",
  );

  // Reordered lesson: a backward jump starts a new line even in one sentence.
  eq(
    buildVoiceLines(
      [
        { start: 5, end: 10 },
        { start: 4, end: 5 },
      ],
      tsegs,
      words,
    ).map((l) => [l.text, l.start]),
    [
      ["we learn things.", 0],
      ["Today", 5],
    ],
    "backward jump splits",
  );
}

console.log("voice-script-test: all passed");
