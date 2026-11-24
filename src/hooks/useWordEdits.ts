import { useCallback, useEffect, useRef, useState } from "react";
import { updateTranscriptWords, type TranscriptSegment, type TranscriptWord } from "../db";

/** Saves land this long after the last edit (docs/text-editing-plan.md §8.0). */
const SAVE_DEBOUNCE_MS = 500;
/** A failed save retries on its own after this long. */
const SAVE_RETRY_MS = 3000;

/**
 * Word edit state for one video: applied in memory at once, undoable
 * instantly, and saved in the background.
 *
 * - Undo/redo are snapshot stacks of the whole word array (the approach of
 *   Rescript v1.0.9's `lib/store.ts`, reimplemented here without zustand).
 *   An edit replaces only the changed word objects, so snapshots share the
 *   rest and cost one array of references each.
 * - Saving: every change marks its word id dirty. One batched
 *   `update_transcript_words` call goes out `SAVE_DEBOUNCE_MS` after the
 *   last edit. Only one save is in flight at a time; edits made meanwhile
 *   go out in the next one. `flush()` saves everything now and resolves
 *   once it's all in the database, or **rejects** if a save failed: call
 *   it before anything that reads segments from the database (Analyze,
 *   re-transcribe, VTT import) and stop if it rejects. It also runs on
 *   unmount.
 * - A failed save keeps its ids dirty, reports through `onError`, and
 *   retries by itself every `SAVE_RETRY_MS` (and on the next edit/flush).
 * - Known gap: quitting the app within ~0.5 s of an edit can lose that
 *   edit; the IPC call may not finish before the webview is torn down.
 */
export function useWordEdits({
  videoId,
  onSegmentsSaved,
  onError,
}: {
  videoId: string;
  /** Called with the video's segments after each save (their `keep`
   * flags are re-derived from the words). */
  onSegmentsSaved: (segments: TranscriptSegment[]) => void;
  onError: (message: string) => void;
}) {
  const [words, setWords] = useState<TranscriptWord[]>([]);
  // History lives in refs (updated outside React's updaters, which may run
  // twice); `historyVersion` re-renders for canUndo/canRedo.
  const pastRef = useRef<TranscriptWord[][]>([]);
  const futureRef = useRef<TranscriptWord[][]>([]);
  const [, setHistoryVersion] = useState(0);
  const bumpHistory = useCallback(() => setHistoryVersion((v) => v + 1), []);

  // Mirrors of state for the save path, which runs outside render.
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const dirtyRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  const callbacksRef = useRef({ onSegmentsSaved, onError });
  callbacksRef.current = { onSegmentsSaved, onError };

  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Saves whatever is dirty. Resolves true when nothing is left unsaved. */
  const save = useCallback(async (): Promise<boolean> => {
    // A loop, not one wait: another caller may start the next save while
    // we were waiting on the previous one.
    while (inflightRef.current) {
      await inflightRef.current;
    }
    if (dirtyRef.current.size === 0) return true;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    const byId = new Map(wordsRef.current.map((word) => [word.id, word]));
    const ids = [...dirtyRef.current];
    dirtyRef.current = new Set();
    const changes = ids.flatMap((id) => {
      const word = byId.get(id);
      return word ? [{ id, removed: word.removed }] : [];
    });
    let ok = true;
    const run = (async () => {
      try {
        const segments = await updateTranscriptWords(videoId, changes);
        callbacksRef.current.onSegmentsSaved(segments);
      } catch (err) {
        ok = false;
        for (const id of ids) dirtyRef.current.add(id);
        callbacksRef.current.onError(
          `Couldn't save your edits (will keep retrying): ${err instanceof Error ? err.message : String(err)}`,
        );
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          void saveRef.current();
        }, SAVE_RETRY_MS);
      }
    })();
    inflightRef.current = run;
    try {
      await run;
    } finally {
      inflightRef.current = null;
    }
    return ok && dirtyRef.current.size === 0;
  }, [videoId]);
  const saveRef = useRef(save);
  saveRef.current = save;

  /** Saves everything now. Rejects if anything is still unsaved, so callers
   * about to read segments from the database can stop instead. */
  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // A few tries: edits can land while a save is in flight, and a failed
    // save may succeed on a second attempt.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await save()) return;
    }
    throw new Error("Your latest transcript edits couldn't be saved yet, so this was stopped. Try again in a moment.");
  }, [save]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void save();
    }, SAVE_DEBOUNCE_MS);
  }, [save]);

  // Save on unmount (navigating away) and when the window closes.
  useEffect(() => {
    const onBeforeUnload = () => void flush().catch(() => {});
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      void flush().catch(() => {});
    };
  }, [flush]);

  /** Replaces the word list from the database and clears history. Callers
   * flush first and keep the editor read-only (`WordTranscript`'s
   * `readOnly`) while the operation that changes words runs, so nothing is
   * pending here. */
  const load = useCallback((next: TranscriptWord[]) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    dirtyRef.current = new Set();
    wordsRef.current = next;
    setWords(next);
    pastRef.current = [];
    futureRef.current = [];
    bumpHistory();
  }, [bumpHistory]);

  /** Swap in `next`, marking every word whose object changed as dirty. */
  const commit = useCallback(
    (next: TranscriptWord[]) => {
      const prev = wordsRef.current;
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== prev[i]) dirtyRef.current.add(next[i].id);
      }
      wordsRef.current = next;
      setWords(next);
      scheduleSave();
    },
    [scheduleSave],
  );

  const setRemoved = useCallback(
    (idxs: readonly number[], removed: boolean) => {
      const prev = wordsRef.current;
      const wanted = new Set(idxs);
      let changed = false;
      const next = prev.map((word) => {
        if (!wanted.has(word.idx) || word.removed === removed) return word;
        changed = true;
        return { ...word, removed, suggested: null };
      });
      if (!changed) return;
      pastRef.current = [...pastRef.current, prev];
      futureRef.current = [];
      commit(next);
      bumpHistory();
    },
    [commit, bumpHistory],
  );

  const undo = useCallback(() => {
    const stack = pastRef.current;
    if (stack.length === 0) return;
    pastRef.current = stack.slice(0, -1);
    futureRef.current = [...futureRef.current, wordsRef.current];
    commit(stack[stack.length - 1]);
    bumpHistory();
  }, [commit, bumpHistory]);

  const redo = useCallback(() => {
    const stack = futureRef.current;
    if (stack.length === 0) return;
    futureRef.current = stack.slice(0, -1);
    pastRef.current = [...pastRef.current, wordsRef.current];
    commit(stack[stack.length - 1]);
    bumpHistory();
  }, [commit, bumpHistory]);

  return {
    words,
    load,
    remove: useCallback((idxs: readonly number[]) => setRemoved(idxs, true), [setRemoved]),
    restore: useCallback((idxs: readonly number[]) => setRemoved(idxs, false), [setRemoved]),
    undo,
    redo,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
    flush,
  };
}
