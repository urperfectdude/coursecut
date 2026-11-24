import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Loader2, Sparkles } from "lucide-react";
import type { LessonSegment, PauseAction, TranscriptSegment, TranscriptWord } from "../db";
import { isFillerWord } from "../lib/fillers";
import {
  cutRanges,
  isInSegments,
  keptLength,
  MAX_SCRIPT_GAP_S,
  restoreRange,
  scriptBlocks,
  subtractRows,
  totalLength,
  type Range,
} from "../lib/lesson-cuts";
import {
  formatLength,
  groupLessonParagraphs,
  PAUSE_EDGE_PAD_S,
  pauseCut,
  type Pause,
} from "../lib/transcript-words";
import WordTranscript, { type WordTranscriptHandle } from "./WordTranscript";
import { Button } from "@/components/ui/button";

interface LessonScriptProps {
  lessonSegments: readonly LessonSegment[];
  transcriptSegments: readonly TranscriptSegment[];
  /** The whole video's words (sorted, `words[i].idx === i`). */
  words: readonly TranscriptWord[];
  pauses: readonly Pause[];
  pausesByWordId: ReadonlyMap<string, Pause>;
  /** While a segment change is being saved, or words are being fetched. */
  busy: boolean;
  fetchingWords: boolean;
  fetchDetail?: string | null;
  onFetchWords: () => void;
  /** Replace the lesson's segments with `ranges` (one undo step).
   * Resolves true once saved. */
  onApplyRanges: (ranges: Range[]) => Promise<boolean>;
  /** The lesson has overlays or blur/cover shapes, which sit on the
   * lesson's timeline and shift when earlier parts are cut. */
  hasTimedLayers: boolean;
  onUndo: () => void;
  /** The page's undo stack size: the cleanup message's Undo is only valid
   * while Clean up is the latest entry. */
  undoDepth: number;
  /** False while the tab is hidden: keyboard removal is off then. */
  active: boolean;
  onSeek: (time: number) => void;
}

/** A pause's state, read off the segments: how much of it they keep. */
function pauseActionFromSegments(pause: Pause, segments: readonly Range[]): PauseAction | undefined {
  const gap = pause.end - pause.start;
  const kept = keptLength(pause, segments);
  if (gap - kept < 0.02) return undefined;
  return kept <= 2 * PAUSE_EDGE_PAD_S + 0.02 ? "remove" : "shorten";
}

/**
 * The lesson editor's Script tab (docs/text-editing-plan.md §6.3 and
 * "Per-lesson cuts"). Shows the words the lesson's segments cover, plus the
 * words cut out between them (struck through). Removing words cuts them out
 * of the segments (a new row in the Segments tab); restoring joins rows
 * back. Edits belong to this lesson only.
 */
