import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowDown, RotateCcw, Trash2 } from "lucide-react";
import type { TranscriptSegment, TranscriptWord } from "../db";
import { useWordSelection } from "../hooks/useWordSelection";
import { findActiveWordIndex, groupIntoParagraphs, punctuateWords } from "../lib/transcript-words";
import { formatTimestamp } from "../lib/timestamp";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface WordTranscriptHandle {
  /** Called every animation frame by the player. Highlights the word under
   * the playhead directly on the DOM (no React render) and, while playing,
   * keeps it on screen unless the user has scrolled away. */
  setPlayhead: (time: number, playing: boolean) => void;
}

interface WordTranscriptProps {
  segments: readonly TranscriptSegment[];
  /** Sorted by `idx` (which is time order). */
  words: readonly TranscriptWord[];
  /** Only these segments' paragraphs are shown (search / chunk filter);
   * `null` shows all. */
  visibleSegmentIds: ReadonlySet<string> | null;
  showRemoved: boolean;
  /** While an operation that replaces the words runs (re-transcribe, VTT
   * import, word fetch, Analyze): no Remove/Restore, so no edit can be
   * lost when the list reloads afterwards. Playback still works. */
  readOnly?: boolean;
  onRemove: (idxs: number[]) => void;
  onRestore: (idxs: number[]) => void;
  onSeek: (time: number) => void;
}

/** Small nudge past a word's start so the player lands inside it. */
const SEEK_INTO_WORD_S = 0.001;

const reasonLabel: Record<string, string> = {
  hallucination: "Removed automatically: looks like a Whisper hallucination (a phrase repeated over silence)",
  filler: "Filler word",
};

const WordSpan = memo(function WordSpan({
  word,
  text,
  onClick,
}: {
  word: TranscriptWord;
  /** Display text: the word with the segment text's punctuation/casing. */
  text: string;
  onClick: (idx: number, el: HTMLElement) => void;
}) {
  // The trailing space lives inside the span so selection and removal
  // highlights are continuous across words (Rescript v1.0.9 does the same).
  return (
    <span
      data-wid={word.idx}
      data-removed={word.removed ? "" : undefined}
      title={word.suggested ? reasonLabel[word.suggested] : undefined}
      onClick={(event) => onClick(word.idx, event.currentTarget)}
      className={cn(
        "cursor-pointer rounded-[3px] py-0.5 transition-colors duration-75",
        word.removed
          ? "bg-red-950/40 text-red-400 line-through decoration-red-400/70"
          : "hover:bg-muted",
      )}
    >
      {text}{" "}
    </span>
  );
});

const Paragraph = memo(function Paragraph({
  segment,
  words,
  showRemoved,
  onWordClick,
  onSeek,
}: {
  segment: TranscriptSegment;
  words: TranscriptWord[];
  showRemoved: boolean;
  onWordClick: (idx: number, el: HTMLElement) => void;
  onSeek: (time: number) => void;
}) {
  const displayTexts = useMemo(() => punctuateWords(segment.text, words), [segment.text, words]);
  const shown = showRemoved ? words : words.filter((word) => !word.removed);
  if (shown.length === 0) return null;
  const firstIdx = words.length > 0 ? words[0].idx : 0;
  return (
    <div className="word-transcript-paragraph mb-4 flex gap-3">
      <button
        type="button"
        className="mt-1.5 h-fit shrink-0 cursor-pointer text-xs tabular-nums text-muted-foreground hover:text-foreground"
        onClick={() => onSeek(segment.start + SEEK_INTO_WORD_S)}
        title="Play from here"
      >
        {formatTimestamp(segment.start)}
      </button>
      <p className="m-0 min-w-0 flex-1 select-text text-[15px] leading-8">
        {shown.map((word) => (
          <WordSpan
            key={word.id}
            word={word}
            text={displayTexts[word.idx - firstIdx] ?? word.text}
            onClick={onWordClick}
          />
        ))}
      </p>
    </div>
  );
});

/**
 * Word-level transcript editor (docs/text-editing-plan.md §6.1, Phase 2):
 * one paragraph per segment, select words and Remove/Restore them, click a
 * word to play from it. Removed words stay visible struck through unless
 * `showRemoved` is off.
 */
