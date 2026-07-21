import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import Breadcrumbs from "../components/Breadcrumbs";
import {
  deleteVideo,
  extractAudioForVideo,
  getOpenAiKeyStatus,
  getProject,
  importVideos,
  listVideos,
  markVideoError,
  SUPPORTED_VIDEO_EXTENSIONS,
  transcribeVideo,
  type Project,
  type Video,
  type VideoProgress,
} from "../db";
import { useVideoProgress } from "../hooks/useVideoProgress";

const NO_KEY_MESSAGE =
  "No OpenAI API key saved yet — add one in Settings, then use Retry to transcribe this video.";

/** Statuses that mean "not yet transcribed" — anything else (transcribed,
 * and any later status future milestones add) can open the video's staged
 * flow (M3: `TranscriptStageView`/`LessonEditorView` via `onOpenVideo`). */
const PRE_TRANSCRIPT_STATUSES = new Set(["pending", "audio_ready", "error"]);

interface ProjectDetailViewProps {
  projectId: string;
  onBack: () => void;
  // Opens this video's staged flow (docs/ux-overhaul-plan.md Phase 3),
  // always landing on the transcript stage first.
  onOpenVideo: (videoId: string) => void;
  // Navigates to this project's Export History (PRD §11, Milestone 8).
  onOpenExportHistory: () => void;
}

/** Last path component, handling both `/` (macOS) and `\` (Windows).
 * Exported so `ExportHistoryView` (PRD §11, Milestone 8) and the video-stage
 * views (M3) can reuse it instead of re-implementing path-splitting
 * differently. */
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

/** Friendly label for a `Stage` value (`src-tauri/src/progress.rs`), for the
 * throwaway per-row progress indicator below — M3 replaces this row-level
 * display with the staged flow's own indicators, so this stays local to
 * this file rather than a shared formatter. */
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
  onOpenVideo,
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
  // Per-video attempt counter, stamped onto each `extractAudioForVideo`/
  // `transcribeVideo` call's "video-progress" events (see
  // `src-tauri/src/progress.rs`) so a Retry shows up as "Retrying (2)…"
  // rather than looking identical to the first attempt. Starts at 1 (fresh
  // import) and is bumped only by `handleRetry`.
  const attemptCountsRef = useRef<Record<string, number>>({});
  const { progress, clearProgress } = useVideoProgress();

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
      const attempt = attemptCountsRef.current[video.id] ?? 1;
      // A cache-hit short-circuit (cached audio or cached transcript) can
      // resolve this whole call without ever emitting a fresh event —
      // without clearing here, a stale event from a previous, possibly
      // different-stage/different-attempt operation on this same video
      // would keep rendering for the full duration of this one.
      clearProgress(video.id);
      try {
        // Checked per video, not once per batch: a key can be added mid-session
        // (e.g. a user opens Settings in another window between imports), and
        // this call is cheap enough that per-video is safer without being
        // wasteful. Fails before `extractAudioForVideo` runs so a video never
        // pays for ffmpeg transcoding only to fail at the transcription step
        // for lack of a key.
        const keyStatus = await getOpenAiKeyStatus();
        if (!keyStatus.present) {
          setVideoErrors((prev) => ({ ...prev, [video.id]: NO_KEY_MESSAGE }));
          // No extraction/transcription attempt was actually made, so
          // nothing else sets `transcript_status = 'error'` on this row —
          // without this, the row stays stuck in `pending`/`audio_ready`
          // forever with no Retry button, since Retry is gated on `error`
          // status (see `PRE_TRANSCRIPT_STATUSES` above).
          await markVideoError(video.id).catch(() => {});
          setVideos(await listVideos(projectId));
          return;
        }

        let current: Video | null = video;
        if (!current.audio_path) {
          try {
            current = await extractAudioForVideo(current.id, attempt);
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
            await transcribeVideo(current.id, attempt);
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
    [projectId, clearProgress],
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
      attemptCountsRef.current[video.id] = (attemptCountsRef.current[video.id] ?? 1) + 1;
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
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [projectId],
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

  return (
    <div>
      <Breadcrumbs
        crumbs={[
          { label: "Projects", onClick: onBack },
          ...(project ? [{ label: project.name }] : []),
        ]}
      />

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
                const isInFlight = inFlightIds.has(video.id);
                const videoProgress = progress[video.id];
                return (
                  <li key={video.id} className="video-list-entry">
                    <div
                      className={
                        canShowTranscript ? "video-list-item video-list-item-clickable" : "video-list-item"
                      }
                      onClick={canShowTranscript ? () => onOpenVideo(video.id) : undefined}
                      role={canShowTranscript ? "button" : undefined}
                      tabIndex={canShowTranscript ? 0 : undefined}
                      onKeyDown={
                        canShowTranscript
                          ? (event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                onOpenVideo(video.id);
                              }
                            }
                          : undefined
                      }
                    >
                      <div className="video-info">
                        <span className="video-name">{basename(video.file_path)}</span>
                        <span className="video-path">{video.file_path}</span>
                      </div>
                      <span className="video-duration">{formatDuration(video.duration)}</span>
                      <span className={`status-badge status-${video.transcript_status}`}>
                        {video.transcript_status}
                      </span>
                      {isInFlight && (
                        <span className="video-progress">
                          <span
                            className={
                              videoProgress?.fraction == null
                                ? "video-progress-spinner"
                                : "video-progress-bar"
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
                            {videoProgress && videoProgress.attempt > 1 && (
                              <> — Retrying ({videoProgress.attempt})…</>
                            )}
                            {videoProgress?.detail && <> ({videoProgress.detail})</>}
                          </span>
                        </span>
                      )}
                      {video.transcript_status === "error" && !isInFlight && (
                        <button
                          type="button"
                          className="retry-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleRetry(video);
                          }}
                        >
                          Retry
                        </button>
                      )}
                      <button
                        type="button"
                        className="delete-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleRemove(video);
                        }}
                        disabled={isInFlight}
                        aria-label={`Remove ${basename(video.file_path)}`}
                      >
                        Remove
                      </button>
                    </div>

                    {videoErrors[video.id] && (
                      <p className="error video-error">{videoErrors[video.id]}</p>
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
