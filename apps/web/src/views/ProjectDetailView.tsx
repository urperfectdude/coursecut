// PORTED FROM: src/views/ProjectDetailView.tsx @ 16d83e5
// DEVIATIONS: D1 — browser file/folder inputs and DOM drag & drop replace
// the native dialog and Tauri's webview drop events; `handleImport` takes
// `File` objects rather than filesystem paths.
// D7 — no pre-flight OpenAI key check before starting the pipeline; the key
// is platform-owned, so "no key saved" is not a reachable state.
// One-way port — desktop is upstream. Don't edit this for web-only reasons;
// port the change to the desktop file first. See docs/web-app-plan.md §7.1,
// and re-run scripts/ui-drift.sh (which reads the SHA above) after syncing.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { Loader2 } from "lucide-react";
import Breadcrumbs from "../components/Breadcrumbs";
import {
  deleteVideo,
  extractAudioForVideo,
  getProject,
  importVideos,
  listVideos,
  SUPPORTED_VIDEO_EXTENSIONS,
  transcribeVideo,
  type Project,
  type Video,
  type VideoProgress,
} from "../db";
import { useVideoProgress } from "../hooks/useVideoProgress";
import { formatTimestamp } from "../lib/timestamp";
import { getVideoStatusBadgeClassName } from "../lib/badge-variants";
import { cn } from "@/lib/utils";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

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

/** D1: the browser hands back everything the user picked — including, for a
 * folder import, whatever else lives in that folder. Desktop's Rust side
 * skips unsupported files during its walk; this is the same filter, moved
 * client-side because that walk now happens in the picker. */
