import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { LessonSegment } from "../db";

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

interface LessonPreviewPlayerProps {
  videoFilePath: string;
  segments: LessonSegment[];
  /** Lesson title, used only for the scrubber's `aria-label`. */
  lessonTitle: string;
  /** Mirrors the video's real (source-file) `currentTime` up to the parent
   * — needed by callers that support "at playhead" actions (trim/split),
   * which operate on the real time, not the virtual stitched-timeline one
   * this component shows in its own scrubber/readout. */
  onTimeUpdate?: (time: number) => void;
}

/** The lesson-preview video + its custom controls — factored out of
 * `LessonCard` so the same "virtually stitch this lesson's segments
 * together" preview (see that component's module doc, and the
 * conversation that led to it) can be reused standalone on a lesson's own
 * detail page, not just inside the grid tile. Always mounted by the
 * caller; owns no segment-editing state itself, only playback. */
export default function LessonPreviewPlayer({
  videoFilePath,
  segments,
  lessonTitle,
  onTimeUpdate,
}: LessonPreviewPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPaused, setIsPaused] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  // YouTube-style size modes: "small" is this component's normal inline
  // size (unchanged), "wide" breaks it out of the surrounding layout into a
  // fixed, centered, oversized overlay (see the CSS) — a lighter-weight
  // "theater mode" than full screen. "Full screen" is the native browser
  // API instead of a mode of its own, since it isn't something React state
  // can drive directly — `isFullscreen` below just mirrors it for the
  // button's pressed state.
  const [sizeMode, setSizeMode] = useState<"small" | "wide">("small");
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Index (into `segments`, in `sort_order`) of the segment currently being
  // played/looped. Advances to the next segment once playback reaches the
  // active one's `end`; wraps back to 0 after the last segment. Mirrored
  // into a ref alongside the state so `handleTimeUpdate` always reads the
  // latest value synchronously within the same tick.
  const activeIndexRef = useRef(0);
  const [activeIndex, setActiveIndexState] = useState(0);
  // Armed only once, on this component's initial mount (see the mount
  // effect below) — never re-armed when `segments` changes identity after
  // a caller-side refetch, since that shouldn't snap the playhead back to
  // the first segment's start out from under the user's current position.
  const pendingAutoSeekRef = useRef(false);

  function setActiveIndex(index: number) {
    activeIndexRef.current = index;
    setActiveIndexState(index);
  }

  useEffect(() => {
    pendingAutoSeekRef.current = true;
  }, []);

  // The video element persists for this component's whole lifetime (only
  // `currentTime` moves between segments, `src` never changes), so setting
  // `playbackRate` here is enough — no need to re-apply it on segment
  // advance or seek.
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  // Mirrors the browser's actual full-screen state (rather than tracking
  // one locally set-and-forget on click) so it also updates correctly when
  // the user exits via Esc instead of the button.
  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void containerRef.current?.requestFullscreen();
    }
  }

  // A fresh `segments` array (new fetch, e.g. after an edit elsewhere)
  // resets which one is "active" — the old index may no longer be valid
  // (a segment could have been deleted) and there's no way to know which
  // segment the caller intends to be current without a matching id.
  useEffect(() => {
    setActiveIndex(0);
  }, [segments]);

  // Auto-seek to the first segment's start once, right after mount and
  // this component's first non-empty `segments`, so playback starts on the
  // lesson's own footage rather than at the video's t=0.
  useEffect(() => {
    if (!pendingAutoSeekRef.current) return;
    if (segments.length === 0) return;
    if (!videoRef.current) return;
    videoRef.current.currentTime = segments[0].start;
    pendingAutoSeekRef.current = false;
  }, [segments]);

  // Cumulative virtual-timeline duration *before* each segment — e.g. for
  // segments [10-15), [30-42) this is [0, 5]: segment 0 starts at virtual
  // t=0, segment 1 starts at virtual t=5 (segment 0's own 5s length). This
  // is what lets the scrubber below show/seek a single stitched-together
  // timeline instead of the source file's full duration.
  const segmentOffsets = useMemo(() => {
    let acc = 0;
    return segments.map((segment) => {
      const offset = acc;
      acc += segment.end - segment.start;
      return offset;
    });
  }, [segments]);
  const lastSegment = segments.length === 0 ? null : segments[segments.length - 1];
  const totalVirtualDuration =
    lastSegment === null ? 0 : segmentOffsets[segments.length - 1] + (lastSegment.end - lastSegment.start);
  const activeSegment = segments[activeIndex] ?? null;
  const virtualCurrentTime = activeSegment
    ? segmentOffsets[activeIndex] +
      Math.min(Math.max(currentTime, activeSegment.start), activeSegment.end) -
      activeSegment.start
    : 0;

  function handleTimeUpdate(event: React.SyntheticEvent<HTMLVideoElement>) {
    const time = event.currentTarget.currentTime;
    setCurrentTime(time);
    onTimeUpdate?.(time);
    if (segments.length === 0) return;
    const segment = segments[activeIndexRef.current];
    if (!segment) return;
    if (time >= segment.end) {
      const nextIndex = (activeIndexRef.current + 1) % segments.length;
      setActiveIndex(nextIndex);
      event.currentTarget.currentTime = segments[nextIndex].start;
    }
  }

  function togglePlayPause() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }

  // The only seek control on this preview — drags across the *virtual*
  // (stitched-segments) timeline built from `segmentOffsets` above, and
  // translates that back to a real time within whichever segment it lands
  // in. Since this is the sole way to seek this video (no native
  // controls), playback can never land outside the lesson's own segments.
  function handleVirtualScrub(event: React.ChangeEvent<HTMLInputElement>) {
    const virtualTime = Number(event.target.value);
    let index = segments.findIndex((segment, i) => {
      const length = segment.end - segment.start;
      return virtualTime >= segmentOffsets[i] && virtualTime < segmentOffsets[i] + length;
    });
    if (index === -1) index = segments.length - 1;
    const segment = segments[index];
    if (!segment || !videoRef.current) return;
    const realTime = segment.start + (virtualTime - segmentOffsets[index]);
    videoRef.current.currentTime = realTime;
    setCurrentTime(realTime);
    onTimeUpdate?.(realTime);
    setActiveIndex(index);
  }

  return (
    <div
      ref={containerRef}
      className={
        "lesson-card-player" +
        (sizeMode === "wide" ? " lesson-card-player-wide" : "") +
        (isFullscreen ? " lesson-card-player-fullscreen" : "")
      }
    >
      <video
        ref={videoRef}
        src={convertFileSrc(videoFilePath)}
        className="lesson-card-video"
        onTimeUpdate={handleTimeUpdate}
        onPlay={() => setIsPaused(false)}
        onPause={() => setIsPaused(true)}
      />

      <div className="lesson-card-controls-row">
        <button
          type="button"
          className="lesson-card-play-button"
          disabled={segments.length === 0}
          onClick={togglePlayPause}
          aria-label={isPaused ? "Play" : "Pause"}
        >
          {isPaused ? "▶" : "⏸"}
        </button>
        <span className="lesson-card-time-readout">
          {formatDuration(virtualCurrentTime)} / {formatDuration(totalVirtualDuration)}
        </span>
        <select
          className="lesson-card-speed-select"
          value={playbackRate}
          onChange={(event) => setPlaybackRate(Number(event.target.value))}
          aria-label="Playback speed"
        >
          {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
            <option key={rate} value={rate}>
              {rate}x
            </option>
          ))}
        </select>
        <div className="lesson-card-size-controls">
          <button
            type="button"
            aria-pressed={sizeMode === "small"}
            aria-label="Small player"
            onClick={() => setSizeMode("small")}
          >
            ▭
          </button>
          <button
            type="button"
            aria-pressed={sizeMode === "wide"}
            aria-label="Wide player"
            onClick={() => setSizeMode(sizeMode === "wide" ? "small" : "wide")}
          >
            ▬
          </button>
          <button
            type="button"
            aria-pressed={isFullscreen}
            aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
            onClick={toggleFullscreen}
          >
            {isFullscreen ? "⤢" : "⛶"}
          </button>
        </div>
      </div>

      <input
        type="range"
        className="lesson-card-scrubber"
        min={0}
        max={totalVirtualDuration}
        step={0.01}
        value={Math.min(virtualCurrentTime, totalVirtualDuration)}
        disabled={segments.length === 0}
        onChange={handleVirtualScrub}
        aria-label={`Scrub lesson ${lessonTitle}`}
      />
    </div>
  );
}
