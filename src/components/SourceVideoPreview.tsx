import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { LessonSegment } from "../db";

// FFprobe isn't wired up for per-video frame rate in this codebase (see
// `coursecut-architecture`), so there's no real FPS to step by. This
// approximates one "frame" as a fixed 1/30s step for the keyboard shortcuts
// and scrubber granularity below — a deliberate approximation, not a
// stand-in for real FPS probing (out of scope for this milestone).
const FRAME_STEP_SECONDS = 1 / 30;
const BIG_STEP_SECONDS = 1;

/** Seconds → `m:ss` / `h:mm:ss` — duplicated from `LessonCard`'s copy
 * rather than shared, same convention as that file's own note. */
function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${m}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : mmss;
}

export interface SourceVideoPreviewHandle {
  seekTo: (time: number) => void;
}

interface SourceVideoPreviewProps {
  filePath: string;
  /** The currently selected lesson's segments (empty when nothing is
   * selected) — rendered as highlighted blocks on the overlay below the
   * scrubber, per `docs/lesson-segments-plan.md`'s seek-bar overlay. */
  selectedLessonSegments: LessonSegment[];
  /** Whether a lesson is currently selected — gates the Mark In/Out/Add
   * Segment controls, since a segment always needs a target lesson. */
  hasSelectedLesson: boolean;
  /** Mirrors the video's `timeupdate` event up to the parent, which needs
   * it for the Transcript panel's active-segment highlighting (the
   * transcript belongs to the whole video, not a specific lesson, so it
   * stays wired to this component rather than any per-lesson `LessonCard`). */
  onTimeUpdate: (time: number) => void;
  /** Adds a new segment `[start, end)` to whichever lesson is currently
   * selected. Rejects (leaving the marks in place) on failure so the user
   * can retry rather than silently losing their marked range. */
  onAddSegment: (start: number, end: number) => Promise<void>;
}

/** Compact, always-visible player for the raw source video — replaces the
 * old single global `<video>`. See `docs/lesson-segments-plan.md` for why
 * this is deliberately small/secondary rather than the editor's "big"
 * player: per-lesson preview now lives in `LessonCard`. */