const WordTranscript = forwardRef<WordTranscriptHandle, WordTranscriptProps>(function WordTranscript(
  { segments, words, visibleSegmentIds, showRemoved, readOnly = false, onRemove, onRestore, onSeek },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Reuse last render's per-paragraph arrays when their words didn't change,
  // so an edit re-renders only the paragraphs it touched.
  const previousParagraphsRef = useRef<Map<string, TranscriptWord[]>>(new Map());
  const paragraphs = useMemo(() => {
    const next = groupIntoParagraphs(segments, words, previousParagraphsRef.current);
    previousParagraphsRef.current = new Map(next.map((p) => [p.segment.id, p.words]));
    return next;
  }, [segments, words]);

  const removedIds = useMemo(() => {
    const ids = new Set<number>();
    for (const word of words) if (word.removed) ids.add(word.idx);
    return ids;
  }, [words]);

  const wordsRef = useRef(words);
  wordsRef.current = words;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  const seekWord = useCallback((idx: number) => {
    const word = wordsRef.current[idx];
    if (word) onSeekRef.current(word.start + SEEK_INTO_WORD_S);
  }, []);
  const stableSeek = useCallback((time: number) => onSeekRef.current(time), []);

  const { selection, clearSelection, handleWordClick } = useWordSelection({
    containerRef,
    removedIds,
    onSeekWord: seekWord,
  });

  // Which actions apply, from the words' current state rather than the
  // state when the selection was made (an undo can change it meanwhile).
  const anyKept = selection ? selection.ids.some((id) => !removedIds.has(id)) : false;
  const anyRemoved = selection ? selection.ids.some((id) => removedIds.has(id)) : false;

  const removeSelection = useCallback(() => {
    if (!selection || readOnly) return;
    onRemove(selection.ids);
    clearSelection();
  }, [selection, readOnly, onRemove, clearSelection]);

  const restoreSelection = useCallback(() => {
    if (!selection || readOnly) return;
    onRestore(selection.ids);
    clearSelection();
  }, [selection, readOnly, onRestore, clearSelection]);

  // Backspace/Delete removes the selection; Escape clears it. Not while
  // typing in a field (the search box).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!selection) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        if (anyKept) removeSelection();
        else restoreSelection();
      } else if (event.key === "Escape") {
        clearSelection();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selection, anyKept, removeSelection, restoreSelection, clearSelection]);

  // --- Playhead highlight and follow -------------------------------------
  const activeElRef = useRef<HTMLElement | null>(null);
  // Last active word's idx: the DOM lookup only runs when it changes, not
  // every frame (a 2-hour transcript has ~20k word spans).
  const activeIdxRef = useRef(-1);
  const followingRef = useRef(true);
  const [showBackToPlayhead, setShowBackToPlayhead] = useState(false);
  const playingRef = useRef(false);

  // A user scroll (wheel or touch, not our own scrollIntoView) stops
  // following until they click "Back to playhead".
  useEffect(() => {
    function stopFollowing() {
      if (!playingRef.current || !followingRef.current) return;
      followingRef.current = false;
      setShowBackToPlayhead(true);
    }
    window.addEventListener("wheel", stopFollowing, { passive: true });
    window.addEventListener("touchmove", stopFollowing, { passive: true });
    return () => {
      window.removeEventListener("wheel", stopFollowing);
      window.removeEventListener("touchmove", stopFollowing);
    };
  }, []);

  const scrollActiveIntoView = useCallback(() => {
    const el = activeElRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 80;
    if (rect.top < margin || rect.bottom > window.innerHeight - margin) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      setPlayhead(time: number, playing: boolean) {
        playingRef.current = playing;
        const list = wordsRef.current;
        const i = findActiveWordIndex(list, time);
        const idx = i >= 0 ? list[i].idx : -1;
        // Re-query when the word changed, or when its span was re-rendered
        // (an edit or the show-removed toggle replaces spans).
        if (idx === activeIdxRef.current && (idx < 0 || activeElRef.current?.isConnected)) return;
        activeIdxRef.current = idx;
        const container = containerRef.current;
        const el =
          idx >= 0 && container ? container.querySelector<HTMLElement>(`[data-wid="${idx}"]`) : null;
        if (el !== activeElRef.current) {
          activeElRef.current?.removeAttribute("data-active");
          el?.setAttribute("data-active", "");
          activeElRef.current = el;
          if (playing && followingRef.current) scrollActiveIntoView();
        }
      },
    }),
    [scrollActiveIntoView],
  );

  const backToPlayhead = useCallback(() => {
    followingRef.current = true;
    setShowBackToPlayhead(false);
    activeElRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  const shownParagraphs = visibleSegmentIds
    ? paragraphs.filter((p) => visibleSegmentIds.has(p.segment.id))
    : paragraphs;

  return (
    <div ref={containerRef} className="word-transcript relative">
      {shownParagraphs.length === 0 ? (
        <p>No matching transcript segments.</p>
      ) : (
        shownParagraphs.map((p) => (
          <Paragraph
            key={p.segment.id}
            segment={p.segment}
            words={p.words}
            showRemoved={showRemoved}
            onWordClick={handleWordClick}
            onSeek={stableSeek}
          />
        ))
      )}

      {selection && !readOnly && (
        <div
          data-transcript-toolbar
          className="absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-lg"
          style={{ top: selection.top, left: selection.left }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {anyKept && (
            <Button type="button" size="sm" variant="ghost" onClick={removeSelection}>
              <Trash2 />
              Remove
            </Button>
          )}
          {anyRemoved && (
            <Button type="button" size="sm" variant="ghost" onClick={restoreSelection}>
              <RotateCcw />
              Restore
            </Button>
          )}
        </div>
      )}

      {showBackToPlayhead && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2 shadow-lg"
          onClick={backToPlayhead}
        >
          <ArrowDown />
          Back to playhead
        </Button>
      )}
    </div>
  );
});

export default WordTranscript;
