import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import Breadcrumbs from "../components/Breadcrumbs";
import CreateLessonModal from "../components/CreateLessonModal";
import LessonCard from "../components/LessonCard";
import SourceVideoPreview from "../components/SourceVideoPreview";
import { basename } from "./ProjectDetailView";
import {
  addLessonSegment,
  deleteLesson,
  getProject,
  getVideo,
  listLessonSegments,
  listLessons,
  mergeLessons,
  queueExport,
  updateLesson,
  type Lesson,
  type LessonSegment,
  type Project,
  type Video,
} from "../db";

/** Export statuses that mean "the worker (or the user) is still expected to
 * act on this row" — used by `ExportHistoryView` (PRD §11, Milestone 8) to
 * decide whether to keep polling `listExports`. Defined here (rather than
 * in `db.ts`) for historical reasons — this stage used to own an inline
 * export queue panel that needed the same set; that panel has since moved
 * to `ExportHistoryView` entirely (see the conversation that moved it),
 * but the constant stayed since `ExportHistoryView` already imports it
 * from here. */
export const ACTIVE_EXPORT_STATUSES = new Set(["queued", "paused", "running"]);

interface LessonEditorViewProps {
  projectId: string;
  videoId: string;
  onNavigateHome: () => void;
  onNavigateProject: () => void;
  // Also this stage's "go back" affordance — the video-name breadcrumb
  // always targets the transcript stage for this video (M3), and the
  // empty-lessons state below reuses it as its "go analyze" link.
  onNavigateTranscript: () => void;
  // Navigates to a lesson's own segment-editing page (`LessonSegmentsView`)
  // — see the conversation that moved segment editing off the grid tile.
  onOpenLessonSegments: (lessonId: string) => void;
  // Navigates to the project-level `ExportHistoryView` — this stage no
  // longer shows its own inline export queue panel at the bottom (see the
  // conversation that moved it here instead, top-right next to "+ Create
  // lesson").
  onOpenExportHistory: () => void;
}

/** One entry on the undo/redo stack — deliberately scoped to this stage's
 * only cheaply-reversible edit, lesson renames (keep/delete toggles have
 * their own separate stack, on the transcript stage — see
 * `TranscriptStageView`); see the note rendered near the Undo/Redo buttons. */