const SourceVideoPreview = forwardRef<SourceVideoPreviewHandle, SourceVideoPreviewProps>(
  function SourceVideoPreview(
    { filePath, selectedLessonSegments, hasSelectedLesson, onTimeUpdate, onAddSegment },
    ref,
  ) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    // Native `<video controls>` is gone (see the module doc above), so this
    // component now owns play/pause state itself for the custom control
    // row's button label — driven by the video element's own `onPlay`/
    // `onPause` events, so it stays correct whether playback was toggled via
    // the button, the space-bar shortcut, or (once looping/auto-seek lands
    // elsewhere) a programmatic seek.
    const [isPaused, setIsPaused] = useState(true);
    const [markIn, setMarkIn] = useState<number | null>(null);
    const [markOut, setMarkOut] = useState<number | null>(null);
    const [addingSegment, setAddingSegment] = useState(false);
    const [addSegmentError, setAddSegmentError] = useState<string | null>(null);

    useImperativeHandle(ref, () => ({
      seekTo(time: number) {
        if (videoRef.current) {
          videoRef.current.currentTime = time;
        }
      },
    }));

    // Reset in-progress marks whenever the selected lesson changes (the
    // marked range no longer has an obvious target lesson).
    useEffect(() => {
      setMarkIn(null);
      setMarkOut(null);
      setAddSegmentError(null);
    }, [hasSelectedLesson]);

    function handleTimeUpdate(event: React.SyntheticEvent<HTMLVideoElement>) {
      const time = event.currentTarget.currentTime;
      setCurrentTime(time);
      onTimeUpdate(time);
    }

    function handleScrub(event: React.ChangeEvent<HTMLInputElement>) {
      const time = Number(event.target.value);
      if (videoRef.current) {
        videoRef.current.currentTime = time;
      }
      setCurrentTime(time);
      onTimeUpdate(time);
    }

    function togglePlayPause() {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) void video.play();
      else video.pause();
    }

    const canAddSegment =
      hasSelectedLesson && markIn !== null && markOut !== null && markIn < markOut && !addingSegment;

    async function handleAddSegment() {
      if (!canAddSegment || markIn === null || markOut === null) return;
      setAddingSegment(true);
      setAddSegmentError(null);
      try {
        await onAddSegment(markIn, markOut);
        setMarkIn(null);
        setMarkOut(null);
      } catch (err) {
        setAddSegmentError(err instanceof Error ? err.message : String(err));
      } finally {
        setAddingSegment(false);
      }
    }

    // Keyboard shortcuts (space = play/pause, ←/→ = ~1 frame, Shift+←/→ =
    // 1s). Always mounted (this component isn't gated behind a "mode"
    // anymore), so the listener is just added/removed on mount/unmount.
    useEffect(() => {
      function handleKeyDown(event: KeyboardEvent) {
        const target = event.target as HTMLElement | null;
        // Text-entry fields should keep normal typing behavior. The custom
        // range-input scrubber is deliberately NOT excluded here even
        // though it's also an <input>: clicking it gives it focus, and
        // without this carve-out its native arrow-key stepping (and space)
        // would silently shadow these same shortcuts — preventDefault below
        // suppresses that native behavior so this handler is the only thing
        // that runs.
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
    }, []);

    return (
      <div className="source-preview">
        <video
          ref={videoRef}
          src={convertFileSrc(filePath)}
          className="source-preview-video"
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
          onTimeUpdate={handleTimeUpdate}
          onPlay={() => setIsPaused(false)}
          onPause={() => setIsPaused(true)}
        />

        {/* Replaces native `<video controls>` (dropped above — shadow DOM
           controls can't carry the yellow segment-highlight overlay, see
           the scrubber below). This is the only seekbar now. */}
        <div className="source-preview-controls-row">
          <button
            type="button"
            onClick={togglePlayPause}
            aria-label={isPaused ? "Play" : "Pause"}
            className="source-preview-play-button"
          >
            {isPaused ? "▶" : "⏸"}
          </button>
          <span className="source-preview-time-readout">
            {formatDuration(currentTime)} / {formatDuration(duration)}
          </span>
        </div>

        <div className="source-preview-scrubber-wrapper">
          <input
            type="range"
            className="source-preview-scrubber"
            min={0}
            max={duration || 0}
            step={FRAME_STEP_SECONDS}
            value={Math.min(currentTime, duration || currentTime)}
            onChange={handleScrub}
            aria-label="Scrub source video"
          />
          <div className="source-preview-overlay" aria-hidden="true">
            {duration > 0 &&
              selectedLessonSegments.map((segment) => (
                <span
                  key={segment.id}
                  className="source-preview-segment-highlight"
                  style={{
                    left: `${(segment.start / duration) * 100}%`,
                    width: `${((segment.end - segment.start) / duration) * 100}%`,
                  }}
                />
              ))}
          </div>
        </div>

        <p className="source-preview-hint">
          Space: play/pause · ←/→: step ~1 frame (1/30s) · Shift+←/→: step 1s
        </p>

        <div className="source-preview-mark-controls">
          <button type="button" disabled={!hasSelectedLesson} onClick={() => setMarkIn(currentTime)}>
            Mark In
          </button>
          <span className="source-preview-mark-value">{markIn !== null ? formatDuration(markIn) : "—"}</span>
          <button type="button" disabled={!hasSelectedLesson} onClick={() => setMarkOut(currentTime)}>
            Mark Out
          </button>
          <span className="source-preview-mark-value">{markOut !== null ? formatDuration(markOut) : "—"}</span>
          <button type="button" disabled={!canAddSegment} onClick={() => void handleAddSegment()}>
            Add segment
          </button>
        </div>
        {!hasSelectedLesson && (
          <p className="source-preview-hint">Select a lesson below to add a segment to it.</p>
        )}
        {addSegmentError && <p className="error">{addSegmentError}</p>}
      </div>
    );
  },
);

export default SourceVideoPreview;
