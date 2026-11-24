/*
 * Helpers for the word-level transcript editor (docs/text-editing-plan.md,
 * Phase 2). `findActiveWordIndex` is adapted from Rescript v1.0.9 (MIT),
 * https://github.com/wassgha/rescript/blob/fb71f82/lib/transcript.ts
 * Copyright (c) 2026 Rescript contributors. See THIRD_PARTY_NOTICES.md.
 * Changes from upstream: returns an array index instead of a word id, and
 * the 0.15 s "still speaking" tail is a named constant. The rest is ours.
 */

import type { TranscriptSegment, TranscriptWord } from "../db";
import { getCutRanges, getEditedDuration, type TimeRange, type Word } from "./text-edit.ts";

/** How long after a word's end it still counts as the active word. */
const ACTIVE_WORD_TAIL_S = 0.15;

/** Our stored words → the shape `text-edit.ts` works on. `idx` is the
 * numeric id: contiguous 0..n per video, and the DOM key (`data-wid`). */
export function toEditWords(words: readonly TranscriptWord[]): Word[] {
  return words.map((word) => ({
    id: word.idx,
    text: word.text,
    start: word.start,
    end: word.end,
    speaker: -1,
    deleted: word.removed,
  }));
}

export interface EditSummary {
  cuts: TimeRange[];
  editedDuration: number;
}

export function summarizeEdits(words: readonly TranscriptWord[], duration: number): EditSummary {
  if (duration <= 0) return { cuts: [], editedDuration: 0 };
  const cuts = getCutRanges(toEditWords(words), duration);
  return { cuts, editedDuration: getEditedDuration(cuts, duration) };
}

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
  let t = 0;
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