interface UndoableAction {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

export default function LessonEditorView({
  projectId,
  videoId,
  onNavigateHome,
  onNavigateProject,
  onNavigateTranscript,
  onOpenLessonSegments,
  onOpenExportHistory,
}: LessonEditorViewProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [video, setVideo] = useState<Video | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Which lesson is "selected" — targets it for `SourceVideoPreview`'s Mark
  // In/Out/Add Segment controls above the grid, and feeds that preview's
  // seek-bar highlight overlay via `selectedLessonSegments` below. No
  // longer doubles as expansion state — segment editing lives on its own
  // page now (`LessonSegmentsView`, opened via `onOpenLessonSegments`), not
  // inline in the grid tile (see `docs/lesson-segments-plan.md`).
  const [selectedLessonId, setSelectedLessonId] = useState<string | null>(null);
  const [selectedLessonSegments, setSelectedLessonSegments] = useState<LessonSegment[]>([]);

  // Bumped after any segment-affecting mutation centrally owned here (add-
  // segment from `SourceVideoPreview`'s mark in/out, merge), so that a
  // `LessonCard`'s own locally-cached preview segments, and
  // `selectedLessonSegments` below (feeding `SourceVideoPreview`'s
  // overlay), know to refetch. Edits made on a lesson's own
  // `LessonSegmentsView` page don't need to bump this — that page is a
  // separate mount with no state shared back here, and this view refetches
  // everything fresh whenever the user navigates back to it.
  const [segmentsRefreshKey, setSegmentsRefreshKey] = useState(0);

  // Per-row "in-flight" guards (same defensive pattern as
  // `ProjectDetailView`'s `inFlightRef`/`inFlightIds`) — a rapid double
  // click on a lesson's Split/Merge/Delete/rename-commit shouldn't fire two
  // concurrent mutations against the same row.
  const lessonBusyRef = useRef<Set<string>>(new Set());
  const [lessonBusyIds, setLessonBusyIds] = useState<Set<string>>(new Set());

  // In-progress edits for the inline title field, keyed by lesson id — only
  // present while it differs from its last-committed value. Summary
  // editing lives on `LessonSegmentsView` now, not this grid tile.
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});

  // Undo/redo stack (see `UndoableAction` above for scope).
  const [undoStack, setUndoStack] = useState<UndoableAction[]>([]);
  const [redoStack, setRedoStack] = useState<UndoableAction[]>([]);

  // Queuing exports (PRD §10-11, Milestone 7). `selectedForExport` drives
  // the per-lesson checkboxes used by "Export selected". This stage only
  // ever queues new exports now — viewing/managing the queue (progress,
  // pause/resume/cancel/retry, re-export) lives entirely in
  // `ExportHistoryView` (see `onOpenExportHistory` above).
  const [selectedForExport, setSelectedForExport] = useState<Set<string>>(new Set());
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Create Lesson modal (M4) — a transcript segment picker, opened from the
  // top-right button. Owns its own segment fetch/checkbox state entirely
  // (see `CreateLessonModal`); this view just tracks whether it's open and
  // reacts to a successful create.
  const [showCreateLessonModal, setShowCreateLessonModal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getProject(projectId), getVideo(videoId), listLessons(videoId)])
      .then(([projectRow, videoRow, lessonRows]) => {
        if (cancelled) return;
        setProject(projectRow);
        setVideo(videoRow);
        setLessons(lessonRows);
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
  }, [projectId, videoId]);

  // If the selected lesson is deleted or merged away, drop the now-dangling
  // reference instead of pointing the overlay/selection at a lesson id that
  // no longer exists.
  useEffect(() => {
    if (selectedLessonId && !lessons.some((lesson) => lesson.id === selectedLessonId)) {
      setSelectedLessonId(null);
    }
  }, [lessons, selectedLessonId]);

  // Feeds `SourceVideoPreview`'s seek-bar highlight overlay with the
  // selected lesson's segments; re-fetched whenever the selection changes,
  // or a centrally-owned mutation (`segmentsRefreshKey`) may have changed
  // that lesson's segment list.
  useEffect(() => {
    if (!selectedLessonId) {
      setSelectedLessonSegments([]);
      return;
    }
    let cancelled = false;
    listLessonSegments(selectedLessonId)
      .then((rows) => {
        if (!cancelled) setSelectedLessonSegments(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedLessonId, segmentsRefreshKey]);

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
  // Lessons: rename (undoable), split/merge/delete (not undoable — see
  // `docs/PRD.md` §8.1 and the note rendered near the Undo button), and
  // adding a segment from `SourceVideoPreview`'s mark in/out controls.
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

  const handleMergeWithNext = useCallback(async (lesson: Lesson, next: Lesson) => {
    if (lessonBusyRef.current.has(lesson.id) || lessonBusyRef.current.has(next.id)) return;
    lessonBusyRef.current.add(lesson.id);
    lessonBusyRef.current.add(next.id);
    setLessonBusyIds(new Set(lessonBusyRef.current));
    try {
      await mergeLessons(lesson.id, next.id);
      await refreshLessons();
      setSegmentsRefreshKey((key) => key + 1);
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

  // Adds a segment `[start, end)` to whichever lesson is currently
  // selected — the target for `SourceVideoPreview`'s Mark In/Mark Out/Add
  // Segment controls. Rethrows on failure (after recording it in the
  // top-level `error` banner, same as every other mutation here) so
  // `SourceVideoPreview` knows not to clear the user's marks.
  const handleAddSegment = useCallback(
    async (start: number, end: number) => {
      if (!selectedLessonId) return;
      if (lessonBusyRef.current.has(selectedLessonId)) {
        throw new Error("Still saving a previous change to this lesson — try again in a moment.");
      }
      lessonBusyRef.current.add(selectedLessonId);
      setLessonBusyIds(new Set(lessonBusyRef.current));
      try {
        await addLessonSegment(selectedLessonId, start, end);
        await refreshLessons();
        setSegmentsRefreshKey((key) => key + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        lessonBusyRef.current.delete(selectedLessonId);
        setLessonBusyIds(new Set(lessonBusyRef.current));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedLessonId],
  );

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
      } catch (err) {
        setExportError(err instanceof Error ? err.message : String(err));
      } finally {
        setExporting(false);
      }
    },
    [exporting],
  );

  const sortedLessons = useMemo(
    () => [...lessons].sort((a, b) => a.sort_order - b.sort_order),
    [lessons],
  );

  return (
    <div>
      <Breadcrumbs
        crumbs={[
          { label: "Projects", onClick: onNavigateHome },
          ...(project ? [{ label: project.name, onClick: onNavigateProject }] : []),
          ...(video ? [{ label: basename(video.file_path), onClick: onNavigateTranscript }] : []),
          { label: "Lessons" },
        ]}
      />

      {loading && <p>Loading editor…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !video && <p>Video not found.</p>}

      {video && (
        <>
          <div className="project-header">
            <div>
              <h1>Lessons</h1>
              <p className="video-path">{video.file_path}</p>
            </div>
            <div className="project-header-actions">
              <button
                type="button"
                className="export-history-button"
                onClick={() => onOpenExportHistory()}
              >
                Exports
              </button>
              <button
                type="button"
                className="export-history-button"
                onClick={() => setShowCreateLessonModal(true)}
              >
                + Create lesson
              </button>
            </div>
          </div>

          <SourceVideoPreview
            filePath={video.file_path}
            selectedLessonSegments={selectedLessonSegments}
            hasSelectedLesson={selectedLessonId !== null}
            onTimeUpdate={() => {}}
            onAddSegment={handleAddSegment}
          />

          <section className="editor-panel">
            <div className="undo-redo-bar">
              <button type="button" onClick={() => void handleUndo()} disabled={undoStack.length === 0}>
                Undo
              </button>
              <button type="button" onClick={() => void handleRedo()} disabled={redoStack.length === 0}>
                Redo
              </button>
              <span className="undo-note">Undo covers lesson renames only.</span>
            </div>

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
              <p>
                No lessons yet —{" "}
                <button type="button" className="link-button" onClick={onNavigateTranscript}>
                  analyze this video's transcript
                </button>{" "}
                first.
              </p>
            ) : (
              <ul className="lesson-tile-grid">
                {sortedLessons.map((lesson, index) => {
                  const next = sortedLessons[index + 1] ?? null;
                  return (
                    <LessonCard
                      key={lesson.id}
                      lesson={lesson}
                      videoFilePath={video.file_path}
                      isSelected={selectedLessonId === lesson.id}
                      onSelect={(id) => setSelectedLessonId((prev) => (prev === id ? null : id))}
                      isBusy={lessonBusyIds.has(lesson.id)}
                      titleDraft={titleDrafts[lesson.id]}
                      onTitleDraftChange={(value) =>
                        setTitleDrafts((prev) => ({ ...prev, [lesson.id]: value }))
                      }
                      onCommitTitle={commitTitle}
                      onDelete={handleDeleteLesson}
                      next={next}
                      isNextBusy={next ? lessonBusyIds.has(next.id) : false}
                      onMergeWithNext={handleMergeWithNext}
                      onOpenSegments={(l) => onOpenLessonSegments(l.id)}
                      selectedForExport={selectedForExport.has(lesson.id)}
                      onToggleExportSelection={toggleExportSelection}
                      exporting={exporting}
                      onExport={handleExport}
                      segmentsRefreshKey={segmentsRefreshKey}
                    />
                  );
                })}
              </ul>
            )}
          </section>

          {showCreateLessonModal && (
            <CreateLessonModal
              videoId={videoId}
              onClose={() => setShowCreateLessonModal(false)}
              onCreated={() => {
                setShowCreateLessonModal(false);
                void refreshLessons();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
