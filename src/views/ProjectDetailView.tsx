import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  analyzeVideo,
  deleteVideo,
  extractAudioForVideo,
  getProject,
  importVideos,
  listLessons,
  listTranscriptSegments,
  listVideos,
  SUPPORTED_VIDEO_EXTENSIONS,
  transcribeVideo,
  type Lesson,
  type Project,
  type TranscriptSegment,
  type Video,
} from "../db";

/** Statuses that mean "not yet transcribed" — anything else (transcribed,
 * and any later status future milestones add) can show the transcript
 * toggle. */
const PRE_TRANSCRIPT_STATUSES = new Set(["pending", "audio_ready", "error"]);

interface ProjectDetailViewProps {
  projectId: string;
  onBack: () => void;
  onOpenEditor: (videoId: string) => void;
  // Navigates to this project's Export History (PRD §11, Milestone 8).
  onOpenExportHistory: () => void;
}

/** Last path component, handling both `/` (macOS) and `\` (Windows).
 * Exported so `ExportHistoryView` (PRD §11, Milestone 8) can reuse it
 * instead of re-implementing path-splitting differently. */
export function basename(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index === -1 ? path : path.slice(index + 1);
}

/** Directory containing `path` (everything before the last path separator),
 * handling both `/` (macOS) and `\` (Windows) like `basename` above. Falls
 * back to `path` itself if it has no separator (shouldn't happen for a real
 * export output path, but keeps this safe to call standalone). Exported for
 * `ExportHistoryView`'s Re-export action, which needs the folder an export's
 * `output_path` lives in to re-queue into the same destination. */
export function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index === -1 ? path : path.slice(0, index);
}

