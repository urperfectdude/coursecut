import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Maximize, Minimize2, Pause, Play } from "lucide-react";
import type { LessonSegment } from "../db";
import { formatTimestamp } from "../lib/timestamp";
import SegmentedScrubber from "./SegmentedScrubber";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// FFprobe isn't wired up for per-video frame rate in this codebase (see
// `coursecut-architecture`), so there's no real FPS to step by. This
// approximates one "frame" as a fixed 1/30s step for the keyboard shortcuts
// and scrubber granularity below — a deliberate approximation, not a
// stand-in for real FPS probing (out of scope for this milestone).
const FRAME_STEP_SECONDS = 1 / 30;
const BIG_STEP_SECONDS = 1;

export interface SourceVideoPreviewHandle {
  seekTo: (time: number) => void;
}

interface SourceVideoPreviewProps {
  filePath: string;
  /** The currently selected lesson's segments (empty when nothing is
   * selected) — rendered as highlighted blocks on the overlay below the
   * scrubber, per `docs/lesson-segments-plan.md`'s seek-bar overlay. Unused
   * in `"minimal"` layout, which has no lesson selection. */
  selectedLessonSegments?: LessonSegment[];
  /** Whether a lesson is currently selected — gates the Mark In/Out/Add
   * Segment controls, since a segment always needs a target lesson. Unused
   * in `"minimal"` layout, which doesn't render those controls at all. */
  hasSelectedLesson?: boolean;
  /** Mirrors the video's `timeupdate` event up to the parent, which needs
   * it for the Transcript panel's active-segment highlighting (the
   * transcript belongs to the whole video, not a specific lesson, so it
   * stays wired to this component rather than any per-lesson `LessonCard`). */
  onTimeUpdate: (time: number) => void;
  /** Adds a new segment `[start, end)` to whichever lesson is currently
   * selected. Rejects (leaving the marks in place) on failure so the user
   * can retry rather than silently losing their marked range. Unused in
   * `"minimal"` layout. */
  onAddSegment?: (start: number, end: number) => Promise<void>;
  /** Placement of the keyboard-shortcut hint + Mark In/Out/Add segment
   * panel relative to the video. "side" puts it in a column to the right.
   * "stacked" puts it below the video instead — used on
   * `LessonSegmentsView`, where this preview already sits narrow beside the
   * lesson's own preview player, so a side panel there would squeeze the
   * video too far. "minimal" (default) drops the Mark In/Out/Add segment
   * controls entirely and shows only the keyboard-shortcut hints, as a
   * single row above a centered video — used on `LessonEditorView`, where
   * adding a segment now happens on a lesson's own `LessonSegmentsView`
   * page instead. */
  controlsLayout?: "side" | "stacked" | "minimal";
}

/** One "[key] [key]  label" hint, e.g. the Space/←→/Shift+←→ rows below —
 * factored out since that same trio of hints is rendered twice (the "side"
 * and "minimal" `controlsLayout`s each show their own copy). */
function ShortcutHint({ keys, label }: { keys: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <KbdGroup>{keys}</KbdGroup>
      <span className="text-xs opacity-60">{label}</span>
    </div>
  );
}

function KeyboardShortcutHints() {
  return (
    <>
      <ShortcutHint keys={<Kbd>Space</Kbd>} label="play/pause" />
      <ShortcutHint
        keys={
          <>
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
          </>
        }
        label="step ~1 frame (1/30s)"
      />
      <ShortcutHint
        keys={
          <>
            <Kbd>Shift</Kbd>
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
          </>
        }
        label="step 1s"
      />
    </>
  );
}

/** Compact, always-visible player for the raw source video — replaces the
 * old single global `<video>`. See `docs/lesson-segments-plan.md` for why
 * this is deliberately small/secondary rather than the editor's "big"
 * player: per-lesson preview now lives in `LessonCard`. */
