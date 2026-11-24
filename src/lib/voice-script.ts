/*
 * The AI voice's script for one lesson (docs/hcm-improvements-plan.md §4):
 * the words the lesson keeps, in lesson order, with the user's text edits
 * and the transcript's punctuation, split into lines (one per sentence)
 * placed on the lesson's own timeline. Pure, so it's unit tested; the Rust
 * side (`voice.rs`) only reads and places what this builds.
 */

import type { TranscriptSegment, TranscriptWord } from "../db";
import { displayWordTexts, wordsInRange } from "./transcript-words.ts";

export interface VoiceLine {
  text: string;
  /** Where the first word is said, in lesson time (0 = lesson start). */
  start: number;
  /** Where the next line starts, or the lesson ends: the line's slot. */
  end: number;
  /** The first word's time in the recording, for seeking. */
  sourceStart: number;
}

/** A line is cut here even mid-sentence, to stay well under the speech
 * endpoint's 4096-character limit. */
const MAX_LINE_CHARS = 1500;

export function buildVoiceLines(
  lessonSegments: readonly { start: number; end: number }[],
  transcriptSegments: readonly TranscriptSegment[],
  words: readonly TranscriptWord[],
): VoiceLine[] {
  // Each word's display text, punctuated by its sentence.
  const display = new Map<number, string>();
  const segmentOf = new Map<number, number>();
  transcriptSegments.forEach((segment, s) => {
    // Only sentences this lesson touches (a video can have thousands).
    if (!lessonSegments.some((range) => segment.end > range.start && segment.start < range.end)) return;
    const inSegment = wordsInRange(words, segment.start, segment.end);
    const texts = displayWordTexts(segment.text, inSegment);
    inSegment.forEach((word, i) => {
      if (!display.has(word.idx)) {
        display.set(word.idx, texts[i]);
        segmentOf.set(word.idx, s);
      }
    });
  });

  const lines: VoiceLine[] = [];
  let current: { line: VoiceLine; parts: string[]; length: number; segment: number; lastIdx: number } | null = null;
  const flush = () => {
    if (current) {
      current.line.text = current.parts.join(" ");
      lines.push(current.line);
    }
    current = null;
  };

  let offset = 0;
  for (const range of lessonSegments) {
    for (const word of wordsInRange(words, range.start, range.end)) {
      const text = (display.get(word.idx) ?? word.text).trim();
      if (!text) continue;
      const segment = segmentOf.get(word.idx) ?? -1;
      const at = offset + (word.start - range.start);
      // Same sentence, moving forward (words cut out between are fine).
      const continues =
        current !== null &&
        current.segment === segment &&
        word.idx > current.lastIdx &&
        current.length + text.length < MAX_LINE_CHARS;
      if (continues && current) {
        current.parts.push(text);
        current.length += text.length + 1;
        current.lastIdx = word.idx;
      } else {
        flush();
        current = {
          line: { text: "", start: at, end: at, sourceStart: word.start },
          parts: [text],
          length: text.length,
          segment,
          lastIdx: word.idx,
        };
      }
    }
    offset += Math.max(0, range.end - range.start);
  }
  flush();

  lines.forEach((line, i) => {
    line.end = i + 1 < lines.length ? lines[i + 1].start : Math.max(offset, line.start);
  });
  return lines;
}
