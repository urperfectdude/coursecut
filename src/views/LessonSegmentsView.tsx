import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import Breadcrumbs from "../components/Breadcrumbs";
import LessonPreviewPlayer from "../components/LessonPreviewPlayer";
import { basename } from "./ProjectDetailView";
import {
  deleteLessonSegment,
  getProject,
  getVideo,
  listLessonSegments,
  listLessons,
  queueExport,
  reorderLessonSegments,
  splitLesson,
  updateLesson,
  updateLessonSegment,
  type Lesson,
  type LessonSegment,
  type Project,
  type Video,
} from "../db";

/** Seconds → `m:ss` / `h:mm:ss` — duplicated per-file rather than shared,
 * same convention as `LessonCard`'s and `SourceVideoPreview`'s own copies. */
function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${m}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : mmss;
}

interface LessonSegmentsViewProps {
  projectId: string;
  videoId: string;
  lessonId: string;
  onNavigateHome: () => void;
  onNavigateProject: () => void;
  onNavigateTranscript: () => void;
  // Also this stage's "go back" affordance (via the "Lessons" breadcrumb) —
  // and where a segment delete that takes the whole lesson down with it
  // sends the user, since there's nothing left here to edit.
  onNavigateLessons: () => void;
}

/** A single lesson's own segment-editing page — split out of `LessonCard`
 * (see the conversation that led here) because expanding that editing UI
 * inline in the lesson grid meant breaking the card out to the full grid
 * row width, which read as broken/ugly. This page is a fresh mount per
 * visit (no state shared with the grid view), so every mutation here just
 * refetches this lesson's own segments locally — nothing needs to reach
 * back into `LessonEditorView`'s state. */
