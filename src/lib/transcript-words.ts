/*
 * Helpers for the word-level transcript editor (docs/text-editing-plan.md,
 * Phase 2). `findActiveWordIndex` is adapted from Rescript v1.0.9 (MIT),
 * https://github.com/wassgha/rescript/blob/fb71f82/lib/transcript.ts
 * Copyright (c) 2026 Rescript contributors. See THIRD_PARTY_NOTICES.md.
 * Changes from upstream: returns an array index instead of a word id, and
 * the 0.15 s "still speaking" tail is a named constant. The rest is ours.
 */

import type { PauseAction, TranscriptSegment, TranscriptWord } from "../db";
import type { TimeRange } from "./text-edit.ts";

/** How long after a word's end it still counts as the active word. */
const ACTIVE_WORD_TAIL_S = 0.15;

/** Index (into `words`, sorted by start) of the word playing at `time`, or -1. */
export function findActiveWordIndex(words: readonly TranscriptWord[], time: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= time) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx >= 0 && time < words[idx].end + ACTIVE_WORD_TAIL_S) return idx;
  return -1;
}

export interface Paragraph {
  segment: TranscriptSegment;
  words: TranscriptWord[];
}

/** Groups words into paragraphs, one per segment, for display. A word goes
 * to the last segment starting at or before it, so words in a gap between
 * segments stay with the paragraph before them, and words before the first
 * segment go to the first. Both lists must be sorted by start.
 *
 * When `previous` is given, a paragraph whose words are all the same objects
 * as last time reuses last time's array, so memoised paragraphs skip
 * re-rendering when an edit touched other paragraphs only. */
export function groupIntoParagraphs(
  segments: readonly TranscriptSegment[],
  words: readonly TranscriptWord[],
  previous?: ReadonlyMap<string, TranscriptWord[]>,
): Paragraph[] {
  if (segments.length === 0) return [];
  const buckets: TranscriptWord[][] = segments.map(() => []);
  let s = 0;
  for (const word of words) {
    while (s + 1 < segments.length && segments[s + 1].start <= word.start) s++;
    buckets[s].push(word);
  }
  return segments.map((segment, i) => {
    const fresh = buckets[i];
    const old = previous?.get(segment.id);
    const same = old !== undefined && old.length === fresh.length && old.every((w, j) => w === fresh[j]);
    return { segment, words: same ? old : fresh };
  });
}

