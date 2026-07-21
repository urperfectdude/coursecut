import { useCallback, useEffect, useMemo, useState } from "react";
import Breadcrumbs from "../components/Breadcrumbs";
import { basename } from "./ProjectDetailView";
import {
  analyzeVideo,
  getProject,
  getVideo,
  listLessons,
  listTranscriptSegments,
  updateTranscriptSegment,
  type Project,
  type TranscriptSegment,
  type Video,
  type VideoProgress,
} from "../db";
import { useVideoProgress } from "../hooks/useVideoProgress";

interface TranscriptStageViewProps {
  projectId: string;
  videoId: string;
  onNavigateHome: () => void;
  onNavigateProject: () => void;
  // Also reached by clicking "View lessons →" below for a video that was
  // already analyzed in a previous visit — see `hasLessons`.
  onOpenLessons: () => void;
}

/** One entry on the undo/redo stack — scoped to this stage's only editable
 * action, the transcript segment keep/delete toggle (renames live on the
 * lessons stage's own separate stack, see `LessonEditorView`). */
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

/** Friendly label for a `Stage` value (`src-tauri/src/progress.rs`).
 * Duplicated from `ProjectDetailView`'s row-level copy rather than shared —
 * that one is explicitly throwaway per M2's plan notes, and this is a
 * handful of lines. */
function stageLabel(stage: VideoProgress["stage"]): string {
  switch (stage) {
    case "ExtractingAudio":
      return "Extracting audio";
    case "Transcribing":
      return "Transcribing";
    case "Analyzing":
      return "Analyzing";
  }
}

/** Transcript stage (`docs/ux-overhaul-plan.md` Phase 3 / M3) — review the
 * transcript, mark segments to drop, then Analyze to advance to the lessons
 * stage. Reachable only once a video is transcribed (see
 * `ProjectDetailView`'s `canShowTranscript` gate on the row that opens this). */
export default function TranscriptStageView({
  projectId,
  videoId,
  onNavigateHome,
  onNavigateProject,
  onOpenLessons,
}: TranscriptStageViewProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [video, setVideo] = useState<Video | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Whether this video already has AI-suggested lessons from a previous
  // visit — gates the "View lessons →" button, which is how a user returns
  // to the lessons stage without re-running Analyze (the M3 accept
  // criterion: navigating back to transcript and forward again must not
  // re-analyze).
  const [hasLessons, setHasLessons] = useState(false);

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const { progress, clearProgress } = useVideoProgress();

  // Per-segment "in-flight" guard, same pattern as `LessonEditorView`'s
  // `segmentBusyRef`/`segmentBusyIds`.
  const [segmentBusyIds, setSegmentBusyIds] = useState<Set<string>>(new Set());

  const [undoStack, setUndoStack] = useState<UndoableAction[]>([]);
  const [redoStack, setRedoStack] = useState<UndoableAction[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getProject(projectId),
      getVideo(videoId),
      listTranscriptSegments(videoId),
      listLessons(videoId),
    ])
      .then(([projectRow, videoRow, segmentRows, lessonRows]) => {
        if (cancelled) return;
        setProject(projectRow);
        setVideo(videoRow);
        setSegments(segmentRows);
        setHasLessons(lessonRows.length > 0);
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

  const pushUndo = useCallback((action: UndoableAction) => {
    setUndoStack((prev) => [...prev, action]);
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

  async function applySegmentKeep(segmentId: string, keep: boolean) {
    const updated = await updateTranscriptSegment(segmentId, keep);
    setSegments((prev) => prev.map((segment) => (segment.id === segmentId ? updated : segment)));
  }

  const handleToggleKeep = useCallback(
    async (segment: TranscriptSegment) => {
      setSegmentBusyIds((prev) => {
        if (prev.has(segment.id)) return prev;
        return new Set(prev).add(segment.id);
      });
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
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(segment.id);
          return next;
        });
      }
    },
    [pushUndo],
  );

  const filteredSegments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return segments;
    return segments.filter((segment) => segment.text.toLowerCase().includes(query));
  }, [segments, searchQuery]);

  const handleAnalyze = useCallback(async () => {
    if (analyzing) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    // Analysis isn't part of the retry-counted extract/transcribe chain
    // (M2 scope), so it always reports as attempt 1, and always clears any
    // stale event left over from this video's extract/transcribe pass.
    clearProgress(videoId);
    try {
      await analyzeVideo(videoId, 1);
      onOpenLessons();
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }, [analyzing, videoId, clearProgress, onOpenLessons]);

  const videoProgress = progress[videoId];

  return (
    <div>
      <Breadcrumbs
        crumbs={[
          { label: "Projects", onClick: onNavigateHome },
          ...(project ? [{ label: project.name, onClick: onNavigateProject }] : []),
          ...(video ? [{ label: basename(video.file_path) }] : []),
          { label: "Transcript" },
        ]}
      />

      {loading && <p>Loading transcript…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !video && <p>Video not found.</p>}

      {video && (
        <>
          <h1>Transcript</h1>
          <p className="video-path">{video.file_path}</p>

          <div className="stage-actions">
            <button type="button" onClick={() => void handleAnalyze()} disabled={analyzing}>
              Analyze
            </button>
            {hasLessons && (
              <button type="button" onClick={onOpenLessons}>
                View lessons →
              </button>
            )}
            {analyzing && (
              <span className="video-progress">
                <span
                  className={
                    videoProgress?.fraction == null ? "video-progress-spinner" : "video-progress-bar"
                  }
                  aria-hidden="true"
                >
                  {videoProgress?.fraction != null && (
                    <span
                      className="video-progress-bar-fill"
                      style={{ width: `${Math.round(videoProgress.fraction * 100)}%` }}
                    />
                  )}
                </span>
                <span className="video-progress-label">
                  {videoProgress ? stageLabel(videoProgress.stage) : "Working…"}
                  {videoProgress?.detail && <> ({videoProgress.detail})</>}
                </span>
              </span>
            )}
          </div>
          {analyzeError && <p className="error">{analyzeError}</p>}

          <div className="undo-redo-bar">
            <button type="button" onClick={() => void handleUndo()} disabled={undoStack.length === 0}>
              Undo
            </button>
            <button type="button" onClick={() => void handleRedo()} disabled={redoStack.length === 0}>
              Redo
            </button>
            <span className="undo-note">Undo covers keep/delete toggles only.</span>
          </div>

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
                const isBusy = segmentBusyIds.has(segment.id);
                return (
                  <li
                    key={segment.id}
                    className={
                      "transcript-segment editor-transcript-segment" +
                      (segment.keep ? "" : " transcript-segment-deleted")
                    }
                  >
                    <span className="transcript-segment-time">
                      {formatDuration(segment.start)}–{formatDuration(segment.end)}
                    </span>
                    <span className="transcript-segment-text">{segment.text}</span>
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
        </>
      )}
    </div>
  );
}
