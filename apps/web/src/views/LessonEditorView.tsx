// PORTED FROM: src/views/LessonEditorView.tsx @ 16d83e5
// DEVIATIONS: D5 — no output directory; the worker writes to object
// storage and Export History offers the download.
// One-way port — desktop is upstream. Don't edit this for web-only reasons;
// port the change to the desktop file first. See docs/web-app-plan.md §7.1,
// and re-run scripts/ui-drift.sh (which reads the SHA above) after syncing.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Breadcrumbs from "../components/Breadcrumbs";
import CreateLessonModal from "../components/CreateLessonModal";
import LessonCard from "../components/LessonCard";
import SourceVideoPreview from "../components/SourceVideoPreview";
import { basename } from "./ProjectDetailView";
import {
  deleteLesson,
  getProject,
  getVideo,
  listLessons,
  mergeLessons,
  pickExportDirectory,
  queueExport,
  type Lesson,
  type Project,
  type Video,
} from "../db";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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

  // Bumped after any segment-affecting mutation centrally owned here (merge)
  // so that a `LessonCard`'s own locally-cached preview segments know to
  // refetch. Edits made on a lesson's own `LessonSegmentsView` page (which
  // now also owns adding segments — see `onOpenLessonSegments`) don't need
  // to bump this — that page is a separate mount with no state shared back
  // here, and this view refetches everything fresh whenever the user
  // navigates back to it.
  const [segmentsRefreshKey, setSegmentsRefreshKey] = useState(0);

  // Per-row "in-flight" guards (same defensive pattern as
  // `ProjectDetailView`'s `inFlightRef`/`inFlightIds`) — a rapid double
  // click on a lesson's Split/Merge/Delete shouldn't fire two concurrent
  // mutations against the same row.
  const lessonBusyRef = useRef<Set<string>>(new Set());
  const [lessonBusyIds, setLessonBusyIds] = useState<Set<string>>(new Set());

  // Which lesson (if any) is pending Delete confirmation — a single piece of
  // state driving one shared `AlertDialog`, same pattern as `HomeView`'s
  // `pendingDelete` / `ProjectDetailView`'s `pendingRemove`.
  const [pendingDeleteLesson, setPendingDeleteLesson] = useState<Lesson | null>(null);

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

  // ---------------------------------------------------------------------
  // Lessons: split/merge/delete (see `docs/PRD.md` §8.1). Renaming and
  // adding segments both live on the lesson's own segments page
  // (`LessonSegmentsView`) now, not here.
  // ---------------------------------------------------------------------

  async function refreshLessons() {
    setLessons(await listLessons(videoId));
  }

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

  /** Opens the shared Delete confirmation dialog for `lesson` — the actual
   * delete happens in `handleConfirmDeleteLesson` once the user confirms. */
  const handleDeleteLesson = useCallback((lesson: Lesson) => {
    if (lessonBusyRef.current.has(lesson.id)) return;
    setPendingDeleteLesson(lesson);
  }, []);

  const handleConfirmDeleteLesson = useCallback(async () => {
    if (!pendingDeleteLesson) return;
    const lesson = pendingDeleteLesson;
    setPendingDeleteLesson(null);
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
  }, [pendingDeleteLesson]);

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
        // D5: resolves without prompting — there is no folder to pick.
        const dir = await pickExportDirectory();
        if (dir === null) return;
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
      {error && (
        <Alert variant="destructive" className="my-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!loading && !video && <p>Video not found.</p>}

      {video && (
        <>
          <div className="flex items-start justify-end gap-4">
            <div className="flex shrink-0 gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenExportHistory()}>
                Exports
              </Button>
              <Button type="button" variant="outline" onClick={() => setShowCreateLessonModal(true)}>
                + Create lesson
              </Button>
            </div>
          </div>

          <SourceVideoPreview filePath={video.file_path} onTimeUpdate={() => {}} />

          <section>
            {sortedLessons.length > 0 && (
              <div className="my-2 flex items-center justify-end gap-2">
                {exporting && <span className="text-sm text-muted-foreground">Queuing export…</span>}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={exporting}
                  onClick={() => void handleExport(sortedLessons.map((lesson) => lesson.id))}
                >
                  Export all lessons
                </Button>
                <Button
                  type="button"
                  disabled={exporting || selectedForExport.size === 0}
                  onClick={() => void handleExport([...selectedForExport])}
                >
                  Export selected ({selectedForExport.size})
                </Button>
              </div>
            )}
            {exportError && (
              <Alert variant="destructive" className="my-2">
                <AlertDescription>{exportError}</AlertDescription>
              </Alert>
            )}
            {sortedLessons.length === 0 ? (
              <p>
                No lessons yet —{" "}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 align-baseline"
                  onClick={onNavigateTranscript}
                >
                  analyze this video's transcript
                </Button>{" "}
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
                      isBusy={lessonBusyIds.has(lesson.id)}
                      onDelete={handleDeleteLesson}
                      next={next}
                      isNextBusy={next ? lessonBusyIds.has(next.id) : false}
                      onMergeWithNext={handleMergeWithNext}
                      onOpenSegments={(l) => onOpenLessonSegments(l.id)}
                      selectedForExport={selectedForExport.has(lesson.id)}
                      onToggleExportSelection={toggleExportSelection}
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

      <AlertDialog
        open={pendingDeleteLesson !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteLesson(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete lesson?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteLesson &&
                `Delete lesson "${pendingDeleteLesson.title}"? This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmDeleteLesson}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
