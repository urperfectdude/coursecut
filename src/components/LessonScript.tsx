import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Loader2, Sparkles } from "lucide-react";
import type { LessonSegment, PauseAction, TranscriptSegment, TranscriptWord } from "../db";
import { findFillerWordIdxs } from "../lib/fillers";
import {
  formatLength,
  groupLessonParagraphs,
  lengthAfterCuts,
  summarizeEdits,
  wordsInRange,
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
  pauseActions: ReadonlyMap<string, PauseAction>;
  videoDuration: number;
  readOnly: boolean;
  /** Whether the video has word timings at all (else the fetch card). */
  hasWords: boolean;
  fetchingWords: boolean;
  fetchDetail?: string | null;
  onFetchWords: () => void;
  onRemove: (idxs: number[]) => void;
  onRestore: (idxs: number[]) => void;
  onPauseAction: (afterWordId: string, action: PauseAction | null) => void;
  onCleanUp: (fillerIdxs: number[], pauseWordIds: string[]) => void;
  onUndo: () => void;
  /** The page's undo stack size: the cleanup message's Undo is only valid
   * while Clean up is the latest entry. */
  undoDepth: number;
  /** False while the tab is hidden: keyboard removal is off then. */
  active: boolean;
  onSeek: (time: number) => void;
}

/**
 * The lesson editor's Script tab (docs/text-editing-plan.md §6.3): this
 * lesson's words, grouped under its segments, with Quick cleanup on top.
 * Edits are to the video's shared word list, so they show in every lesson
 * that contains those words.
 */
const LessonScript = forwardRef<WordTranscriptHandle, LessonScriptProps>(function LessonScript(
  {
    lessonSegments,
    transcriptSegments,
    words,
    pauses,
    pausesByWordId,
    pauseActions,
    videoDuration,
    readOnly,
    hasWords,
    fetchingWords,
    fetchDetail,
    onFetchWords,
    onRemove,
    onRestore,
    onPauseAction,
    onCleanUp,
    onUndo,
    undoDepth,
    active,
    onSeek,
  },
  ref,
) {
  const [showRemoved, setShowRemoved] = useState(true);
  const [cleanupDone, setCleanupDone] = useState<string | null>(null);
  // The edit state right after Clean up. Any later change (another edit,
  // an undo) hides the message, since its Undo would then reverse that
  // newer change instead.
  const cleanupStateRef = useRef<{
    words: readonly TranscriptWord[];
    pauseActions: ReadonlyMap<string, PauseAction>;
    undoDepth: number;
  } | null>(null);
  useEffect(() => {
    if (!cleanupDone) return;
    const marked = cleanupStateRef.current;
    if (!marked) {
      cleanupStateRef.current = { words, pauseActions, undoDepth };
    } else if (marked.words !== words || marked.pauseActions !== pauseActions || marked.undoDepth !== undoDepth) {
      cleanupStateRef.current = null;
      setCleanupDone(null);
    }
  }, [cleanupDone, words, pauseActions, undoDepth]);

  const previousRef = useRef<Map<string, TranscriptWord[]>>(new Map());
  const paragraphs = useMemo(() => {
    const next = groupLessonParagraphs(lessonSegments, transcriptSegments, words, previousRef.current);
    previousRef.current = new Map(next.map((p) => [p.key, p.words]));
    return next;
  }, [lessonSegments, transcriptSegments, words]);

  // What Quick cleanup would touch in this lesson: filler words not yet
  // removed, and long pauses with no decision yet.
  const cleanup = useMemo(() => {
    const lessonWords = lessonSegments.flatMap((segment) => wordsInRange(words, segment.start, segment.end));
    const fillerIdxs = [...new Set(findFillerWordIdxs(lessonWords))];
    const pauseWordIds = [
      ...new Set(
        pauses
          .filter(
            (pause) =>
              !pauseActions.has(pause.afterWordId) &&
              lessonSegments.some((segment) => pause.start >= segment.start && pause.end <= segment.end),
          )
          .map((pause) => pause.afterWordId),
      ),
    ];
    const fillerSet = new Set(fillerIdxs);
    const wordsAfter = words.map((word) => (fillerSet.has(word.idx) ? { ...word, removed: true } : word));
    const actionsAfter = new Map(pauseActions);
    for (const id of pauseWordIds) actionsAfter.set(id, "shorten");
    const now = summarizeEdits(words, videoDuration, pauses, pauseActions);
    const after = summarizeEdits(wordsAfter, videoDuration, pauses, actionsAfter);
    const saved = lengthAfterCuts(lessonSegments, now.cuts) - lengthAfterCuts(lessonSegments, after.cuts);
    return { fillerIdxs, pauseWordIds, saved };
  }, [lessonSegments, words, pauses, pauseActions, videoDuration]);

  if (!hasWords) {
    return (
      <div className="mt-2 flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm">
        <p className="m-0 font-medium">Edit this lesson by its words</p>
        <p className="m-0 text-muted-foreground">
          Remove filler words, long pauses and mistakes just by editing the text. CourseCut needs to listen to the
          recording once more to time every word. This uses your OpenAI key, like transcription did, and covers
          every lesson of this video.
        </p>
        <div>
          <Button type="button" onClick={onFetchWords} disabled={fetchingWords || readOnly}>
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

  const cleanupCount = cleanup.fillerIdxs.length + cleanup.pauseWordIds.length;

  return (
    <div className="mt-2">
      {cleanupDone ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
          <span>{cleanupDone}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
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
                  cleanup.fillerIdxs.length > 0 &&
                    `${cleanup.fillerIdxs.length} filler word${cleanup.fillerIdxs.length === 1 ? "" : "s"}`,
                  cleanup.pauseWordIds.length > 0 &&
                    `${cleanup.pauseWordIds.length} long pause${cleanup.pauseWordIds.length === 1 ? "" : "s"}`,
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
              disabled={readOnly}
              onClick={() => {
                cleanupStateRef.current = null;
                onCleanUp(cleanup.fillerIdxs, cleanup.pauseWordIds);
                const fillers = cleanup.fillerIdxs.length;
                const shortened = cleanup.pauseWordIds.length;
                const parts = [
                  fillers > 0 && `removed ${fillers} filler word${fillers === 1 ? "" : "s"}`,
                  shortened > 0 && `shortened ${shortened} pause${shortened === 1 ? "" : "s"}`,
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
        <span className="text-xs text-muted-foreground">
          Select words, then press Delete or click Remove. Click a word to play from it.
        </span>
        <span className="w-full text-xs text-amber-400">
          Preview only for now: removed words and pauses are skipped in the Final video, but exports don't cut
          them yet.
        </span>
      </div>

      <WordTranscript
        ref={ref}
        paragraphs={paragraphs}
        words={words}
        showRemoved={showRemoved}
        readOnly={readOnly}
        active={active}
        pausesByWordId={pausesByWordId}
        pauseActions={pauseActions}
        onPauseAction={onPauseAction}
        onRemove={onRemove}
        onRestore={onRestore}
        onSeek={onSeek}
      />
    </div>
  );
});

export default LessonScript;
