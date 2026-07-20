import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  cancelExport,
  deleteLesson,
  getVideo,
  listExports,
  listLessons,
  listTranscriptSegments,
  mergeLessons,
  pauseExport,
  queueExport,
  resumeExport,
  retryExport,
  splitLesson,
  updateLesson,
  updateTranscriptSegment,
  type ExportRow,
  type Lesson,
  type TranscriptSegment,
  type Video,
} from "../db";

/** Export statuses that mean "the worker (or the user) is still expected to
 * act on this row" — used to decide whether the export queue panel should
 * keep polling `listExports` (see the effect near the export state below).
 * Exported so `ExportHistoryView` (PRD §11, Milestone 8) can poll on the
 * same basis instead of maintaining a second definition that could drift. */
export const ACTIVE_EXPORT_STATUSES = new Set(["queued", "paused", "running"]);

/** How often the export queue panel polls `listExports` while at least one
 * export is active. There's no push mechanism from Rust to the frontend
 * yet (see PRD milestone notes) — polling is the pragmatic choice here. */
const EXPORT_POLL_INTERVAL_MS = 1500;

interface LessonEditorViewProps {
  videoId: string;
  onBack: () => void;
}

/** Transcript Mode (PRD §8.1, primary) vs. Timestamp Mode (PRD §8.2,
 * fallback precision editor). Both operate on the same `lessons` rows —
 * Timestamp Mode is additive UI, not a second editing implementation. */
type EditorMode = "transcript" | "timestamp";

// FFprobe isn't wired up for per-video frame rate in this codebase (see
// `coursecut-architecture`), so there's no real FPS to step by. This
// approximates one "frame" as a fixed 1/30s step for Timestamp Mode's
// keyboard shortcuts and scrubber granularity — a deliberate approximation,
// not a stand-in for real FPS probing (out of scope for this milestone).
const FRAME_STEP_SECONDS = 1 / 30;
const BIG_STEP_SECONDS = 1;

/** One entry on the undo/redo stack — deliberately scoped to only the two
 * highest-frequency, cheaply-reversible edits (keep/delete toggles and
 * lesson renames); see the note rendered near the Undo/Redo buttons. */
interface UndoableAction {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/** Seconds → `m:ss` / `h:mm:ss`, matching `ProjectDetailView`'s formatting. */
function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${m}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : mmss;
}