export default function LessonSegmentsView({
  projectId,
  videoId,
  lessonId,
  onNavigateHome,
  onNavigateProject,
  onNavigateTranscript,
  onNavigateLessons,
}: LessonSegmentsViewProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [video, setVideo] = useState<Video | null>(null);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [segments, setSegments] = useState<LessonSegment[]>([]);
  const [segmentsLoading, setSegmentsLoading] = useState(false);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);

  // The lesson's summary is only editable here now (not on the grid
  // tile) — same draft-then-commit-on-blur pattern used for the segment
  // start/end fields below, just a single field rather than one per row.
  const [summaryDraft, setSummaryDraft] = useState<string | undefined>(undefined);
  const [summaryBusy, setSummaryBusy] = useState(false);

  // Real (source-file) current time, mirrored up from `LessonPreviewPlayer`
  // — used for "at playhead" trim/split, which operate on the real time,
  // not that component's own virtual stitched-timeline one.
  const [currentTime, setCurrentTime] = useState(0);

  // Draft values for the per-segment start/end numeric inputs, keyed by
  // segment id — same draft-then-commit-on-blur pattern as the summary
  // field above (and the lesson title on the grid tile).
  const [startDrafts, setStartDrafts] = useState<Record<string, string>>({});
  const [endDrafts, setEndDrafts] = useState<Record<string, string>>({});

  // Per-segment in-flight guard, same defensive pattern as
  // `LessonEditorView`'s busy-id sets.
  const [segmentBusyIds, setSegmentBusyIds] = useState<Set<string>>(new Set());

  // Queuing this lesson's own export — same folder-picker-then-queue flow
  // as `LessonEditorView`'s per-lesson Export button; viewing/managing the
  // queue itself (progress, pause/resume/cancel/retry) lives entirely in
  // `ExportHistoryView`.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getProject(projectId), getVideo(videoId), listLessons(videoId)])
      .then(([projectRow, videoRow, lessonRows]) => {
        if (cancelled) return;
        setProject(projectRow);
        setVideo(videoRow);
        setLesson(lessonRows.find((row) => row.id === lessonId) ?? null);
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
  }, [projectId, videoId, lessonId]);

  const fetchSegments = useCallback(async () => {
    setSegmentsLoading(true);
    setSegmentsError(null);
    try {
      setSegments(await listLessonSegments(lessonId));
    } catch (err) {
      setSegmentsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSegmentsLoading(false);
    }
  }, [lessonId]);

  useEffect(() => {
    void fetchSegments();
  }, [fetchSegments]);

  const commitSummary = useCallback(async () => {
    if (!lesson || summaryBusy) return;
    if (summaryDraft === undefined) return;
    const trimmed = summaryDraft.trim();
    setSummaryDraft(undefined);
    if (trimmed === (lesson.summary ?? "")) return;
    setSummaryBusy(true);
    try {
      setLesson(await updateLesson(lesson.id, { summary: trimmed }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSummaryBusy(false);
    }
  }, [lesson, summaryDraft, summaryBusy]);

  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExportError(null);
    try {
      const dir = await open({ directory: true });
      if (!dir || typeof dir !== "string") return;
      setExporting(true);
      await queueExport([lessonId], dir);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [exporting, lessonId]);

  const commitSegmentStart = useCallback(
    async (segment: LessonSegment) => {
      if (segmentBusyIds.has(segment.id)) {
        setSegmentsError("Still saving the previous change — try again in a moment.");
        return;
      }
      const draft = startDrafts[segment.id];
      setStartDrafts((prev) => {
        if (!(segment.id in prev)) return prev;
        const next = { ...prev };
        delete next[segment.id];
        return next;
      });
      if (draft === undefined) return;
      const parsed = Number(draft);
      if (!Number.isFinite(parsed)) {
        setSegmentsError("Start must be a number.");
        return;
      }
      if (!(parsed < segment.end)) {
        setSegmentsError("Start must be less than end — change ignored.");
        return;
      }
      setSegmentBusyIds((prev) => new Set(prev).add(segment.id));
      try {
        await updateLessonSegment(segment.id, parsed, segment.end);
        await fetchSegments();
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(segment.id);
          return next;
        });
      }
    },
    [startDrafts, segmentBusyIds, fetchSegments],
  );

  const commitSegmentEnd = useCallback(
    async (segment: LessonSegment) => {
      if (segmentBusyIds.has(segment.id)) {
        setSegmentsError("Still saving the previous change — try again in a moment.");
        return;
      }
      const draft = endDrafts[segment.id];
      setEndDrafts((prev) => {
        if (!(segment.id in prev)) return prev;
        const next = { ...prev };
        delete next[segment.id];
        return next;
      });
      if (draft === undefined) return;
      const parsed = Number(draft);
      if (!Number.isFinite(parsed)) {
        setSegmentsError("End must be a number.");
        return;
      }
      if (!(parsed > segment.start)) {
        setSegmentsError("End must be greater than start — change ignored.");
        return;
      }
      setSegmentBusyIds((prev) => new Set(prev).add(segment.id));
      try {
        await updateLessonSegment(segment.id, segment.start, parsed);
        await fetchSegments();
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(segment.id);
          return next;
        });
      }
    },
    [endDrafts, segmentBusyIds, fetchSegments],
  );

  const handleTrimSegmentStart = useCallback(
    async (segment: LessonSegment) => {
      if (segmentBusyIds.has(segment.id)) return;
      if (!(currentTime < segment.end)) {
        setSegmentsError("Trim Start must land before the segment's end — change ignored.");
        return;
      }
      setSegmentBusyIds((prev) => new Set(prev).add(segment.id));
      try {
        await updateLessonSegment(segment.id, currentTime, segment.end);
        await fetchSegments();
        setStartDrafts((prev) => {
          if (!(segment.id in prev)) return prev;
          const next = { ...prev };
          delete next[segment.id];
          return next;
        });
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(segment.id);
          return next;
        });
      }
    },
    [currentTime, segmentBusyIds, fetchSegments],
  );

  const handleTrimSegmentEnd = useCallback(
    async (segment: LessonSegment) => {
      if (segmentBusyIds.has(segment.id)) return;
      if (!(currentTime > segment.start)) {
        setSegmentsError("Trim End must land after the segment's start — change ignored.");
        return;
      }
      setSegmentBusyIds((prev) => new Set(prev).add(segment.id));
      try {
        await updateLessonSegment(segment.id, segment.start, currentTime);
        await fetchSegments();
        setEndDrafts((prev) => {
          if (!(segment.id in prev)) return prev;
          const next = { ...prev };
          delete next[segment.id];
          return next;
        });
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(segment.id);
          return next;
        });
      }
    },
    [currentTime, segmentBusyIds, fetchSegments],
  );

  const handleDeleteSegment = useCallback(
    async (segment: LessonSegment) => {
      if (segmentBusyIds.has(segment.id)) return;
      if (!window.confirm("Delete this segment? This cannot be undone.")) return;
      setSegmentBusyIds((prev) => new Set(prev).add(segment.id));
      try {
        const result = await deleteLessonSegment(segment.id);
        if (result.lesson_deleted) {
          // The lesson itself no longer exists — nothing left to edit here.
          onNavigateLessons();
          return;
        }
        await fetchSegments();
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(segment.id);
          return next;
        });
      }
    },
    [segmentBusyIds, fetchSegments, onNavigateLessons],
  );

  // Swaps `segments[index]` with its neighbor at `index + direction` (-1 =
  // up/earlier, +1 = down/later) — playback order only, doesn't touch any
  // segment's own start/end. Busy-guards on both ids involved, same
  // in-flight-guard convention as the other segment mutations here.
  const handleMoveSegment = useCallback(
    async (index: number, direction: -1 | 1) => {
      const other = index + direction;
      if (other < 0 || other >= segments.length) return;
      const a = segments[index];
      const b = segments[other];
      if (segmentBusyIds.has(a.id) || segmentBusyIds.has(b.id)) return;
      setSegmentBusyIds((prev) => new Set(prev).add(a.id).add(b.id));
      try {
        const reordered = [...segments];
        reordered[index] = b;
        reordered[other] = a;
        await reorderLessonSegments(
          lessonId,
          reordered.map((segment) => segment.id),
        );
        await fetchSegments();
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(a.id);
          next.delete(b.id);
          return next;
        });
      }
    },
    [segments, segmentBusyIds, lessonId, fetchSegments],
  );

  const handleSplitSegment = useCallback(
    async (segment: LessonSegment) => {
      try {
        await splitLesson(lessonId, segment.id, currentTime);
        await fetchSegments();
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      }
    },
    [lessonId, currentTime, fetchSegments],
  );

  return (
    <div>
      <Breadcrumbs
        crumbs={[
          { label: "Projects", onClick: onNavigateHome },
          ...(project ? [{ label: project.name, onClick: onNavigateProject }] : []),
          ...(video ? [{ label: basename(video.file_path), onClick: onNavigateTranscript }] : []),
          { label: "Lessons", onClick: onNavigateLessons },
          { label: lesson?.title ?? "Lesson" },
        ]}
      />

      {loading && <p>Loading lesson…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && (!video || !lesson) && (
        <p>
          Lesson not found —{" "}
          <button type="button" className="link-button" onClick={onNavigateLessons}>
            back to lessons
          </button>
          .
        </p>
      )}

      {video && lesson && (
        <>
          <div className="project-header">
            <h1>{lesson.title}</h1>
            <div className="project-header-actions">
              <button
                type="button"
                className="export-history-button"
                disabled={exporting}
                onClick={() => void handleExport()}
              >
                {exporting ? "Queuing export…" : "Export"}
              </button>
            </div>
          </div>
          {exportError && <p className="error">{exportError}</p>}
          <textarea
            className="lesson-summary-input lesson-segments-summary"
            value={summaryDraft ?? lesson.summary ?? ""}
            disabled={summaryBusy}
            onChange={(event) => setSummaryDraft(event.target.value)}
            onBlur={() => void commitSummary()}
            placeholder="Summary…"
            rows={3}
            aria-label={`Summary for lesson ${lesson.title}`}
          />
          <p className="lesson-item-time">
            {formatDuration(lesson.start)}–{formatDuration(lesson.end)}
          </p>

          <div className="lesson-card-preview lesson-segments-preview">
            <LessonPreviewPlayer
              videoFilePath={video.file_path}
              segments={segments}
              lessonTitle={lesson.title}
              onTimeUpdate={setCurrentTime}
            />
            {segmentsLoading && <p>Loading segments…</p>}
            {segmentsError && <p className="error">{segmentsError}</p>}
          </div>

          <ul className="lesson-card-segment-list">
            {segments.map((segment, index) => {
              const isSegmentBusy = segmentBusyIds.has(segment.id);
              const canSplitSegment = currentTime > segment.start && currentTime < segment.end;
              return (
                <li key={segment.id} className="lesson-card-segment-row">
                  <div className="lesson-card-segment-order">
                    <span className="lesson-card-segment-order-index">{index + 1}</span>
                    <button
                      type="button"
                      disabled={isSegmentBusy || index === 0}
                      onClick={() => void handleMoveSegment(index, -1)}
                      aria-label="Move segment earlier"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      disabled={isSegmentBusy || index === segments.length - 1}
                      onClick={() => void handleMoveSegment(index, 1)}
                      aria-label="Move segment later"
                    >
                      ▼
                    </button>
                  </div>
                  <label className="lesson-card-segment-field">
                    Start (s) <span className="lesson-card-segment-time-hint">{formatDuration(segment.start)}</span>
                    <input
                      type="number"
                      step="0.01"
                      disabled={isSegmentBusy}
                      value={startDrafts[segment.id] ?? segment.start.toFixed(2)}
                      onChange={(event) =>
                        setStartDrafts((prev) => ({ ...prev, [segment.id]: event.target.value }))
                      }
                      onBlur={() => void commitSegmentStart(segment)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      aria-label={`Start time for segment ${segment.id}`}
                    />
                  </label>
                  <label className="lesson-card-segment-field">
                    End (s) <span className="lesson-card-segment-time-hint">{formatDuration(segment.end)}</span>
                    <input
                      type="number"
                      step="0.01"
                      disabled={isSegmentBusy}
                      value={endDrafts[segment.id] ?? segment.end.toFixed(2)}
                      onChange={(event) =>
                        setEndDrafts((prev) => ({ ...prev, [segment.id]: event.target.value }))
                      }
                      onBlur={() => void commitSegmentEnd(segment)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      aria-label={`End time for segment ${segment.id}`}
                    />
                  </label>
                  <div className="lesson-card-segment-actions">
                    <button
                      type="button"
                      disabled={isSegmentBusy}
                      onClick={() => void handleTrimSegmentStart(segment)}
                    >
                      Trim Start
                    </button>
                    <button
                      type="button"
                      disabled={isSegmentBusy}
                      onClick={() => void handleTrimSegmentEnd(segment)}
                    >
                      Trim End
                    </button>
                    <button
                      type="button"
                      disabled={!canSplitSegment || isSegmentBusy}
                      onClick={() => void handleSplitSegment(segment)}
                    >
                      Split at playhead
                    </button>
                    <button
                      type="button"
                      className="delete-button"
                      disabled={isSegmentBusy}
                      onClick={() => void handleDeleteSegment(segment)}
                    >
                      Delete segment
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