/** Seconds → `m:ss` / `h:mm:ss`. Duration is probed later, so most rows
 * show the `--:--` placeholder for now. Exported so `ExportHistoryView`
 * (PRD §11, Milestone 8) can reuse it for lesson duration formatting. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "--:--";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${m}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : mmss;
}

export default function ProjectDetailView({
  projectId,
  onBack,
  onOpenEditor,
  onOpenExportHistory,
}: ProjectDetailViewProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-video errors (e.g. "no API key saved") shown near that video's row,
  // instead of the page-level `error` banner above — one bad video
  // shouldn't read as a whole-page failure.
  const [videoErrors, setVideoErrors] = useState<Record<string, string>>({});
  // Which video's transcript panel is expanded, plus its loaded segments —
  // only one at a time (read-only preview; editing arrives in a later
  // milestone).
  const [expandedVideoId, setExpandedVideoId] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [segmentsLoading, setSegmentsLoading] = useState(false);
  // Same "one at a time" pattern as the transcript panel above, for the
  // minimal lesson-suggestion review list (PRD §7.5) — this is a stand-in
  // surface, not the real Transcript/Timestamp Mode editor (later
  // milestones).
  const [expandedLessonsVideoId, setExpandedLessonsVideoId] = useState<string | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [lessonsLoading, setLessonsLoading] = useState(false);
  // Reject is a client-side-only filter for now (no `delete_lesson` backend
  // command exists yet — that's a later milestone), so rejected suggestions
  // are tracked here and simply excluded from the rendered list, not
  // persisted. Accept has nothing to persist (the row is already written by
  // `analyze_video`) — it's tracked here purely so the button can show a
  // visual confirmation.
  const [rejectedLessonIds, setRejectedLessonIds] = useState<Set<string>>(new Set());
  const [acceptedLessonIds, setAcceptedLessonIds] = useState<Set<string>>(new Set());
  // Mirrors `importing` for the drag-drop listener and button handlers,
  // which would otherwise close over a stale value — one import at a time.
  const importingRef = useRef(false);
  // Per-video "in-flight" guard: unlike `importingRef` (one batch at a
  // time), multiple videos can be extracting/transcribing concurrently
  // during a batch import, so this tracks individual video ids rather than
  // a single boolean. Guards against a second concurrent `processVideo`
  // run for the same video (e.g. a double Retry click, or Retry racing the
  // post-import pass) — two concurrent `transcribeVideo` calls on one video
  // can otherwise race and have a late failure clobber an earlier success's
  // committed transcript. `inFlightIds` mirrors the ref into state purely so
  // the Retry/Remove buttons re-render to reflect it.
  const inFlightRef = useRef<Set<string>>(new Set());
  const [inFlightIds, setInFlightIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getProject(projectId), listVideos(projectId)])
      .then(([projectRow, videoRows]) => {
        if (cancelled) return;
        setProject(projectRow);
        setVideos(videoRows);
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
  }, [projectId]);

  // Probes real duration + extracts local audio, then transcribes, for a
  // single video (see `src-tauri/src/ffmpeg.rs` and
  // `src-tauri/src/openai.rs`), resuming from wherever the video's current
  // row state says it left off: extraction is skipped if `audio_path` is
  // already set (Milestone 2's own cache would short-circuit it anyway,
  // but this also lets a Retry click skip straight to transcription when
  // only that step previously failed). Used both right after import and by
  // the per-video Retry button, so the two never duplicate this chaining
  // logic. The video list is refreshed at the end so the row's status
  // badge reflects the outcome.
  const processVideo = useCallback(
    async (video: Video) => {
      if (inFlightRef.current.has(video.id)) return;
      inFlightRef.current.add(video.id);
      setInFlightIds(new Set(inFlightRef.current));
      try {
        let current: Video | null = video;
        if (!current.audio_path) {
          try {
            current = await extractAudioForVideo(current.id);
          } catch (err) {
            // extract_audio_for_video already records `transcript_status =
            // 'error'` on the row (reflected via the listVideos() call
            // below) — surface the message too, but keep going so one bad
            // file doesn't stop the rest of an import batch.
            setError(err instanceof Error ? err.message : String(err));
            current = null;
          }
        }

        if (current?.audio_path) {
          try {
            await transcribeVideo(current.id);
          } catch (err) {
            // Most commonly "no API key saved" if the user hasn't visited
            // Settings yet — surface it against this video's row rather than
            // the page-level banner, and don't retry automatically.
            setVideoErrors((prev) => ({
              ...prev,
              [current!.id]: err instanceof Error ? err.message : String(err),
            }));
          }
        }

        setVideos(await listVideos(projectId));
      } finally {
        inFlightRef.current.delete(video.id);
        setInFlightIds(new Set(inFlightRef.current));
      }
    },
    [projectId],
  );

  const handleImport = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || importingRef.current) return;
      importingRef.current = true;
      setImporting(true);
      try {
        const added = await importVideos(projectId, paths);
        setImportMessage(
          added.length === 0
            ? "No new supported videos found."
            : `Imported ${added.length} video${added.length === 1 ? "" : "s"}.`,
        );
        setVideos(await listVideos(projectId));
        setError(null);

        // Sequential, not parallel — a folder import can add many videos
        // at once, and running them one at a time avoids piling up
        // concurrent ffmpeg processes or firing multiple Whisper calls
        // concurrently.
        for (const video of added) {
          await processVideo(video);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [projectId, processVideo],
  );

  /** Resumes the extract/transcribe pipeline for a video whose last attempt
   * ended in `transcript_status === "error"` — clears the stale per-video
   * error first so it doesn't linger next to a fresh attempt. */
  const handleRetry = useCallback(
    async (video: Video) => {
      setVideoErrors((prev) => {
        if (!(video.id in prev)) return prev;
        const next = { ...prev };
        delete next[video.id];
        return next;
      });
      await processVideo(video);
    },
    [processVideo],
  );

  /** Sends this video's transcript to GPT-5.5 for lesson-boundary analysis
   * (PRD §7.5) and opens the suggestion review panel with the result.
   * Shares `inFlightRef`/`inFlightIds` with `processVideo` (extraction +
   * transcription) rather than a second guard, so a video can't be
   * double-analyzed (or analyzed mid-transcription) any more than it can be
   * double-retried. */
  const handleAnalyze = useCallback(async (video: Video) => {
    if (inFlightRef.current.has(video.id)) return;
    inFlightRef.current.add(video.id);
    setInFlightIds(new Set(inFlightRef.current));
    setVideoErrors((prev) => {
      if (!(video.id in prev)) return prev;
      const next = { ...prev };
      delete next[video.id];
      return next;
    });
    try {
      const result = await analyzeVideo(video.id);
      setExpandedLessonsVideoId(video.id);
      setLessons(result);
      setRejectedLessonIds(new Set());
      setAcceptedLessonIds(new Set());
    } catch (err) {
      // Most commonly "no API key saved" or "no transcript yet" — surface
      // it against this video's row, same as extraction/transcription
      // errors.
      setVideoErrors((prev) => ({
        ...prev,
        [video.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      inFlightRef.current.delete(video.id);
      setInFlightIds(new Set(inFlightRef.current));
    }
  }, []);

  /** Toggles the lesson-suggestion review panel for a video, loading its
   * currently-stored lessons (mirrors `toggleTranscript` above) — lets
   * previously-analyzed suggestions be reviewed again without re-running
   * Analyze. */
  async function toggleLessons(videoId: string) {
    if (expandedLessonsVideoId === videoId) {
      setExpandedLessonsVideoId(null);
      setLessons([]);
      return;
    }
    setExpandedLessonsVideoId(videoId);
    setLessons([]);
    setRejectedLessonIds(new Set());
    setAcceptedLessonIds(new Set());
    setLessonsLoading(true);
    try {
      setLessons(await listLessons(videoId));
    } catch (err) {
      setVideoErrors((prev) => ({
        ...prev,
        [videoId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setLessonsLoading(false);
    }
  }

  /** Removes a video from the project entirely (distinct from Retry — this
   * deletes the row). Does not touch the cached extracted-audio WAV file,
   * since it's content-hash-keyed and may be shared with other videos. */
  const handleRemove = useCallback(
    async (video: Video) => {
      if (inFlightRef.current.has(video.id)) return;
      if (
        !window.confirm(
          `Remove "${basename(video.file_path)}" from this project? This cannot be undone.`,
        )
      ) {
        return;
      }
      try {
        await deleteVideo(video.id);
        setVideos(await listVideos(projectId));
        setVideoErrors((prev) => {
          if (!(video.id in prev)) return prev;
          const next = { ...prev };
          delete next[video.id];
          return next;
        });
        if (expandedVideoId === video.id) {
          setExpandedVideoId(null);
          setSegments([]);
        }
        if (expandedLessonsVideoId === video.id) {
          setExpandedLessonsVideoId(null);
          setLessons([]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [projectId, expandedVideoId, expandedLessonsVideoId],
  );

  // Tauri delivers OS drag & drop through the webview event, not DOM events.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragging(true);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          void handleImport(event.payload.paths);
        } else {
          setDragging(false);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleImport]);

  async function handleImportFiles() {
    try {
      const selection = await open({
        multiple: true,
        filters: [{ name: "Videos", extensions: SUPPORTED_VIDEO_EXTENSIONS }],
      });
      if (selection) await handleImport(selection);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleImportFolder() {
    try {
      const selection = await open({ directory: true });
      if (selection) await handleImport([selection]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Toggles the read-only transcript preview for a video row; clicking the
   * already-expanded video's toggle collapses it again. */
  async function toggleTranscript(videoId: string) {
    if (expandedVideoId === videoId) {
      setExpandedVideoId(null);
      setSegments([]);
      return;
    }
    setExpandedVideoId(videoId);
    setSegments([]);
    setSegmentsLoading(true);
    try {
      setSegments(await listTranscriptSegments(videoId));
    } catch (err) {
      setVideoErrors((prev) => ({
        ...prev,
        [videoId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setSegmentsLoading(false);
    }
  }

  return (
    <div>
      <button type="button" className="back-button" onClick={onBack}>
        ← Back to projects
      </button>

      {loading && <p>Loading project…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && !project && <p>Project not found.</p>}

      {project && (
        <>
          <div className="project-header">
            <div>
              <h1>{project.name}</h1>
              <p>
                Created {new Date(project.created_at).toLocaleString()} · Updated{" "}
                {new Date(project.updated_at).toLocaleString()}
              </p>
            </div>
            <button type="button" className="export-history-button" onClick={onOpenExportHistory}>
              Export History
            </button>
          </div>

          <div className="import-actions">
            <button type="button" onClick={handleImportFiles} disabled={importing}>
              Import videos
            </button>
            <button type="button" onClick={handleImportFolder} disabled={importing}>
              Import folder
            </button>
            {importing && <span className="import-status">Importing…</span>}
          </div>

          <div className={dragging ? "drop-zone drop-zone-active" : "drop-zone"}>
            {dragging ? "Drop to import" : "Or drag & drop video files or folders here"}
          </div>

          {importMessage && <p className="import-message">{importMessage}</p>}

          {videos.length === 0 ? (
            <p>No videos imported yet.</p>
          ) : (
            <ul className="video-list">
              {videos.map((video) => {
                const canShowTranscript = !PRE_TRANSCRIPT_STATUSES.has(video.transcript_status);
                const isExpanded = expandedVideoId === video.id;
                const isLessonsExpanded = expandedLessonsVideoId === video.id;
                const isInFlight = inFlightIds.has(video.id);
                return (
                  <li key={video.id} className="video-list-entry">
                    <div className="video-list-item">
                      <div className="video-info">
                        <span className="video-name">{basename(video.file_path)}</span>
                        <span className="video-path">{video.file_path}</span>
                      </div>
                      <span className="video-duration">{formatDuration(video.duration)}</span>
                      <span className={`status-badge status-${video.transcript_status}`}>
                        {video.transcript_status}
                      </span>
                      {canShowTranscript && (
                        <button
                          type="button"
                          className="transcript-toggle"
                          onClick={() => void toggleTranscript(video.id)}
                        >
                          {isExpanded ? "Hide transcript" : "View transcript"}
                        </button>
                      )}
                      {canShowTranscript && (
                        <button
                          type="button"
                          className="analyze-button"
                          onClick={() => void handleAnalyze(video)}
                          disabled={isInFlight}
                        >
                          {isInFlight ? "Working…" : "Analyze"}
                        </button>
                      )}
                      {canShowTranscript && (
                        <button
                          type="button"
                          className="lessons-toggle"
                          onClick={() => void toggleLessons(video.id)}
                        >
                          {isLessonsExpanded ? "Hide lessons" : "View lessons"}
                        </button>
                      )}
                      {canShowTranscript && (
                        <button
                          type="button"
                          className="edit-button"
                          onClick={() => onOpenEditor(video.id)}
                        >
                          Edit
                        </button>
                      )}
                      {video.transcript_status === "error" && !isInFlight && (
                        <button
                          type="button"
                          className="retry-button"
                          onClick={() => void handleRetry(video)}
                        >
                          Retry
                        </button>
                      )}
                      <button
                        type="button"
                        className="delete-button"
                        onClick={() => void handleRemove(video)}
                        disabled={isInFlight}
                        aria-label={`Remove ${basename(video.file_path)}`}
                      >
                        Remove
                      </button>
                    </div>

                    {videoErrors[video.id] && (
                      <p className="error video-error">{videoErrors[video.id]}</p>
                    )}

                    {isExpanded && (
                      <div className="transcript-panel">
                        {segmentsLoading ? (
                          <p>Loading transcript…</p>
                        ) : segments.length === 0 ? (
                          <p>No transcript segments.</p>
                        ) : (
                          <ul className="transcript-segment-list">
                            {segments.map((segment) => (
                              <li key={segment.id} className="transcript-segment">
                                <span className="transcript-segment-time">
                                  {formatDuration(segment.start)}–{formatDuration(segment.end)}
                                </span>
                                <span className="transcript-segment-text">{segment.text}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}

                    {isLessonsExpanded && (
                      <div className="lesson-panel">
                        {lessonsLoading ? (
                          <p>Loading lesson suggestions…</p>
                        ) : lessons.length === 0 ? (
                          <p>
                            No lesson suggestions yet — click Analyze to generate some from the
                            transcript.
                          </p>
                        ) : (
                          <ul className="lesson-list">
                            {lessons
                              .filter((lesson) => !rejectedLessonIds.has(lesson.id))
                              .map((lesson) => {
                                const isAccepted = acceptedLessonIds.has(lesson.id);
                                return (
                                  <li key={lesson.id} className="lesson-item">
                                    <div className="lesson-item-header">
                                      <span className="lesson-title">{lesson.title}</span>
                                      <span className={`kind-badge kind-${lesson.kind}`}>
                                        {lesson.kind}
                                      </span>
                                      {lesson.confidence !== null && (
                                        <span className="confidence-badge">
                                          {Math.round(lesson.confidence * 100)}% confidence
                                        </span>
                                      )}
                                      <span className="lesson-item-time">
                                        {formatDuration(lesson.start)}–{formatDuration(lesson.end)}
                                      </span>
                                    </div>
                                    {lesson.summary && (
                                      <p className="lesson-summary">{lesson.summary}</p>
                                    )}
                                    <div className="lesson-item-actions">
                                      <button
                                        type="button"
                                        className="lesson-accept-button"
                                        disabled={isAccepted}
                                        onClick={() =>
                                          setAcceptedLessonIds(
                                            (prev) => new Set(prev).add(lesson.id),
                                          )
                                        }
                                      >
                                        {isAccepted ? "Accepted" : "Accept"}
                                      </button>
                                      <button
                                        type="button"
                                        className="lesson-reject-button"
                                        onClick={() =>
                                          setRejectedLessonIds(
                                            (prev) => new Set(prev).add(lesson.id),
                                          )
                                        }
                                      >
                                        Reject
                                      </button>
                                    </div>
                                  </li>
                                );
                              })}
                          </ul>
                        )}
                      </div>
                    )}
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
