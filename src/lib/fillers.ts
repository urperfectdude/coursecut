/*
 * Adapted from Rescript v1.0.9 (MIT), https://github.com/wassgha/rescript/blob/fb71f82/lib/fillers.ts
 * Copyright (c) 2026 Rescript contributors. See THIRD_PARTY_NOTICES.md.
 * Changes from upstream: works on our `TranscriptWord` (`removed`, `idx`).
 */

import type { TranscriptWord } from "../db";

/**
 * Filler sounds that carry no meaning and can safely be cut. Deliberately
 * conservative: ambiguous words like "like", "so" or "right" are excluded
 * because they are usually legitimate.
 */
const FILLER_WORDS = new Set([
  "um",
  "umm",
  "ummm",
  "uh",
  "uhh",
  "uhm",
  "erm",
  "er",
  "err",
  "ah",
  "ahh",
  "eh",
  "ehm",
  "hm",
  "hmm",
  "hmmm",
  "mm",
  "mmm",
  "mhm",
  "mm-hmm",
  "uh-huh",
]);

/** Normalize a transcript token for matching: lowercase, strip punctuation. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}-]+$/gu, "");
}

export function isFillerWord(text: string): boolean {
  return FILLER_WORDS.has(normalize(text));
}

/** `idx` of every filler word not yet removed. */
export function findFillerWordIdxs(words: readonly TranscriptWord[]): number[] {
  return words.filter((w) => !w.removed && isFillerWord(w.text)).map((w) => w.idx);
}