/** "1:02:03" / "4:05" style, for lengths. */
export function formatLength(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** How far ahead to look for a match when segment text and words diverge. */
const ALIGN_LOOKAHEAD = 3;

function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Display text for each word, with punctuation and casing taken from the
 * segment text. Whisper's word list has neither, but its segment text does
 * ("Okay, so this is what…"). Tokens are matched to words by their letters
 * and digits; a word with no confident match keeps its own text. Display
 * only: the stored word text is untouched.
 *
 * For a VTT transcript the segment text is a different transcription, so
 * most words won't match and show as Whisper heard them.
 */
export function punctuateWords(segmentText: string, words: readonly { text: string }[]): string[] {
  const tokens = segmentText.split(/\s+/).filter(Boolean);
  const tokenKeys = tokens.map(normalizeToken);
  const out = words.map((word) => word.text);
  // Words may start part-way into the segment (a lesson segment cut
  // there): begin at the first token matching the first word.
  const firstKey = words.length > 0 ? normalizeToken(words[0].text) : "";
  const startAt = firstKey ? tokenKeys.indexOf(firstKey) : -1;
  let t = startAt > 0 ? startAt : 0;
  let w = 0;
  while (t < tokens.length && w < words.length) {
    const wordKey = normalizeToken(words[w].text);
    if (tokenKeys[t] === "") {
      t++; // a lone "-" or "…" token
      continue;
    }
    if (tokenKeys[t] === wordKey) {
      out[w] = tokens[t];
      t++;
      w++;
      continue;
    }
    // Skip extra tokens (text Whisper wrote but timed no word for)…
    let found = -1;
    for (let k = 1; k <= ALIGN_LOOKAHEAD && t + k < tokens.length; k++) {
      if (tokenKeys[t + k] === wordKey) {
        found = t + k;
        break;
      }
    }
    if (found >= 0) {
      t = found;
      continue;
    }
    // …or extra words (a word with no token).
    let wordAhead = -1;
    for (let k = 1; k <= ALIGN_LOOKAHEAD && w + k < words.length; k++) {
      if (normalizeToken(words[w + k].text) === tokenKeys[t]) {
        wordAhead = w + k;
        break;
      }
    }
    if (wordAhead >= 0) {
      w = wordAhead;
      continue;
    }
    t++;
    w++;
  }
  return out;
}

// --- Pauses (docs/text-editing-plan.md §6.1, §6.5) -------------------------

/** A gap between words at least this long is a "long pause". */
export const LONG_PAUSE_S = 1.0;
/** "Shorten" leaves this much of the pause. */
export const SHORTENED_PAUSE_S = 0.3;
/** "Remove" still leaves this much beside the speech on each side, so word
 * edges aren't clipped. */
export const PAUSE_EDGE_PAD_S = 0.05;

export interface Pause {
  /** The word before the pause; decisions are keyed by its id. */
  afterWordId: string;
  afterIdx: number;
  start: number;
  end: number;
}

/** Gaps of at least `minGap` seconds between consecutive words. Depends on
 * word timing only, not on which words are removed. */
export function findPauses(words: readonly TranscriptWord[], minGap = LONG_PAUSE_S): Pause[] {
  const pauses: Pause[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const start = words[i].end;
    const end = words[i + 1].start;
    if (end - start >= minGap) {
      pauses.push({ afterWordId: words[i].id, afterIdx: words[i].idx, start, end });
    }
  }
  return pauses;
}

/** The part of a pause that the decision cuts, or null to keep it whole. */
export function pauseCut(pause: Pause, action: PauseAction | null | undefined): TimeRange | null {
  const gap = pause.end - pause.start;
  if (action === "shorten") {
    if (gap <= SHORTENED_PAUSE_S) return null;
    const keepEachSide = SHORTENED_PAUSE_S / 2;
    return { start: pause.start + keepEachSide, end: pause.end - keepEachSide };
  }
  if (action === "remove") {
    if (gap <= 2 * PAUSE_EDGE_PAD_S) return null;
    return { start: pause.start + PAUSE_EDGE_PAD_S, end: pause.end - PAUSE_EDGE_PAD_S };
  }
  return null;
}

// --- Lesson script (docs/text-editing-plan.md §6.3) -----------------------

export interface ScriptParagraph {
  /** Unique within the script: one transcript segment can appear in two
   * lesson segments. */
  key: string;
  /** Source of the paragraph's timestamp and punctuation. */
  segment: TranscriptSegment;
  /** In time order, contiguous in `idx`. */
  words: TranscriptWord[];
  /** Shown above the first paragraph of each lesson segment. */
  header?: string;
}

/**
 * A lesson's words as paragraphs, in the lesson's own segment order (which
 * need not be time order). Each lesson segment contributes the words whose
 * start falls inside it, grouped by transcript segment as on the
 * Transcript page. `words` must be the whole video's list sorted by start.
 *
 * `previous` (keyed like `key`) lets untouched paragraphs keep their word
 * arrays, so memoised paragraphs skip re-rendering after an edit.
 */
export function groupLessonParagraphs(
  lessonSegments: readonly { id: string; start: number; end: number }[],
  transcriptSegments: readonly TranscriptSegment[],
  words: readonly TranscriptWord[],
  previous?: ReadonlyMap<string, TranscriptWord[]>,
  headerFor: (index: number, segment: { start: number; end: number }) => string = (index) =>
    `Segment ${index + 1}`,
): ScriptParagraph[] {
  const out: ScriptParagraph[] = [];
  lessonSegments.forEach((lessonSegment, index) => {
    const inRange = wordsInRange(words, lessonSegment.start, lessonSegment.end);
    if (inRange.length === 0) return;
    const overlapping = transcriptSegments.filter(
      (segment) => segment.end > lessonSegment.start && segment.start < lessonSegment.end,
    );
    const groups =
      overlapping.length > 0
        ? groupIntoParagraphs(overlapping, inRange)
        : [{ segment: syntheticSegment(lessonSegment), words: inRange }];
    let first = true;
    for (const group of groups) {
      if (group.words.length === 0) continue;
      const key = `${lessonSegment.id}:${group.segment.id}`;
      const old = previous?.get(key);
      const same =
        old !== undefined && old.length === group.words.length && old.every((w, j) => w === group.words[j]);
      out.push({
        key,
        segment: group.segment,
        words: same ? old : group.words,
        header: first ? headerFor(index, lessonSegment) : undefined,
      });
      first = false;
    }
  });
  return out;
}

/** Words whose start is in [start, end), by binary search. */
export function wordsInRange(words: readonly TranscriptWord[], start: number, end: number): TranscriptWord[] {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start < start) lo = mid + 1;
    else hi = mid;
  }
  const out: TranscriptWord[] = [];
  for (let i = lo; i < words.length && words[i].start < end; i++) out.push(words[i]);
  return out;
}

function syntheticSegment(range: { id: string; start: number; end: number }): TranscriptSegment {
  return { id: range.id, video_id: "", start: range.start, end: range.end, text: "", keep: true };
}