function supportedVideoFiles(files: File[]): File[] {
  return files.filter((file) =>
    SUPPORTED_VIDEO_EXTENSIONS.includes(file.name.split(".").pop()?.toLowerCase() ?? ""),
  );
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

/** Seconds → `hh:mm:ss`. Duration is probed later, so most rows show
 * the placeholder for now. Exported so `ExportHistoryView` (PRD §11,
 * Milestone 8) can reuse it for lesson duration formatting. */
export function formatDuration(seconds: number | null): string {
  return seconds === null ? "--:--:--" : formatTimestamp(seconds);
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
  // Which video (if any) is pending Remove confirmation — a single piece of
  // state driving one shared `AlertDialog`, rather than one dialog per row,
  // same pattern as `HomeView`'s `pendingDelete`.
  const [pendingRemove, setPendingRemove] = useState<Video | null>(null);
  // D1: the two hidden inputs standing in for desktop's native dialogs.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
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
        // D7: desktop pre-flights the user's OpenAI key here and bails before
        // paying for ffmpeg if none is saved. The web app's key is
        // platform-owned and always present, so there is no such failure mode
        // to check for and the pipeline starts directly.
        //
        // That gate was `markVideoError`'s only caller, so it now has none in
        // web. It stays exported from `db.ts` because that file mirrors
        // desktop's surface, and because it is the right call for any future
        // client-side short-circuit (a quota refusal, say) that needs to
        // leave a row in `error` and therefore Retry-able.
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
    async (files: File[]) => {
      if (files.length === 0 || importingRef.current) return;
      importingRef.current = true;
      setImporting(true);
      try {
        const added = await importVideos(projectId, files);
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

  /** Opens the shared Remove confirmation dialog for `video` — the actual
   * delete happens in `handleConfirmRemove` once the user confirms. */
  const handleRemove = useCallback((video: Video) => {
    if (inFlightRef.current.has(video.id)) return;
    setPendingRemove(video);
  }, []);

  /** Removes `pendingRemove` from the project entirely (distinct from Retry
   * — this deletes the row). Does not touch the cached extracted-audio WAV
   * file, since it's content-hash-keyed and may be shared with other
   * videos. */
  const handleConfirmRemove = useCallback(async () => {
    if (!pendingRemove) return;
    const video = pendingRemove;
    setPendingRemove(null);
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
  }, [pendingRemove, projectId]);

  // D1: the desktop app receives OS drag & drop through Tauri's webview
  // event and gets real paths; a browser gets DOM events and `File` objects.
  // The dropzone below binds these directly, and the window-level
  // `dragover`/`drop` handlers stop the browser from navigating away when a
  // file is dropped anywhere else on the page.
  useEffect(() => {
    const swallow = (event: Event) => event.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      // A dropped folder arrives as a directory entry with no `File` bytes,
      // so it is filtered out here rather than silently importing as 0 bytes.
      // Desktop can walk a dropped folder; the browser can't without the
      // non-standard entries API, so "Import folder" is the supported path.
      void handleImport(supportedVideoFiles(Array.from(event.dataTransfer.files)));
    },
    [handleImport],
  );

  function handleImportFiles() {
    fileInputRef.current?.click();
  }

  function handleImportFolder() {
    folderInputRef.current?.click();
  }

  /** Shared by both hidden inputs: import what was picked, then reset the
   * input so picking the same file twice in a row still fires `change`. */
  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const picked = supportedVideoFiles(Array.from(event.target.files ?? []));
      event.target.value = "";
      void handleImport(picked);
    },
    [handleImport],
  );

  return (
    <div>
      <Breadcrumbs
        crumbs={[
          { label: "Projects", onClick: onBack },
          ...(project ? [{ label: project.name }] : []),
        ]}
      />

      {loading && <p>Loading project…</p>}
      {error && (
        <Alert variant="destructive" className="my-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!loading && !error && !project && <p>Project not found.</p>}

      {project && (
        <>
          <div className="flex items-start justify-end gap-4">
            <Button type="button" variant="outline" className="shrink-0" onClick={onOpenExportHistory}>
              Export History
            </Button>
          </div>

          <div className="my-4 flex items-center gap-2">
            {/* D1: the buttons keep their desktop labels and behaviour; only
                the mechanism behind them is a hidden input rather than a
                native dialog. `webkitdirectory` is what makes "Import
                folder" possible at all in a browser. */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={SUPPORTED_VIDEO_EXTENSIONS.map((extension) => `.${extension}`).join(",")}
              className="hidden"
              onChange={handleInputChange}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              // @ts-expect-error — non-standard, but supported by every
              // browser we target; React has no typing for it.
              webkitdirectory=""
              className="hidden"
              onChange={handleInputChange}
            />
            <Button type="button" onClick={handleImportFiles} disabled={importing}>
              Import videos
            </Button>
            <Button type="button" onClick={handleImportFolder} disabled={importing}>
              Import folder
            </Button>
            {importing && <span className="text-sm text-muted-foreground">Importing…</span>}
          </div>

          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={cn(
              "mb-4 rounded-md border-2 border-dashed p-5 text-center text-sm transition-colors",
              dragging ? "border-primary bg-primary/5" : "border-border text-muted-foreground",
            )}
          >
            {dragging ? "Drop to import" : "Or drag & drop video files or folders here"}
          </div>

          {importMessage && (
            <Badge variant="secondary" className="mb-4">
              {importMessage}
            </Badge>
          )}

          {videos.length === 0 ? (
            <p>No videos imported yet.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {videos.map((video) => {
                const canShowTranscript = !PRE_TRANSCRIPT_STATUSES.has(video.transcript_status);
                const isInFlight = inFlightIds.has(video.id);
                const videoProgress = progress[video.id];
                return (
                  <li key={video.id} className="border-b border-border py-2">
                    <div
                      className={cn(
                        "flex items-center gap-4",
                        canShowTranscript && "cursor-pointer",
                      )}
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
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="font-semibold">{basename(video.file_path)}</span>
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-sm opacity-60">
                          {video.file_path}
                        </span>
                      </div>
                      <span className="text-sm tabular-nums opacity-70">
                        {formatDuration(video.duration)}
                      </span>
                      <Badge
                        variant="outline"
                        className={getVideoStatusBadgeClassName(video.transcript_status)}
                      >
                        {video.transcript_status}
                      </Badge>
                      {isInFlight && (
                        <span className="flex items-center gap-1.5 text-sm opacity-85">
                          {videoProgress?.fraction == null ? (
                            <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
                          ) : (
                            <Progress
                              value={Math.round(videoProgress.fraction * 100)}
                              className="h-1.5 w-16 shrink-0"
                            />
                          )}
                          <span>
                            {videoProgress ? stageLabel(videoProgress.stage) : "Working…"}
                            {videoProgress && videoProgress.attempt > 1 && (
                              <> — Retrying ({videoProgress.attempt})…</>
                            )}
                            {videoProgress?.detail && <> ({videoProgress.detail})</>}
                          </span>
                        </span>
                      )}
                      {video.transcript_status === "error" && !isInFlight && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleRetry(video);
                          }}
                        >
                          Retry
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRemove(video);
                        }}
                        disabled={isInFlight}
                        aria-label={`Remove ${basename(video.file_path)}`}
                      >
                        Remove
                      </Button>
                    </div>

                    {videoErrors[video.id] && (
                      <Alert variant="destructive" className="mt-1">
                        <AlertDescription>{videoErrors[video.id]}</AlertDescription>
                      </Alert>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <AlertDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove video?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemove &&
                `Remove "${basename(pendingRemove.file_path)}" from this project? This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmRemove}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
