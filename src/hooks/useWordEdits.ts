import { useCallback, useEffect, useRef, useState } from "react";
import {
  updateTranscriptWords,
  type PauseAction,
  type PauseDecision,
  type TranscriptSegment,
  type TranscriptWord,
} from "../db";

/** Saves land this long after the last edit (docs/text-editing-plan.md §8.0). */
const SAVE_DEBOUNCE_MS = 500;
/** A failed save retries on its own after this long. */
const SAVE_RETRY_MS = 3000;

/**
 * Word edit state for one video: applied in memory at once, undoable
 * instantly, and saved in the background.
 *
 * - The state is the word array plus the pause decisions (keyed by the id
 *   of the word before the pause).
 * - Undo/redo are snapshot stacks of that state (the approach of Rescript
 *   v1.0.9's `lib/store.ts`, reimplemented here without zustand). An edit
 *   replaces only the changed word objects, so snapshots share the rest
 *   and cost one array of references each.
 * - Saving: every change marks its word or pause id dirty. One batched
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
interface EditState {
  words: TranscriptWord[];
  /** The list as loaded; carried unchanged through every edit. */
  loadedWords: TranscriptWord[];
  /** Pause decisions, by the id of the word before the pause. */
  pauses: ReadonlyMap<string, PauseAction>;
}

const EMPTY_STATE: EditState = { words: [], loadedWords: [], pauses: new Map() };

/** `words` with these idxs set to `removed`; the same array if nothing changed. */
function withRemoved(words: TranscriptWord[], idxs: readonly number[], removed: boolean): TranscriptWord[] {
  const wanted = new Set(idxs);
  let changed = false;
  const next = words.map((word) => {
    if (!wanted.has(word.idx) || word.removed === removed) return word;
    changed = true;
    return { ...word, removed, suggested: null };
  });
  return changed ? next : words;
}