const LessonScript = forwardRef<WordTranscriptHandle, LessonScriptProps>(function LessonScript(
  {
    lessonSegments,
    transcriptSegments,
    words,
    pauses,
    pausesByWordId,
    busy,
    fetchingWords,
    fetchDetail,
    onFetchWords,
    onApplyRanges,
    hasTimedLayers,
    onUndo,
    undoDepth,
    active,
    onSeek,
  },
  ref,
) {
  const [showRemoved, setShowRemoved] = useState(true);
  const [cleanupDone, setCleanupDone] = useState<string | null>(null);

  const ranges = useMemo(
    () => lessonSegments.map((segment) => ({ start: segment.start, end: segment.end })),
    [lessonSegments],
  );
  const blocks = useMemo(() => scriptBlocks(lessonSegments), [lessonSegments]);
  const wordStarts = useMemo(() => words.map((word) => word.start), [words]);

  // What each block shows: its own span widened to the whole transcript
  // sentences at its edges, so words cut from the lesson's very start or
  // end still show (struck through) and can be restored.
  const displaySpans = useMemo(
    () =>
      blocks.map((block) => {
        const first = transcriptSegments.find((s) => block.start >= s.start && block.start < s.end);
        const last = transcriptSegments.find((s) => block.end > s.start && block.end <= s.end);
        return {
          start: first ? Math.min(first.start, block.start) : block.start,
          end: last ? Math.max(last.end, block.end) : block.end,
        };
      }),
    [blocks, transcriptSegments],
  );

  // Words as shown here: `removed` means "not in any of this lesson's
  // segments". Clones are cached by idx and state, so words whose state
  // didn't change keep their object and their paragraph skips re-rendering.
  const cloneCacheRef = useRef<Map<number, TranscriptWord>>(new Map());
  const displayWords = useMemo(() => {
    const cache = cloneCacheRef.current;
    const next = new Map<number, TranscriptWord>();
    const out = words.map((word) => {
      const removed = !isInSegments(word.start, ranges);
      if (removed === word.removed && !word.suggested) return word;
      const cached = cache.get(word.idx);
      const clone =
        cached && cached.removed === removed && cached.text === word.text && cached.start === word.start
          ? cached
          : { ...word, removed, suggested: null };
      next.set(word.idx, clone);
      return clone;
    });
    cloneCacheRef.current = next;
    return out;
  }, [words, ranges]);

  const previousRef = useRef<Map<string, TranscriptWord[]>>(new Map());
  const paragraphs = useMemo(() => {
    const blockRanges = blocks.map((block, i) => ({
      id: block.segments[0].id,
      start: displaySpans[i].start,
      end: displaySpans[i].end,
    }));
    const next = groupLessonParagraphs(blockRanges, transcriptSegments, displayWords, previousRef.current, (index) => {
      const block = blocks[index];
      return block.first === block.last
        ? `Segment ${block.first + 1}`
        : `Segments ${block.first + 1}–${block.last + 1}`;
    });
    previousRef.current = new Map(next.map((p) => [p.key, p.words]));
    return next;
  }, [blocks, displaySpans, transcriptSegments, displayWords]);

  const inBlocks = useCallback(
    (time: number) => blocks.some((block) => time >= block.start && time < block.end),
    [blocks],
  );

  const pauseActions = useMemo(() => {
    const actions = new Map<string, PauseAction>();
    for (const pause of pauses) {
      if (!inBlocks(pause.start)) continue;
      const action = pauseActionFromSegments(pause, ranges);
      if (action) actions.set(pause.afterWordId, action);
    }
    return actions;
  }, [pauses, ranges, inBlocks]);

  // A selection follows the page, which can jump between blocks (to a
  // reordered or distant part of the recording). Split it into runs of
  // consecutive words in one block, and cut or restore each run on its
  // own, so nothing between runs is touched.
  const runsOf = useCallback(
    (idxs: readonly number[]): Range[] => {
      const blockOf = (time: number) =>
        displaySpans.findIndex((span) => time >= span.start && time < span.end);
      const runs: Range[] = [];
      let prev: TranscriptWord | null = null;
      for (const idx of idxs) {
        const word = words[idx];
        if (!word) continue;
        const continues =
          prev !== null &&
          word.idx === prev.idx + 1 &&
          blockOf(word.start) === blockOf(prev.start) &&
          word.start - prev.end <= MAX_SCRIPT_GAP_S;
        if (continues) runs[runs.length - 1].end = Math.max(runs[runs.length - 1].end, word.end);
        else runs.push({ start: word.start, end: word.end });
        prev = word;
      }
      return runs;
    },
    [words, displaySpans],
  );

  const handleRemove = useCallback(
    (idxs: number[]) => {
      const runs = runsOf(idxs);
      if (runs.length > 0) void onApplyRanges(cutRanges(ranges, runs, wordStarts));
    },
    [runsOf, ranges, wordStarts, onApplyRanges],
  );

  // A restore selection can mix struck and kept words. Only the struck
  // parts are restored, each on its own, and only next to rows of the block
  // the words are shown under (a reordered lesson has other blocks nearby
  // in time).
  const handleRestore = useCallback(
    (idxs: number[]) => {
      let next: Range[] = ranges;
      for (const run of runsOf(idxs)) {
        const span = displaySpans.find((d) => run.start >= d.start && run.start < d.end);
        for (const piece of subtractRows(run, next)) {
          next = restoreRange(next, piece, wordStarts, span);
        }
      }
      void onApplyRanges(next);
    },
    [runsOf, ranges, displaySpans, wordStarts, onApplyRanges],
  );

  const handlePauseAction = useCallback(
    (afterWordId: string, action: PauseAction | null) => {
      const pause = pausesByWordId.get(afterWordId);
      if (!pause) return;
      const whole = restoreRange(ranges, pause, wordStarts);
      const cut = pauseCut(pause, action);
      void onApplyRanges(cut ? cutRanges(whole, [cut], wordStarts) : whole);
    },
    [pausesByWordId, ranges, wordStarts, onApplyRanges],
  );

  // What Quick cleanup would cut in this lesson: filler words still in it,
  // and long pauses it still keeps whole.
  const cleanup = useMemo(() => {
    const fillers = displayWords.filter((word) => !word.removed && inBlocks(word.start) && isFillerWord(word.text));
    const longPauses = pauses.filter(
      (pause) => inBlocks(pause.start) && keptLength(pause, ranges) >= pause.end - pause.start - 0.02,
    );
    const cuts = [
      ...fillers.map((word) => ({ start: word.start, end: word.end })),
      ...longPauses.flatMap((pause) => {
        const cut = pauseCut(pause, "shorten");
        return cut ? [cut] : [];
      }),
    ];
    const target = cutRanges(ranges, cuts, wordStarts);
    return {
      fillerCount: fillers.length,
      pauseCount: longPauses.length,
      target,
      saved: totalLength(ranges) - totalLength(target),
    };
  }, [displayWords, pauses, ranges, inBlocks, wordStarts]);

  // The segments right after Clean up. Any later change (another edit, an
  // undo) hides the message, since its Undo would then reverse that newer
  // change instead.
  const cleanupStateRef = useRef<{ ranges: readonly Range[]; undoDepth: number } | null>(null);
  useEffect(() => {
    if (!cleanupDone) return;
    const marked = cleanupStateRef.current;
    if (!marked) {
      cleanupStateRef.current = { ranges, undoDepth };
    } else if (marked.ranges !== ranges || marked.undoDepth !== undoDepth) {
      cleanupStateRef.current = null;
      setCleanupDone(null);
    }
  }, [cleanupDone, ranges, undoDepth]);

  if (words.length === 0) {
    return (
      <div className="mt-2 flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm">
        <p className="m-0 font-medium">Edit this lesson by its words</p>
        <p className="m-0 text-muted-foreground">
          Remove filler words, long pauses and mistakes just by editing the text. CourseCut needs to listen to the
          recording once more to time every word. This uses your OpenAI key, like transcription did, and covers
          every lesson of this video.
        </p>
        <div>
          <Button type="button" onClick={onFetchWords} disabled={fetchingWords || busy}>
            {fetchingWords && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
            {fetchingWords
              ? fetchDetail
                ? `Getting word timings (${fetchDetail})`
                : "Getting word timings…"
              : "Get word timings"}
          </Button>
        </div>
      </div>
    );
  }

  const cleanupCount = cleanup.fillerCount + cleanup.pauseCount;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <div className="mt-2">
      {cleanupDone ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
          <span>{cleanupDone}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              onUndo();
              setCleanupDone(null);
            }}
          >
            Undo
          </Button>
        </div>
      ) : (
        cleanupCount > 0 && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              <Sparkles className="size-4 text-amber-400" aria-hidden="true" />
              <span>
                Quick cleanup:{" "}
                {[
                  cleanup.fillerCount > 0 && plural(cleanup.fillerCount, "filler word"),
                  cleanup.pauseCount > 0 && plural(cleanup.pauseCount, "long pause"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {cleanup.saved >= 0.5 && (
                  <span className="text-muted-foreground"> (saves {formatLength(cleanup.saved)})</span>
                )}
              </span>
            </span>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={async () => {
                cleanupStateRef.current = null;
                const fillerCount = cleanup.fillerCount;
                const pauseCount = cleanup.pauseCount;
                // Show the message (and arm its Undo) only once the cut is
                // saved and on the undo stack.
                if (!(await onApplyRanges(cleanup.target))) return;
                const parts = [
                  fillerCount > 0 && `removed ${plural(fillerCount, "filler word")}`,
                  pauseCount > 0 && `shortened ${plural(pauseCount, "pause")}`,
                ].filter(Boolean);
                const text = parts.join(" and ");
                setCleanupDone(text.charAt(0).toUpperCase() + text.slice(1) + ".");
              }}
            >
              Clean up
            </Button>
          </div>
        )
      )}

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowRemoved((value) => !value)}
          aria-pressed={showRemoved}
        >
          {showRemoved ? <Eye /> : <EyeOff />}
          {showRemoved ? "Showing removed words" : "Hiding removed words"}
        </Button>
        {hasTimedLayers && (
          <span className="w-full text-xs text-amber-400">
            This lesson has overlays or blur boxes. Cutting words before them moves them earlier in the video, so
            check the Blur &amp; cover and Overlays tabs after editing.
          </span>
        )}
      </div>

      <WordTranscript
        ref={ref}
        paragraphs={paragraphs}
        words={displayWords}
        showRemoved={showRemoved}
        readOnly={busy}
        active={active}
        pausesByWordId={pausesByWordId}
        pauseActions={pauseActions}
        onPauseAction={handlePauseAction}
        onRemove={handleRemove}
        onRestore={handleRestore}
        onSeek={onSeek}
      />
    </div>
  );
});

export default LessonScript;
