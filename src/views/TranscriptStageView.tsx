import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Loader2, Pause, Play, RotateCw } from "lucide-react";
import Breadcrumbs from "../components/Breadcrumbs";
import { basename } from "./ProjectDetailView";
import {
  analyzeVideo,
  deletePlaybackClip,
  getProject,
  getVideo,
  listLessons,
  listTranscriptSegments,
  prepareSegmentPlaybackClip,
  retranscribeChunk,
  updateTranscriptSegment,
  TRANSCRIPT_CHUNK_MIN_TRAILING_SECONDS,
  TRANSCRIPT_CHUNK_SECONDS,
  type Project,
  type TranscriptSegment,
  type Video,
  type VideoProgress,
} from "../db";
import { useVideoProgress } from "../hooks/useVideoProgress";
import { formatTimestamp } from "../lib/timestamp";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";

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

  // Chunk sidebar (only shown for recordings long enough to have been
  // chunked at transcription time — see `TRANSCRIPT_CHUNK_SECONDS`).
  const [selectedChunkIndex, setSelectedChunkIndex] = useState<number | null>(null);
  const [busyChunkIndex, setBusyChunkIndex] = useState<number | null>(null);
  // Per-chunk attempt counter, same idea as `ProjectDetailView`'s
  // `attemptCountsRef` — bumped on each retry of the same chunk so repeated
  // retries show "attempt 2" etc. in progress text.
  const attemptCountsRef = useRef<Record<number, number>>({});

  // Per-segment audio playback — lets a user click a segment's timestamp to
  // hear just that slice and check it against the transcribed text.
  //
  // Rather than seeking within the source video directly, each click cuts
  // a fresh local WAV clip of just that segment via
  // `prepareSegmentPlaybackClip` and plays that. Two things this app's
  // actual recordings have been observed doing make seeking the original
  // file directly unreliable in the webview: an audio track ordered before
  // the video track plus an extra unrecognized data track (confuses
  // WebKit's track selection in both `<audio>` and `<video>` tags), and
  // internally inconsistent video color metadata (can make a strict
  // hardware decoder reject the whole file). A short, uncompressed,
  // single-track WAV — produced by ffmpeg, which already handles these
  // files fine everywhere else in this app — has none of that ambiguity
  // for the webview to trip on. One shared `<audio>` element (not one per
  // row) is enough since only one segment ever plays at a time.
  //
  // Local-only either way — this is playback, not an upload, so it's outside
  // `coursecut-privacy-invariants`' scope (which is about what leaves the
  // device).
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playingSegmentId, setPlayingSegmentId] = useState<string | null>(null);
  // 0–1 progress through the *currently playing* segment's own clip, for
  // the progress ring around its Play/Pause button — meaningless (and
  // ignored) for any other row. Simple `currentTime / duration` now that
  // the audio element's whole loaded file *is* the segment, rather than an
  // absolute-timestamp range within a much longer file.
  const [playbackProgress, setPlaybackProgress] = useState(0);
  // Path of the clip currently loaded into `audioRef` (if any), so the
  // *previous* one can be deleted once a new one successfully takes over —
  // temp WAV clips don't clean themselves up.
  const currentClipPathRef = useRef<string | null>(null);
  // Guards against overlapping clip-prepare calls if Play is clicked
  // rapidly across different rows before the first one's ffmpeg cut and
  // Tauri round-trip finish.
  const preparingClipRef = useRef(false);

  const deleteClipBestEffort = useCallback((path: string | null) => {
    if (!path) return;
    void deletePlaybackClip(path).catch(() => {});
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    // The `<audio>` element only exists once `video` has loaded (it's
    // inside `{video && (...)}` below) — on the very first render `video`
    // is still null, so this ran with `audio` as `null` and, with an empty
    // dependency array, never got another chance to actually attach these
    // listeners once the element showed up. Depending on `video` makes
    // this re-run right when the element first mounts.
    if (!audio) return;
    const handleStopped = () => {
      setPlayingSegmentId(null);
      setPlaybackProgress(0);
    };
    const handleTimeUpdate = () => {
      if (!audio.duration || Number.isNaN(audio.duration)) return;
      setPlaybackProgress(Math.min(1, Math.max(0, audio.currentTime / audio.duration)));
    };
    audio.addEventListener("pause", handleStopped);
    audio.addEventListener("ended", handleStopped);
    audio.addEventListener("error", handleStopped);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    return () => {
      audio.removeEventListener("pause", handleStopped);
      audio.removeEventListener("ended", handleStopped);
      audio.removeEventListener("error", handleStopped);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [video]);

  const handlePlaySegment = useCallback(
    async (segment: TranscriptSegment) => {
      const audio = audioRef.current;
      if (!audio) return;
      if (playingSegmentId === segment.id) {
        audio.pause();
        return;
      }
      if (preparingClipRef.current) return;
      preparingClipRef.current = true;
      // Set immediately, not deferred to a "playback actually started"
      // event — switching from one segment to another while audio is
      // already playing doesn't re-fire `playing` in every browser, so
      // waiting for it can leave the ring on the previously-playing row.
      // `handleStopped` above is the rollback path if this never pans out.
      setPlayingSegmentId(segment.id);
      try {
        const clipPath = await prepareSegmentPlaybackClip(videoId, segment.start, segment.end);
        const previousClipPath = currentClipPathRef.current;
        currentClipPathRef.current = clipPath;
        audio.src = convertFileSrc(clipPath);
        await audio.play();
        deleteClipBestEffort(previousClipPath);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPlayingSegmentId(null);
      } finally {
        preparingClipRef.current = false;
      }
    },
    [playingSegmentId, videoId, deleteClipBestEffort],
  );

  // Stop playback and clean up the last clip if this view unmounts (e.g.
  // navigating away) mid-clip, or if `video` itself changes (switching to
  // a different video's transcript without this component remounting).
  // Depends on `video`, same reasoning as the listener effect above: the
  // `<audio>` element doesn't exist until `video` first loads, so capturing
  // `audioRef.current` before that would freeze on `null` and never see
  // the real element.
  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      audio?.pause();
      deleteClipBestEffort(currentClipPathRef.current);
      currentClipPathRef.current = null;
    };
  }, [video, deleteClipBestEffort]);

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

  // Chunk boundaries are derived purely from the video's duration and
  // `TRANSCRIPT_CHUNK_SECONDS` — no `chunk_index` is stored anywhere (see
  // `retranscribe_chunk` in `src-tauri/src/openai.rs`). Only meaningful
  // (and only rendered) for a recording that was actually chunked at
  // transcription time.
  const chunkCount = useMemo(() => {
    if (video?.duration == null || video.duration <= TRANSCRIPT_CHUNK_SECONDS) return 0;
    // Mirrors `split_audio_by_time`'s own loop condition (`remaining >=
    // MIN_TRAILING_CHUNK_SECS`) exactly, not a plain `Math.ceil` — a
    // duration landing in the last second before a chunk boundary (e.g.
    // 1200.5s) was only ever split into 2 real chunks, not 3, and a naive
    // ceil would show a phantom final chunk that was never transcribed.
    return (
      Math.floor(
        (video.duration - TRANSCRIPT_CHUNK_MIN_TRAILING_SECONDS) / TRANSCRIPT_CHUNK_SECONDS,
      ) + 1
    );
  }, [video?.duration]);

  const chunkRange = useCallback(
    (chunkIndex: number): [number, number] => {
      const start = chunkIndex * TRANSCRIPT_CHUNK_SECONDS;
      const end = Math.min((chunkIndex + 1) * TRANSCRIPT_CHUNK_SECONDS, video?.duration ?? start);
      return [start, end];
    },
    [video?.duration],
  );

  const filteredSegments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    let result = segments;
    if (selectedChunkIndex != null) {
      const [chunkStart, chunkEnd] = chunkRange(selectedChunkIndex);
      result = result.filter((segment) => segment.start >= chunkStart && segment.start < chunkEnd);
    }
    if (query) {
      result = result.filter((segment) => segment.text.toLowerCase().includes(query));
    }
    return result;
  }, [segments, searchQuery, selectedChunkIndex, chunkRange]);

  const handleRetranscribeChunk = useCallback(
    async (chunkIndex: number) => {
      if (busyChunkIndex !== null) return;
      const nextAttempt = (attemptCountsRef.current[chunkIndex] ?? 0) + 1;
      attemptCountsRef.current[chunkIndex] = nextAttempt;
      setBusyChunkIndex(chunkIndex);
      clearProgress(videoId);
      try {
        await retranscribeChunk(videoId, chunkIndex, nextAttempt);
        setSegments(await listTranscriptSegments(videoId));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyChunkIndex(null);
      }
    },
    [videoId, busyChunkIndex, clearProgress],
  );

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
      {error && (
        <Alert variant="destructive" className="my-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!loading && !video && <p>Video not found.</p>}

      {video && (
        <>
          {/* No `src` here — each click loads a freshly-cut clip (see the
           * playback state comment above), rather than this element ever
           * pointing at the source video directly. No `controls`; playback
           * is driven entirely by each segment's own Play button
           * (`handlePlaySegment`). */}
          <audio ref={audioRef} />

          <div className="my-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleUndo()}
                disabled={undoStack.length === 0}
              >
                Undo
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleRedo()}
                disabled={redoStack.length === 0}
              >
                Redo
              </Button>
            </div>
            <div className="flex items-center gap-2">
              {analyzing && (
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
                    {videoProgress?.detail && <> ({videoProgress.detail})</>}
                  </span>
                </span>
              )}
              <Button
                type="button"
                variant={hasLessons ? "outline" : "default"}
                onClick={() => void handleAnalyze()}
                disabled={analyzing || busyChunkIndex !== null}
              >
                {hasLessons && <RotateCw />}
                {hasLessons ? "Analyze again" : "Analyze"}
              </Button>
              {hasLessons && (
                <Button type="button" onClick={onOpenLessons}>
                  View lessons →
                </Button>
              )}
            </div>
          </div>
          {analyzeError && (
            <Alert variant="destructive" className="my-2">
              <AlertDescription>{analyzeError}</AlertDescription>
            </Alert>
          )}

          <Input
            type="search"
            className="my-2"
            placeholder="Search transcript…"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            aria-label="Search transcript"
          />

          {/* Chunk sidebar and segment list flow together as normal page
           * content (no inner max-height/scroll box) — a short transcript
           * takes only the space it needs instead of leaving a reserved gap
           * below it, and a long one scrolls the whole page as one unit
           * (chunk sidebar included) rather than fighting an inner scrollbar
           * sized independently of the window. */}
          <div className="flex gap-4">
            {chunkCount > 0 && (
              <ul className="m-0 flex w-40 shrink-0 list-none flex-col gap-1.5 p-0">
                {Array.from({ length: chunkCount }, (_, chunkIndex) => {
                  const [chunkStart, chunkEnd] = chunkRange(chunkIndex);
                  const isBusy = busyChunkIndex === chunkIndex;
                  const chunkProgress = isBusy ? progress[videoId] : undefined;
                  return (
                    <li key={chunkIndex} className="flex flex-col gap-1">
                      <Button
                        type="button"
                        variant={selectedChunkIndex === chunkIndex ? "default" : "outline"}
                        size="sm"
                        className="w-full justify-start"
                        onClick={() =>
                          setSelectedChunkIndex((prev) => (prev === chunkIndex ? null : chunkIndex))
                        }
                      >
                        {formatTimestamp(chunkStart)}–{formatTimestamp(chunkEnd)}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full justify-start gap-1.5"
                        disabled={busyChunkIndex !== null || analyzing}
                        onClick={() => void handleRetranscribeChunk(chunkIndex)}
                      >
                        {isBusy && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
                        {isBusy
                          ? `${chunkProgress ? stageLabel(chunkProgress.stage) : "Working…"}`
                          : "Re-transcribe"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}

            {filteredSegments.length === 0 ? (
              <p className="min-w-0 flex-1">No matching transcript segments.</p>
            ) : (
              <ul className="m-0 flex min-w-0 flex-1 list-none flex-col gap-1.5 p-0">
                {filteredSegments.map((segment) => {
                  const isBusy = segmentBusyIds.has(segment.id);
                  const checkboxId = `transcript-segment-keep-${segment.id}`;
                  const isPlaying = playingSegmentId === segment.id;
                  // Ring geometry for the progress indicator below: a
                  // 24×24 box (matches the `icon-xs` button size) with a
                  // radius-10 circle, stroke-dashoffset counting down from
                  // the full circumference as `playbackProgress` (0–1)
                  // rises — only meaningful while this exact row is the one
                  // playing.
                  const ringCircumference = 2 * Math.PI * 10;
                  return (
                    <li
                      key={segment.id}
                      className={cn(
                        "flex items-center gap-3 text-sm",
                        !segment.keep && "opacity-45 line-through",
                      )}
                    >
                      <div className="relative inline-flex size-6 shrink-0 items-center justify-center">
                        {isPlaying && (
                          <svg
                            className="pointer-events-none absolute inset-0 -rotate-90"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <circle
                              cx="12"
                              cy="12"
                              r="10"
                              fill="none"
                              stroke="currentColor"
                              strokeOpacity="0.25"
                              strokeWidth="2"
                            />
                            <circle
                              cx="12"
                              cy="12"
                              r="10"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeDasharray={ringCircumference}
                              strokeDashoffset={(1 - playbackProgress) * ringCircumference}
                            />
                          </svg>
                        )}
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          className="relative"
                          onClick={() => void handlePlaySegment(segment)}
                          aria-label={isPlaying ? "Pause segment audio" : "Play segment audio"}
                        >
                          {isPlaying ? <Pause /> : <Play />}
                        </Button>
                      </div>
                      <span className="shrink-0 tabular-nums opacity-60">
                        {formatTimestamp(segment.start)}–{formatTimestamp(segment.end)}
                      </span>
                      <span className="flex-1">{segment.text}</span>
                      <div className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs">
                        <Checkbox
                          id={checkboxId}
                          checked={segment.keep}
                          disabled={isBusy}
                          onCheckedChange={() => void handleToggleKeep(segment)}
                        />
                        <Label htmlFor={checkboxId}>Keep</Label>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