export default function LessonEditorView({ videoId, onBack }: LessonEditorViewProps) {
  const [video, setVideo] = useState<Video | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");

  // Milestone 6: Transcript Mode / Timestamp Mode toggle (PRD §8.1/§8.2).
  // Transcript Mode's panel/behavior below is unchanged from Milestone 5;
  // `mode` only decides which left-hand panel is shown.
  const [mode, setMode] = useState<EditorMode>("transcript");

  // Which lesson is "selected" — drives Timestamp Mode's precision panel,
  // and is shared with (highlighted in) the lessons list used by both
  // modes. Selecting a lesson is purely additive UI state; it doesn't gate
  // any Transcript Mode action.
  const [selectedLessonId, setSelectedLessonId] = useState<string | null>(null);

  // Lesson preview (loop-play `[start, end)`), available regardless of
  // mode. `previewingLessonRef` mirrors the state synchronously so the
  // video element's native event handlers (which can fire before a state
  // update has re-rendered) always see the current value — same
  // ref+state-mirror pattern as `lessonBusyRef`/`lessonBusyIds` below.
  const [previewingLessonId, setPreviewingLessonIdState] = useState<string | null>(null);
  const previewingLessonRef = useRef<string | null>(null);
  // Set right before we programmatically seek the video back to a lesson's
  // `start` during loop-back playback, so the `onSeeking` handler can tell
  // "we did this" apart from a manual scrub and not immediately cancel the
  // preview it just started.
  const loopSeekRef = useRef(false);

  function setPreviewingLessonId(id: string | null) {
    previewingLessonRef.current = id;
    setPreviewingLessonIdState(id);
  }

  const [videoDuration, setVideoDuration] = useState(0);

  // Draft values for Timestamp Mode's start/end numeric inputs, keyed by
  // lesson id — same pattern as `titleDrafts`/`summaryDrafts` above.
  const [startDrafts, setStartDrafts] = useState<Record<string, string>>({});
  const [endDrafts, setEndDrafts] = useState<Record<string, string>>({});
  const [timestampError, setTimestampError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Per-row "in-flight" guards (same defensive pattern as
  // `ProjectDetailView`'s `inFlightRef`/`inFlightIds`) — a rapid double
  // click on a segment's keep toggle, or a lesson's Split/Merge/Delete/
  // rename-commit, shouldn't fire two concurrent mutations against the same
  // row. Kept as two separate sets since segment ids and lesson ids are
  // independent id spaces.
  const segmentBusyRef = useRef<Set<string>>(new Set());
  const [segmentBusyIds, setSegmentBusyIds] = useState<Set<string>>(new Set());
  const lessonBusyRef = useRef<Set<string>>(new Set());
  const [lessonBusyIds, setLessonBusyIds] = useState<Set<string>>(new Set());

  // In-progress edits for the inline title/summary fields, keyed by lesson
  // id — only present while a field differs from its last-committed value.
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [summaryDrafts, setSummaryDrafts] = useState<Record<string, string>>({});

  // Undo/redo stacks (see `UndoableAction` above for scope).
  const [undoStack, setUndoStack] = useState<UndoableAction[]>([]);
  const [redoStack, setRedoStack] = useState<UndoableAction[]>([]);

  // Export queue (PRD §10-11, Milestone 7). `selectedForExport` drives the
  // per-lesson checkboxes used by "Export selected"; `exports` is this
  // video's slice of the project-wide `list_exports` result (Rust filters
  // by project, this component filters further down to this video's own
  // lessons — see `loadExports`/`refreshExports`). `exportBusyRef`/
  // `exportBusyIds` is the same in-flight-guard pattern as
  // `lessonBusyRef`/`lessonBusyIds` above, keyed by export id instead of
  // lesson id so a rapid double-click on Pause/Resume/Cancel/Retry can't
  // fire two concurrent mutations against the same export row.
  const [selectedForExport, setSelectedForExport] = useState<Set<string>>(new Set());
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportBusyRef = useRef<Set<string>>(new Set());
  const [exportBusyIds, setExportBusyIds] = useState<Set<string>>(new Set());

  const loadExports = useCallback(async (projectId: string, lessonList: Lesson[]) => {
    try {
      const all = await listExports(projectId);
      const lessonIds = new Set(lessonList.map((lesson) => lesson.id));
      setExports(all.filter((row) => lessonIds.has(row.lesson_id)));
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getVideo(videoId), listTranscriptSegments(videoId), listLessons(videoId)])
      .then(([videoRow, segmentRows, lessonRows]) => {
        if (cancelled) return;
        setVideo(videoRow);
        setSegments(segmentRows);
        setLessons(lessonRows);
        if (videoRow) void loadExports(videoRow.project_id, lessonRows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [videoId, loadExports]);

  // Re-fetch using the current `video`/`lessons` state — used after
  // queuing/pausing/resuming/cancelling/retrying an export, and by the
  // polling effect below.
  const refreshExports = useCallback(() => {
    if (!video) return Promise.resolve();
    return loadExports(video.project_id, lessons);
  }, [video, lessons, loadExports]);

  // Poll while any export is queued/paused/running; stop once everything
  // visible has settled into done/failed/cancelled, rather than polling
  // forever regardless of activity.
  useEffect(() => {
    const hasActive = exports.some((row) => ACTIVE_EXPORT_STATUSES.has(row.status));
    if (!hasActive) return;
    const interval = setInterval(() => {
      void refreshExports();
    }, EXPORT_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [exports, refreshExports]);

  // If the selected/previewing lesson is deleted or merged away, drop the
  // now-dangling reference instead of pointing Timestamp Mode or preview at
  // a lesson id that no longer exists.
  useEffect(() => {
    if (selectedLessonId && !lessons.some((lesson) => lesson.id === selectedLessonId)) {
      setSelectedLessonId(null);
    }
    if (previewingLessonRef.current && !lessons.some((lesson) => lesson.id === previewingLessonRef.current)) {
      videoRef.current?.pause();
      setPreviewingLessonId(null);
    }
  }, [lessons, selectedLessonId]);

  const pushUndo = useCallback((action: UndoableAction) => {
    setUndoStack((prev) => [...prev, action]);
    // A fresh edit invalidates whatever was previously redoable.
    setRedoStack([]);
  }, []);

  const handleUndo = useCallback(async () => {
    const action = undoStack[undoStack.length - 1];
    if (!action) return;
    setUndoStack((prev) => prev.slice(0, -1));
    try {
      await action.undo();
      setRedoStack((prev) => [...prev, action]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [undoStack]);

  const handleRedo = useCallback(async () => {
    const action = redoStack[redoStack.length - 1];
    if (!action) return;
    setRedoStack((prev) => prev.slice(0, -1));
    try {
      await action.redo();
      setUndoStack((prev) => [...prev, action]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [redoStack]);

  // ---------------------------------------------------------------------
  // Transcript: keep/delete toggle + search
  // ---------------------------------------------------------------------

  async function applySegmentKeep(segmentId: string, keep: boolean) {
    const updated = await updateTranscriptSegment(segmentId, keep);
    setSegments((prev) => prev.map((segment) => (segment.id === segmentId ? updated : segment)));
  }

  const handleToggleKeep = useCallback(
    async (segment: TranscriptSegment) => {
      if (segmentBusyRef.current.has(segment.id)) return;
      segmentBusyRef.current.add(segment.id);
      setSegmentBusyIds(new Set(segmentBusyRef.current));
      const previousKeep = segment.keep;
      const nextKeep = !previousKeep;
      try {
        await applySegmentKeep(segment.id, nextKeep);
        pushUndo({
          undo: () => applySegmentKeep(segment.id, previousKeep),
          redo: () => applySegmentKeep(segment.id, nextKeep),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        segmentBusyRef.current.delete(segment.id);
        setSegmentBusyIds(new Set(segmentBusyRef.current));
      }
    },
    [pushUndo],
  );

  function seekTo(time: number) {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  }

  const filteredSegments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return segments;
    return segments.filter((segment) => segment.text.toLowerCase().includes(query));
  }, [segments, searchQuery]);

  // ---------------------------------------------------------------------
  // Lessons: rename (undoable), split/merge/delete (not undoable — see
  // `docs/PRD.md` §8.1 and the note rendered near the Undo button)
  // ---------------------------------------------------------------------

  async function refreshLessons() {
    setLessons(await listLessons(videoId));
  }

  const commitTitle = useCallback(
    async (lesson: Lesson) => {
      const draft = titleDrafts[lesson.id];
      setTitleDrafts((prev) => {
        if (!(lesson.id in prev)) return prev;
        const next = { ...prev };
        delete next[lesson.id];
        return next;
      });
      if (draft === undefined) return;
      const trimmed = draft.trim();
      if (trimmed === "" || trimmed === lesson.title) return;
      if (lessonBusyRef.current.has(lesson.id)) return;
      lessonBusyRef.current.add(lesson.id);
      setLessonBusyIds(new Set(lessonBusyRef.current));
      const previousTitle = lesson.title;
      try {
        const updated = await updateLesson(lesson.id, { title: trimmed });
        setLessons((prev) => prev.map((l) => (l.id === lesson.id ? updated : l)));
        pushUndo({
          undo: async () => {
            const reverted = await updateLesson(lesson.id, { title: previousTitle });
            setLessons((prev) => prev.map((l) => (l.id === lesson.id ? reverted : l)));
          },
          redo: async () => {
            const reapplied = await updateLesson(lesson.id, { title: trimmed });
            setLessons((prev) => prev.map((l) => (l.id === lesson.id ? reapplied : l)));
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        lessonBusyRef.current.delete(lesson.id);
        setLessonBusyIds(new Set(lessonBusyRef.current));
      }
    },
    [titleDrafts, pushUndo],
  );

  const commitSummary = useCallback(
    async (lesson: Lesson) => {
      const draft = summaryDrafts[lesson.id];
      setSummaryDrafts((prev) => {
        if (!(lesson.id in prev)) return prev;
        const next = { ...prev };
        delete next[lesson.id];
        return next;
      });
      if (draft === undefined) return;
      const trimmed = draft.trim();
      if (trimmed === (lesson.summary ?? "")) return;
      if (lessonBusyRef.current.has(lesson.id)) return;
      lessonBusyRef.current.add(lesson.id);
      setLessonBusyIds(new Set(lessonBusyRef.current));
      const previousSummary = lesson.summary ?? "";
      try {
        const updated = await updateLesson(lesson.id, { summary: trimmed });
        setLessons((prev) => prev.map((l) => (l.id === lesson.id ? updated : l)));
        pushUndo({
          undo: async () => {
            const reverted = await updateLesson(lesson.id, { summary: previousSummary });
            setLessons((prev) => prev.map((l) => (l.id === lesson.id ? reverted : l)));
          },
          redo: async () => {
            const reapplied = await updateLesson(lesson.id, { summary: trimmed });
            setLessons((prev) => prev.map((l) => (l.id === lesson.id ? reapplied : l)));
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        lessonBusyRef.current.delete(lesson.id);
        setLessonBusyIds(new Set(lessonBusyRef.current));
      }
    },
    [summaryDrafts, pushUndo],
  );

  const handleSplit = useCallback(async (lesson: Lesson) => {
    if (lessonBusyRef.current.has(lesson.id)) return;
    lessonBusyRef.current.add(lesson.id);
    setLessonBusyIds(new Set(lessonBusyRef.current));
    try {
      await splitLesson(lesson.id, currentTime);
      await refreshLessons();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      lessonBusyRef.current.delete(lesson.id);
      setLessonBusyIds(new Set(lessonBusyRef.current));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, videoId]);

  const handleMergeWithNext = useCallback(async (lesson: Lesson, next: Lesson) => {
    if (lessonBusyRef.current.has(lesson.id) || lessonBusyRef.current.has(next.id)) return;
    lessonBusyRef.current.add(lesson.id);
    lessonBusyRef.current.add(next.id);
    setLessonBusyIds(new Set(lessonBusyRef.current));
    try {
      await mergeLessons(lesson.id, next.id);
      await refreshLessons();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      lessonBusyRef.current.delete(lesson.id);
      lessonBusyRef.current.delete(next.id);
      setLessonBusyIds(new Set(lessonBusyRef.current));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const handleDeleteLesson = useCallback(async (lesson: Lesson) => {
    if (lessonBusyRef.current.has(lesson.id)) return;
    if (!window.confirm(`Delete lesson "${lesson.title}"? This cannot be undone.`)) return;
    lessonBusyRef.current.add(lesson.id);
    setLessonBusyIds(new Set(lessonBusyRef.current));
    try {
      await deleteLesson(lesson.id);
      await refreshLessons();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      lessonBusyRef.current.delete(lesson.id);
      setLessonBusyIds(new Set(lessonBusyRef.current));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // ---------------------------------------------------------------------
  // Export queue (PRD §10-11, Milestone 7). "Export" (single lesson),
  // "Export selected", and "Export all lessons" all funnel through
  // `handleExport`, which is the only place that opens the folder picker
  // and calls `queueExport` — this satisfies PRD §10's "single lesson,
  // multiple selected lessons, entire recording" without three separate
  // code paths.
  // ---------------------------------------------------------------------

  const toggleExportSelection = useCallback((lessonId: string) => {
    setSelectedForExport((prev) => {
      const next = new Set(prev);
      if (next.has(lessonId)) next.delete(lessonId);
      else next.add(lessonId);
      return next;
    });
  }, []);

  const handleExport = useCallback(
    async (lessonIds: string[]) => {
      if (lessonIds.length === 0 || exporting) return;
      setExportError(null);
      try {
        const dir = await open({ directory: true });
        if (!dir || typeof dir !== "string") return;
        setExporting(true);
        await queueExport(lessonIds, dir);
        await refreshExports();
      } catch (err) {
        setExportError(err instanceof Error ? err.message : String(err));
      } finally {
        setExporting(false);
      }
    },
    [exporting, refreshExports],
  );

  /** Pause/Resume/Cancel/Retry all share this shape: a single-argument Rust
   * command, an in-flight guard keyed by export id, and a refresh on
   * success. `action` is one of the imported `db.ts` wrappers. */
  const handleExportAction = useCallback(
    async (id: string, action: (id: string) => Promise<ExportRow>) => {
      if (exportBusyRef.current.has(id)) return;
      exportBusyRef.current.add(id);
      setExportBusyIds(new Set(exportBusyRef.current));
      try {
        await action(id);
        await refreshExports();
      } catch (err) {
        setExportError(err instanceof Error ? err.message : String(err));
      } finally {
        exportBusyRef.current.delete(id);
        setExportBusyIds(new Set(exportBusyRef.current));
      }
    },
    [refreshExports],
  );

  // ---------------------------------------------------------------------
  // Timestamp Mode (PRD §8.2, fallback precision editor) — start/end
  // trimming via the same `updateLesson` patch command Milestone 5 already
  // uses for title/summary; "Split at Playhead" reuses `handleSplit`
  // above rather than re-implementing splitting.
  // ---------------------------------------------------------------------

  const commitStart = useCallback(
    async (lesson: Lesson) => {
      // Checked (and, on failure, surfaced) before touching the draft at
      // all: an edit that arrives while a prior one for this lesson is
      // still in flight must not be silently discarded — the draft stays
      // put so the user can retry once the busy state clears.
      if (lessonBusyRef.current.has(lesson.id)) {
        setTimestampError("Still saving the previous change — try again in a moment.");
        return;
      }
      const draft = startDrafts[lesson.id];
      setStartDrafts((prev) => {
        if (!(lesson.id in prev)) return prev;
        const next = { ...prev };
        delete next[lesson.id];
        return next;
      });
      if (draft === undefined) return;
      const parsed = Number(draft);
      if (!Number.isFinite(parsed)) {
        setTimestampError("Start must be a number.");
        return;
      }
      if (!(parsed < lesson.end)) {
        setTimestampError("Start must be less than end — change ignored.");
        return;
      }
      lessonBusyRef.current.add(lesson.id);
      setLessonBusyIds(new Set(lessonBusyRef.current));
      try {
        const updated = await updateLesson(lesson.id, { start: parsed });
        setLessons((prev) => prev.map((l) => (l.id === lesson.id ? updated : l)));
        setTimestampError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        lessonBusyRef.current.delete(lesson.id);
        setLessonBusyIds(new Set(lessonBusyRef.current));
      }
    },
    [startDrafts],
  );

  const commitEnd = useCallback(
    async (lesson: Lesson) => {
      // See commitStart's comment: check busy state before touching the
      // draft so a fast-follow edit isn't silently dropped.
      if (lessonBusyRef.current.has(lesson.id)) {
        setTimestampError("Still saving the previous change — try again in a moment.");
        return;
      }
      const draft = endDrafts[lesson.id];
      setEndDrafts((prev) => {
        if (!(lesson.id in prev)) return prev;
        const next = { ...prev };
        delete next[lesson.id];
        return next;
      });
      if (draft === undefined) return;
      const parsed = Number(draft);
      if (!Number.isFinite(parsed)) {
        setTimestampError("End must be a number.");
        return;
      }
      if (!(parsed > lesson.start)) {
        setTimestampError("End must be greater than start — change ignored.");
        return;
      }
      lessonBusyRef.current.add(lesson.id);
      setLessonBusyIds(new Set(lessonBusyRef.current));
      try {
        const updated = await updateLesson(lesson.id, { end: parsed });
        setLessons((prev) => prev.map((l) => (l.id === lesson.id ? updated : l)));
        setTimestampError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        lessonBusyRef.current.delete(lesson.id);
        setLessonBusyIds(new Set(lessonBusyRef.current));
      }
    },
    [endDrafts],
  );

  const handleTrimStart = useCallback(
    async (lesson: Lesson) => {
      if (lessonBusyRef.current.has(lesson.id)) return;
      if (!(currentTime < lesson.end)) {
        setTimestampError("Trim Start must land before the lesson's end — change ignored.");
        return;
      }
      lessonBusyRef.current.add(lesson.id);
      setLessonBusyIds(new Set(lessonBusyRef.current));
      try {
        const updated = await updateLesson(lesson.id, { start: currentTime });
        setLessons((prev) => prev.map((l) => (l.id === lesson.id ? updated : l)));
        setStartDrafts((prev) => {
          if (!(lesson.id in prev)) return prev;
          const next = { ...prev };
          delete next[lesson.id];
          return next;
        });
        setTimestampError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        lessonBusyRef.current.delete(lesson.id);
        setLessonBusyIds(new Set(lessonBusyRef.current));
      }
    },
    [currentTime],
  );

  const handleTrimEnd = useCallback(
    async (lesson: Lesson) => {
      if (lessonBusyRef.current.has(lesson.id)) return;
      if (!(currentTime > lesson.start)) {
        setTimestampError("Trim End must land after the lesson's start — change ignored.");
        return;
      }
      lessonBusyRef.current.add(lesson.id);
      setLessonBusyIds(new Set(lessonBusyRef.current));
      try {
        const updated = await updateLesson(lesson.id, { end: currentTime });
        setLessons((prev) => prev.map((l) => (l.id === lesson.id ? updated : l)));
        setEndDrafts((prev) => {
          if (!(lesson.id in prev)) return prev;
          const next = { ...prev };
          delete next[lesson.id];
          return next;
        });
        setTimestampError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        lessonBusyRef.current.delete(lesson.id);
        setLessonBusyIds(new Set(lessonBusyRef.current));
      }
    },
    [currentTime],
  );

  // ---------------------------------------------------------------------
  // Lesson preview — loop-plays `[start, end)`. Available in both modes.
  // `seekTo` (used here) is defined above, alongside the transcript
  // segment click-to-seek handler that already used it.
  // ---------------------------------------------------------------------

  const handleTogglePreview = useCallback((lesson: Lesson) => {
    const video = videoRef.current;
    if (previewingLessonRef.current === lesson.id) {
      video?.pause();
      setPreviewingLessonId(null);
      return;
    }
    setPreviewingLessonId(lesson.id);
    seekTo(lesson.start);
    void video?.play();
  }, []);

  // Timestamp Mode keyboard shortcuts (PRD §8.2). Scoped to when Timestamp
  // Mode is active and focus isn't inside a text input/textarea (so this
  // doesn't interfere with typing in the start/end fields or lesson rename
  // fields). Listener is added/removed whenever `mode` changes and on
  // unmount.
  useEffect(() => {
    if (mode !== "timestamp") return;

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      // Text-entry fields (start/end inputs, rename fields) should keep
      // normal typing behavior. The range-input scrubber is deliberately
      // NOT excluded here even though it's also an <input>: clicking it
      // gives it focus, and without this carve-out its native arrow-key
      // stepping (and space) would silently shadow these same shortcuts —
      // preventDefault below suppresses that native behavior so the app's
      // handler is the only thing that runs.
      if (target && target.tagName === "TEXTAREA") return;
      if (target && target.tagName === "INPUT" && (target as HTMLInputElement).type !== "range") {
        return;
      }
      const video = videoRef.current;
      if (!video) return;

      if (event.code === "Space") {
        event.preventDefault();
        if (video.paused) void video.play();
        else video.pause();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        const step = event.shiftKey ? BIG_STEP_SECONDS : FRAME_STEP_SECONDS;
        video.currentTime = Math.max(0, video.currentTime - step);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        const step = event.shiftKey ? BIG_STEP_SECONDS : FRAME_STEP_SECONDS;
        const max = video.duration || Infinity;
        video.currentTime = Math.min(max, video.currentTime + step);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mode]);

  const sortedLessons = useMemo(
    () => [...lessons].sort((a, b) => a.sort_order - b.sort_order),
    [lessons],
  );

  return (
    <div>
      <button type="button" className="back-button" onClick={onBack}>
        ← Back to project
      </button>

      {loading && <p>Loading editor…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !video && <p>Video not found.</p>}

      {video && (
        <>
          <h1>Lesson Editor</h1>
          <p className="video-path">{video.file_path}</p>

          <div className="mode-toggle" role="tablist" aria-label="Editor mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "transcript"}
              className={"mode-toggle-button" + (mode === "transcript" ? " mode-toggle-button-active" : "")}
              onClick={() => setMode("transcript")}
            >
              Transcript Mode
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "timestamp"}
              className={"mode-toggle-button" + (mode === "timestamp" ? " mode-toggle-button-active" : "")}
              onClick={() => setMode("timestamp")}
            >
              Timestamp Mode
            </button>
          </div>

          <video
            ref={videoRef}
            src={convertFileSrc(video.file_path)}
            controls
            className="editor-video"
            onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration || 0)}
            onTimeUpdate={(event) => {
              const time = event.currentTarget.currentTime;
              setCurrentTime(time);
              // Loop-back for lesson preview: if we've reached the
              // previewing lesson's `end`, seek back to its `start` and
              // keep playing rather than stopping.
              if (previewingLessonRef.current) {
                const previewLesson = lessons.find((l) => l.id === previewingLessonRef.current);
                if (previewLesson && time >= previewLesson.end) {
                  loopSeekRef.current = true;
                  event.currentTarget.currentTime = previewLesson.start;
                }
              }
            }}
            onSeeking={(event) => {
              // Ignore the seek we just triggered ourselves for loop-back.
              if (loopSeekRef.current) {
                loopSeekRef.current = false;
                return;
              }
              // Any other seek while previewing is a manual scrub; if it
              // lands outside the previewing lesson's range, stop forcing
              // playback back into range.
              if (previewingLessonRef.current) {
                const time = event.currentTarget.currentTime;
                const previewLesson = lessons.find((l) => l.id === previewingLessonRef.current);
                if (previewLesson && (time < previewLesson.start || time > previewLesson.end)) {
                  setPreviewingLessonId(null);
                }
              }
            }}
            onPause={() => {
              // The loop-back above never calls `pause()` itself, so any
              // pause event during a preview is a manual pause — exit
              // preview mode rather than keep re-seeking a paused video.
              if (previewingLessonRef.current) setPreviewingLessonId(null);
            }}
          />

          <div className="editor-layout">
            {mode === "transcript" ? (
              <section className="editor-panel">
                <h2>Transcript</h2>
                <input
                  type="search"
                  className="transcript-search-input"
                  placeholder="Search transcript…"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  aria-label="Search transcript"
                />
                {filteredSegments.length === 0 ? (
                  <p>No matching transcript segments.</p>
                ) : (
                  <ul className="transcript-segment-list editor-transcript-list">
                    {filteredSegments.map((segment) => {
                      const isActive = currentTime >= segment.start && currentTime < segment.end;
                      const isBusy = segmentBusyIds.has(segment.id);
                      return (
                        <li
                          key={segment.id}
                          className={
                            "transcript-segment editor-transcript-segment" +
                            (segment.keep ? "" : " transcript-segment-deleted") +
                            (isActive ? " transcript-segment-active" : "")
                          }
                        >
                          <span className="transcript-segment-time">
                            {formatDuration(segment.start)}–{formatDuration(segment.end)}
                          </span>
                          <button
                            type="button"
                            className="transcript-segment-text-button"
                            onClick={() => seekTo(segment.start)}
                          >
                            {segment.text}
                          </button>
                          <label className="transcript-segment-keep">
                            <input
                              type="checkbox"
                              checked={segment.keep}
                              disabled={isBusy}
                              onChange={() => void handleToggleKeep(segment)}
                            />
                            Keep
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ) : (
              <section className="editor-panel timestamp-panel">
                <h2>Timestamp Mode</h2>
                <p className="timestamp-note">
                  Fallback precision editor (PRD §8.2) — select a lesson in the list to trim or split it
                  by exact time. "Frame" stepping below approximates 1/30s; this build doesn't probe the
                  video's true frame rate.
                </p>
                {(() => {
                  const selectedLesson = lessons.find((l) => l.id === selectedLessonId) ?? null;
                  if (!selectedLesson) {
                    return <p>Select a lesson from the list to edit its timestamps.</p>;
                  }
                  const isBusy = lessonBusyIds.has(selectedLesson.id);
                  const canSplitSelected =
                    !isBusy && currentTime > selectedLesson.start && currentTime < selectedLesson.end;
                  return (
                    <div className="timestamp-editor">
                      <p className="timestamp-selected-title">{selectedLesson.title}</p>
                      <div className="timestamp-fields">
                        <label className="timestamp-field">
                          Start (s)
                          <input
                            type="number"
                            step="0.01"
                            disabled={isBusy}
                            value={startDrafts[selectedLesson.id] ?? selectedLesson.start.toFixed(2)}
                            onChange={(event) =>
                              setStartDrafts((prev) => ({ ...prev, [selectedLesson.id]: event.target.value }))
                            }
                            onBlur={() => void commitStart(selectedLesson)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur();
                            }}
                            aria-label={`Start time for lesson ${selectedLesson.title}`}
                          />
                        </label>
                        <label className="timestamp-field">
                          End (s)
                          <input
                            type="number"
                            step="0.01"
                            disabled={isBusy}
                            value={endDrafts[selectedLesson.id] ?? selectedLesson.end.toFixed(2)}
                            onChange={(event) =>
                              setEndDrafts((prev) => ({ ...prev, [selectedLesson.id]: event.target.value }))
                            }
                            onBlur={() => void commitEnd(selectedLesson)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur();
                            }}
                            aria-label={`End time for lesson ${selectedLesson.title}`}
                          />
                        </label>
                      </div>
                      {timestampError && <p className="error timestamp-error">{timestampError}</p>}

                      <div className="timestamp-actions">
                        <button type="button" disabled={isBusy} onClick={() => void handleTrimStart(selectedLesson)}>
                          Trim Start
                        </button>
                        <button type="button" disabled={isBusy} onClick={() => void handleTrimEnd(selectedLesson)}>
                          Trim End
                        </button>
                        <button
                          type="button"
                          disabled={!canSplitSelected}
                          onClick={() => void handleSplit(selectedLesson)}
                        >
                          Split at playhead
                        </button>
                      </div>

                      <input
                        type="range"
                        className="timestamp-scrubber"
                        min={0}
                        max={videoDuration || 0}
                        step={FRAME_STEP_SECONDS}
                        value={Math.min(currentTime, videoDuration || currentTime)}
                        onChange={(event) => seekTo(Number(event.target.value))}
                        aria-label="Scrub video"
                      />

                      <p className="timestamp-hint">
                        Space: play/pause · ←/→: step ~1 frame (1/30s) · Shift+←/→: step 1s
                      </p>
                    </div>
                  );
                })()}
              </section>
            )}

            <section className="editor-panel">
              <div className="undo-redo-bar">
                <button type="button" onClick={() => void handleUndo()} disabled={undoStack.length === 0}>
                  Undo
                </button>
                <button type="button" onClick={() => void handleRedo()} disabled={redoStack.length === 0}>
                  Redo
                </button>
                <span className="undo-note">Undo covers keep/delete toggles and renames only.</span>
              </div>

              <h2>Lessons</h2>
              {sortedLessons.length > 0 && (
                <div className="export-controls">
                  <button
                    type="button"
                    disabled={exporting || selectedForExport.size === 0}
                    onClick={() => void handleExport([...selectedForExport])}
                  >
                    Export selected ({selectedForExport.size})
                  </button>
                  <button
                    type="button"
                    disabled={exporting}
                    onClick={() => void handleExport(sortedLessons.map((lesson) => lesson.id))}
                  >
                    Export all lessons
                  </button>
                  {exporting && <span className="import-status">Queuing export…</span>}
                </div>
              )}
              {exportError && <p className="error">{exportError}</p>}
              {sortedLessons.length === 0 ? (
                <p>No lessons yet — analyze this video's transcript first.</p>
              ) : (
                <ul className="lesson-list editor-lesson-list">
                  {sortedLessons.map((lesson, index) => {
                    const isBusy = lessonBusyIds.has(lesson.id);
                    const canSplit =
                      !isBusy && currentTime > lesson.start && currentTime < lesson.end;
                    const next = sortedLessons[index + 1];
                    const isSelected = selectedLessonId === lesson.id;
                    const isPreviewing = previewingLessonId === lesson.id;
                    return (
                      <li
                        key={lesson.id}
                        className={
                          "lesson-item editor-lesson-item" +
                          (isSelected ? " editor-lesson-item-selected" : "")
                        }
                        onClick={() => setSelectedLessonId(lesson.id)}
                      >
                        <div className="lesson-item-header">
                          <input
                            type="checkbox"
                            className="lesson-export-checkbox"
                            checked={selectedForExport.has(lesson.id)}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => toggleExportSelection(lesson.id)}
                            aria-label={`Select lesson ${lesson.title} for export`}
                          />
                          <input
                            type="text"
                            className="lesson-title-input"
                            value={titleDrafts[lesson.id] ?? lesson.title}
                            disabled={isBusy}
                            onChange={(event) =>
                              setTitleDrafts((prev) => ({ ...prev, [lesson.id]: event.target.value }))
                            }
                            onBlur={() => void commitTitle(lesson)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur();
                            }}
                            aria-label={`Rename lesson ${lesson.title}`}
                          />
                          <span className={`kind-badge kind-${lesson.kind}`}>{lesson.kind}</span>
                          {lesson.confidence !== null && (
                            <span className="confidence-badge">
                              {Math.round(lesson.confidence * 100)}% confidence
                            </span>
                          )}
                          <span className="lesson-item-time">
                            {formatDuration(lesson.start)}–{formatDuration(lesson.end)}
                          </span>
                        </div>

                        <textarea
                          className="lesson-summary-input"
                          value={summaryDrafts[lesson.id] ?? lesson.summary ?? ""}
                          disabled={isBusy}
                          onChange={(event) =>
                            setSummaryDrafts((prev) => ({ ...prev, [lesson.id]: event.target.value }))
                          }
                          onBlur={() => void commitSummary(lesson)}
                          placeholder="Summary…"
                          rows={2}
                          aria-label={`Summary for lesson ${lesson.title}`}
                        />

                        <div className="lesson-item-actions">
                          <button type="button" onClick={() => handleTogglePreview(lesson)}>
                            {isPreviewing ? "Stop Preview" : "Preview"}
                          </button>
                          <button
                            type="button"
                            disabled={exporting}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleExport([lesson.id]);
                            }}
                          >
                            Export
                          </button>
                          <button
                            type="button"
                            disabled={!canSplit}
                            onClick={() => void handleSplit(lesson)}
                          >
                            Split at playhead
                          </button>
                          {next && (
                            <button
                              type="button"
                              disabled={isBusy || lessonBusyIds.has(next.id)}
                              onClick={() => void handleMergeWithNext(lesson, next)}
                            >
                              Merge with next
                            </button>
                          )}
                          <button
                            type="button"
                            className="delete-button"
                            disabled={isBusy}
                            onClick={() => void handleDeleteLesson(lesson)}
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {exports.length > 0 && (
                <div className="export-panel">
                  <h2>Export queue</h2>
                  <ul className="export-list">
                    {exports.map((row) => {
                      const lesson = lessons.find((candidate) => candidate.id === row.lesson_id);
                      const isBusy = exportBusyIds.has(row.id);
                      return (
                        <li key={row.id} className="export-item">
                          <div className="export-item-header">
                            <span className="export-item-title">{lesson?.title ?? row.lesson_id}</span>
                            <span className={`status-badge export-status-badge status-${row.status}`}>
                              {row.status}
                            </span>
                          </div>
                          {(row.status === "running" || row.status === "queued") && (
                            <div className="export-progress">
                              <progress value={row.progress} max={1} />
                              <span className="export-progress-label">
                                {Math.round(row.progress * 100)}%
                              </span>
                            </div>
                          )}
                          {row.error && <p className="error export-error">{row.error}</p>}
                          <div className="export-item-actions">
                            {row.status === "queued" && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleExportAction(row.id, pauseExport)}
                              >
                                Pause
                              </button>
                            )}
                            {row.status === "paused" && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleExportAction(row.id, resumeExport)}
                              >
                                Resume
                              </button>
                            )}
                            {(row.status === "queued" ||
                              row.status === "paused" ||
                              row.status === "running") && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleExportAction(row.id, cancelExport)}
                              >
                                Cancel
                              </button>
                            )}
                            {(row.status === "failed" || row.status === "cancelled") && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleExportAction(row.id, retryExport)}
                              >
                                Retry
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