/** `pauses` with these decisions set (or cleared); the same map if unchanged. */
function withPauseAction(
  pauses: ReadonlyMap<string, PauseAction>,
  afterWordIds: readonly string[],
  action: PauseAction | null,
): ReadonlyMap<string, PauseAction> {
  const next = new Map(pauses);
  let changed = false;
  for (const id of afterWordIds) {
    if ((pauses.get(id) ?? null) === action) continue;
    changed = true;
    if (action) next.set(id, action);
    else next.delete(id);
  }
  return changed ? next : pauses;
}

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
  const [state, setState] = useState<EditState>(EMPTY_STATE);
  // History lives in refs (updated outside React's updaters, which may run
  // twice); `historyVersion` re-renders for canUndo/canRedo.
  const pastRef = useRef<EditState[]>([]);
  const futureRef = useRef<EditState[]>([]);
  const [, setHistoryVersion] = useState(0);
  const bumpHistory = useCallback(() => setHistoryVersion((v) => v + 1), []);

  // Mirrors of state for the save path, which runs outside render.
  const stateRef = useRef(state);
  stateRef.current = state;
  const dirtyRef = useRef<Set<string>>(new Set());
  const dirtyPausesRef = useRef<Set<string>>(new Set());
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
    if (dirtyRef.current.size === 0 && dirtyPausesRef.current.size === 0) return true;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    const current = stateRef.current;
    const byId = new Map(current.words.map((word) => [word.id, word]));
    const ids = [...dirtyRef.current];
    const pauseIds = [...dirtyPausesRef.current];
    dirtyRef.current = new Set();
    dirtyPausesRef.current = new Set();
    const changes = ids.flatMap((id) => {
      const word = byId.get(id);
      return word ? [{ id, removed: word.removed }] : [];
    });
    const pauses: PauseDecision[] = pauseIds.map((id) => ({
      after_word_id: id,
      action: current.pauses.get(id) ?? null,
    }));
    let ok = true;
    const run = (async () => {
      try {
        const segments = await updateTranscriptWords(videoId, changes, pauses);
        callbacksRef.current.onSegmentsSaved(segments);
      } catch (err) {
        ok = false;
        for (const id of ids) dirtyRef.current.add(id);
        for (const id of pauseIds) dirtyPausesRef.current.add(id);
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
    return ok && dirtyRef.current.size === 0 && dirtyPausesRef.current.size === 0;
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
  const load = useCallback((words: TranscriptWord[], pauses: readonly PauseDecision[] = []) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    dirtyRef.current = new Set();
    dirtyPausesRef.current = new Set();
    const next: EditState = {
      words,
      loadedWords: words,
      pauses: new Map(
        pauses.flatMap((p) => (p.action ? [[p.after_word_id, p.action] as const] : [])),
      ),
    };
    stateRef.current = next;
    setState(next);
    pastRef.current = [];
    futureRef.current = [];
    bumpHistory();
  }, [bumpHistory]);

  /** Swap in `next`, marking every word whose object changed, and every
   * pause whose decision changed, as dirty. */
  const commit = useCallback(
    (next: EditState) => {
      const prev = stateRef.current;
      if (next.words !== prev.words) {
        for (let i = 0; i < next.words.length; i++) {
          if (next.words[i] !== prev.words[i]) dirtyRef.current.add(next.words[i].id);
        }
      }
      if (next.pauses !== prev.pauses) {
        for (const id of new Set([...prev.pauses.keys(), ...next.pauses.keys()])) {
          if (prev.pauses.get(id) !== next.pauses.get(id)) dirtyPausesRef.current.add(id);
        }
      }
      stateRef.current = next;
      setState(next);
      scheduleSave();
    },
    [scheduleSave],
  );

  /** One undoable step from the current state to `next`. Returns false
   * (and records nothing) when `next` is the same state. */
  const apply = useCallback(
    (next: EditState): boolean => {
      const prev = stateRef.current;
      if (next.words === prev.words && next.pauses === prev.pauses) return false;
      pastRef.current = [...pastRef.current, prev];
      futureRef.current = [];
      commit(next);
      bumpHistory();
      return true;
    },
    [commit, bumpHistory],
  );

  const setRemoved = useCallback(
    (idxs: readonly number[], removed: boolean) => {
      const prev = stateRef.current;
      return apply({ ...prev, words: withRemoved(prev.words, idxs, removed) });
    },
    [apply],
  );

  /** Sets (or with `null` clears) the decision on the pauses after these
   * words. */
  const setPauseAction = useCallback(
    (afterWordIds: readonly string[], action: PauseAction | null) => {
      const prev = stateRef.current;
      return apply({ ...prev, pauses: withPauseAction(prev.pauses, afterWordIds, action) });
    },
    [apply],
  );

  /** Quick cleanup as one undo step: remove these words and shorten these
   * pauses. */
  const cleanUp = useCallback(
    (removeIdxs: readonly number[], shortenAfterWordIds: readonly string[]) => {
      const prev = stateRef.current;
      return apply({
        ...prev,
        words: withRemoved(prev.words, removeIdxs, true),
        pauses: withPauseAction(prev.pauses, shortenAfterWordIds, "shorten"),
      });
    },
    [apply],
  );

  const undo = useCallback((): boolean => {
    const stack = pastRef.current;
    if (stack.length === 0) return false;
    pastRef.current = stack.slice(0, -1);
    futureRef.current = [...futureRef.current, stateRef.current];
    commit(stack[stack.length - 1]);
    bumpHistory();
    return true;
  }, [commit, bumpHistory]);

  const redo = useCallback((): boolean => {
    const stack = futureRef.current;
    if (stack.length === 0) return false;
    futureRef.current = stack.slice(0, -1);
    pastRef.current = [...pastRef.current, stateRef.current];
    commit(stack[stack.length - 1]);
    bumpHistory();
    return true;
  }, [commit, bumpHistory]);

  return {
    words: state.words,
    /** The word list as last loaded: same timings as `words`, but its
     * identity only changes on load, for memos that depend on timing only. */
    timingWords: state.loadedWords,
    pauseActions: state.pauses,
    load,
    /** Edits return true when they changed something (and so added an
     * undo step). */
    remove: useCallback((idxs: readonly number[]) => setRemoved(idxs, true), [setRemoved]),
    restore: useCallback((idxs: readonly number[]) => setRemoved(idxs, false), [setRemoved]),
    setPauseAction,
    cleanUp,
    undo,
    redo,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
    flush,
  };
}