const SourceVideoPreview = forwardRef<SourceVideoPreviewHandle, SourceVideoPreviewProps>(
  function SourceVideoPreview(
    {
      filePath,
      selectedLessonSegments = [],
      hasSelectedLesson = false,
      onTimeUpdate,
      onAddSegment,
      controlsLayout = "minimal",
    },
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
    const [playbackRate, setPlaybackRate] = useState(1);
    // A CSS-driven full-viewport overlay rather than the native browser
    // Fullscreen API — Tauri's WKWebView on macOS doesn't support
    // `element.requestFullscreen()` for arbitrary elements, so that call
    // silently no-ops there. See `LessonPreviewPlayer`, which shares this
    // approach.
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [markIn, setMarkIn] = useState<number | null>(null);
    const [markOut, setMarkOut] = useState<number | null>(null);
    const [addingSegment, setAddingSegment] = useState(false);
    const [addSegmentError, setAddSegmentError] = useState<string | null>(null);

    useEffect(() => {
      if (videoRef.current) videoRef.current.playbackRate = playbackRate;
    }, [playbackRate]);

    // Esc also exits, matching native full-screen conventions.
    useEffect(() => {
      if (!isFullscreen) return;
      function handleKeyDown(event: KeyboardEvent) {
        if (event.key === "Escape") setIsFullscreen(false);
      }
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }, [isFullscreen]);

    function toggleFullscreen() {
      setIsFullscreen((value) => !value);
    }

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
      if (!canAddSegment || markIn === null || markOut === null || !onAddSegment) return;
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
      <div
        className={cn(
          // `source-preview` is kept as a plain hook className (styled
          // entirely via the Tailwind utilities alongside it) because
          // `LessonSegmentsView`'s stylesheet still targets it directly via
          // `.lesson-segments-source-preview .source-preview` for a
          // side-by-side max-width override — see styles.css and this
          // phase's report for why that's left alone rather than migrated.
          "source-preview relative my-3 mb-5 max-w-2xl",
          controlsLayout === "minimal" && "mx-auto",
          // `source-preview-fullscreen` is a plain hook className (no styles
          // of its own) so styles.css can override `LessonSegmentsView`'s
          // shared-height rule below it — that rule is unlayered CSS and
          // would otherwise always beat the Tailwind `max-h-[82vh]` utility
          // on the <video> regardless of specificity (CSS cascade layers:
          // unlayered author styles win over any `@layer`-declared ones).
          isFullscreen &&
            "source-preview-fullscreen fixed inset-0 z-[1000] flex max-w-none flex-col justify-center bg-black p-4",
        )}
      >
        {controlsLayout === "minimal" && (
          <div className="mb-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
            <KeyboardShortcutHints />
          </div>
        )}

        <div
          className={cn(
            "flex gap-3",
            controlsLayout === "side" ? "flex-wrap items-start" : "flex-col",
          )}
        >
          <div className="min-w-0 flex-1">
            <video
              ref={videoRef}
              src={convertFileSrc(filePath)}
              // `source-preview-video` is likewise kept as a hook className —
              // `LessonSegmentsView`'s stylesheet forces this element to a
              // shared height alongside `LessonPreviewPlayer`'s video via
              // `.lesson-segments-preview-row .source-preview-video`.
              className={cn(
                "source-preview-video block max-h-[30vh] w-full bg-black",
                isFullscreen && "h-auto max-h-[82vh] w-full",
              )}
              onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
              onTimeUpdate={handleTimeUpdate}
              onPlay={() => setIsPaused(false)}
              onPause={() => setIsPaused(true)}
            />

            {/* Replaces native `<video controls>` (dropped above — shadow DOM
               controls can't carry the yellow segment-highlight overlay, see
               the scrubber below). This is the only seekbar now. */}
            <div className="mt-1.5 flex items-center gap-2.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={togglePlayPause}
                aria-label={isPaused ? "Play" : "Pause"}
              >
                {isPaused ? <Play /> : <Pause />}
              </Button>
              <span className="text-sm tabular-nums opacity-75">
                {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
              </span>
              <Select value={String(playbackRate)} onValueChange={(value) => setPlaybackRate(Number(value))}>
                <SelectTrigger size="sm" className="ml-auto" aria-label="Playback speed">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
                    <SelectItem key={rate} value={String(rate)}>
                      {rate}x
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant={isFullscreen ? "secondary" : "ghost"}
                size="icon"
                aria-pressed={isFullscreen}
                aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
                onClick={toggleFullscreen}
              >
                {isFullscreen ? <Minimize2 /> : <Maximize />}
              </Button>
            </div>

            <SegmentedScrubber
              className="mt-1.5"
              min={0}
              max={duration || 0}
              step={FRAME_STEP_SECONDS}
              value={Math.min(currentTime, duration || currentTime)}
              onChange={handleScrub}
              aria-label="Scrub source video"
              segments={selectedLessonSegments}
              duration={duration}
            />
          </div>

          {controlsLayout !== "minimal" && (
            <div
              className={cn(
                "flex flex-col gap-1",
                controlsLayout === "side" && "w-full sm:w-44 sm:shrink-0 sm:pt-1",
              )}
            >
              {controlsLayout === "side" && (
                <div className="mb-1 flex flex-col gap-1">
                  <KeyboardShortcutHints />
                </div>
              )}

              {hasSelectedLesson ? (
                <div
                  className={cn(
                    "flex items-center gap-2",
                    controlsLayout === "side" ? "mt-2 flex-col items-stretch" : "flex-wrap",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setMarkIn(currentTime)}
                    >
                      Mark In
                    </Button>
                    <span className="text-sm tabular-nums opacity-75">
                      {markIn !== null ? formatTimestamp(markIn) : "—"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setMarkOut(currentTime)}
                    >
                      Mark Out
                    </Button>
                    <span className="text-sm tabular-nums opacity-75">
                      {markOut !== null ? formatTimestamp(markOut) : "—"}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canAddSegment}
                    onClick={() => void handleAddSegment()}
                  >
                    Add segment
                  </Button>
                </div>
              ) : (
                <p className="mt-2 text-xs opacity-60">Select a lesson below to add a segment to it.</p>
              )}

              {addSegmentError && (
                <Alert variant="destructive" className="mt-2">
                  <AlertDescription>{addSegmentError}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </div>
      </div>
    );
  },
);

export default SourceVideoPreview;
