import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Maximize, Minimize2, Pause, Play } from "lucide-react";
import type { CropInput, LessonSegment, LessonSlide } from "../db";
import { formatTimestamp } from "../lib/timestamp";
import { useContainedVideoRect } from "../lib/useContainedVideoRect";
import SegmentedScrubber from "./SegmentedScrubber";
import { activeRegions, RectOutline, ShapeLayers, type PercentRect, type PreviewRegion } from "./RegionLayers";
import { CropBoxEditor, cropScreenGeometry, resolveCropLayout } from "./CropLayers";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

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
  /** Mirrors this component's own *virtual* (stitched-lesson) current time
   * up to the parent — needed for placing a new `frame_overlays` row at
   * "wherever the user is looking in the Final video," since overlays are
   * now timed in this same virtual coordinate space (see `overlays` below)
   * rather than the source recording's real seconds. */
  onVirtualTimeUpdate?: (time: number) => void;
  /** This lesson's image-overlay ranges (`frame_overlays`, lesson-scoped
   * since `0009_frame_overlay_lesson_scoped.sql`), with `start`/`end`
   * already in this component's own virtual (stitched) timeline — no
   * translation needed against `segmentOffsets` the way a real-time-based
   * range would (that translation now happens once, at export time, in
   * `export.rs`'s `overlays_for_segment`, not here). Used two ways: as a
   * live `<img>` composited over the video (gated on `virtualCurrentTime`),
   * and as amber marker bands directly on this component's own scrubber. */
  overlays?: {
    id: string;
    image_path: string;
    start: number;
    end: number;
    scale_percent: number;
    x_percent: number;
    y_percent: number;
  }[];
  /** Shape layers (`lesson_regions`) in virtual seconds: previewed live as
   * blurred/solid boxes and drawn as a band on the scrubber. */
  regions?: PreviewRegion[];
  /** When set, dragging on the frame draws a rect (percent of the frame)
   * and reports it via `onDraw`. */
  drawRect?: { onDraw: (rect: PercentRect) => void };
  /** A dashed outline over the frame, e.g. the region being edited. */
  outlineRect?: PercentRect | null;
  /** The lesson's crop. When enabled, the frame is shown composed like the
   * export (cropped picture centred on the background, with its shadow),
   * except while `cropEdit` or `drawRect` is set: those work on the
   * uncropped source frame. */
  crop?: CropInput | null;
  /** When set (the Crop tab), the uncropped frame shows with an editable
   * crop box (percent of the source frame), reported via `onChange`.
   * Image overlays and overlay-mode slides are hidden meanwhile, since
   * they belong on the composed frame. */
  cropEdit?: { rect: PercentRect; onChange: (rect: PercentRect) => void } | null;
  /** The lesson's intro/outro slides. Overlay-mode ones show full-frame over
   * the first/last `duration` virtual seconds (muting the video there if
   * `mute_audio`) and get a scrubber band. Inserted ones take no virtual
   * time: the intro is held on screen for its duration when Play is pressed
   * at the start, the outro once playback reaches the end. */
  slides?: Pick<LessonSlide, "id" | "position" | "mode" | "duration" | "image_path" | "mute_audio">[];
  /** Reports the video's pixel size once its metadata has loaded. */
  onVideoSize?: (size: { width: number; height: number }) => void;
  /** An AI voice track (a WAV on the lesson's timeline, see `voice.rs`).
   * When set, the recording is muted and the track plays in sync. */
  voiceTrackPath?: string | null;
  /** Called every animation frame with the source-time playhead, for the
   * word highlight (no React render per frame). */
  onFrameTime?: (time: number, playing: boolean) => void;
}

export interface LessonPreviewPlayerHandle {
  /** Seeks to a source time inside the lesson: the first segment (in lesson
   * order) containing it. Ignored if no segment does. */
  seekToSource: (time: number) => void;
  pause: () => void;
}

type PreviewSlide = NonNullable<LessonPreviewPlayerProps["slides"]>[number];

/** The lesson-preview video + its custom controls — factored out of
 * `LessonCard` so the same "virtually stitch this lesson's segments
 * together" preview (see that component's module doc, and the
 * conversation that led to it) can be reused standalone on a lesson's own
 * detail page, not just inside the grid tile. On the lesson page it stays
 * mounted (hidden while the Original recording shows); owns no
 * segment-editing state itself, only playback. */
const LessonPreviewPlayer = forwardRef<LessonPreviewPlayerHandle, LessonPreviewPlayerProps>(function LessonPreviewPlayer({
  videoFilePath,
  segments,
  lessonTitle,
  onTimeUpdate,
  onVirtualTimeUpdate,
  overlays = [],
  regions = [],
  drawRect,
  outlineRect = null,
  crop = null,
  cropEdit = null,
  slides = [],
  onVideoSize,
  onFrameTime,
  voiceTrackPath = null,
}: LessonPreviewPlayerProps, ref) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayContainerRef = useRef<HTMLDivElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  // Bumped on `loadedmetadata` to tell `useContainedVideoRect` the video's
  // intrinsic dimensions are now readable — see that hook.
  const [metadataVersion, setMetadataVersion] = useState(0);
  const contentRect = useContainedVideoRect(videoRef, overlayContainerRef, metadataVersion);
  // The video's intrinsic size, to scale the blur preview and the crop to
  // source pixels.
  const [videoWidth, setVideoWidth] = useState(0);
  const [videoHeight, setVideoHeight] = useState(0);
  // Drag state while drawing a rect (`drawRect`): anchor and current rect,
  // both in percent of the frame.
  const [dragAnchor, setDragAnchor] = useState<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<PercentRect | null>(null);
  const [isPaused, setIsPaused] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  // A CSS-driven full-viewport overlay rather than the native browser
  // Fullscreen API — Tauri's WKWebView on macOS doesn't support
  // `element.requestFullscreen()` for arbitrary elements, so that call
  // silently no-ops there.
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
  // An inserted intro/outro currently held on screen in place of the video
  // (see `startHold`), and the timer that ends the hold.
  const [hold, setHold] = useState<PreviewSlide | null>(null);
  const holdTimerRef = useRef<number | null>(null);

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

  // A fresh `segments` array (an edit, e.g. a Script tab cut) keeps the
  // playhead where it is: the active row becomes the one containing it.
  // If the playhead is now in a cut-out part, it moves to the next row
  // that starts after it (or the first row). Before any playback, row 0.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || segments.length === 0 || pendingAutoSeekRef.current) {
      setActiveIndex(0);
      return;
    }
    const time = video.currentTime;
    const inside = segments.findIndex((segment) => time >= segment.start && time < segment.end);
    if (inside >= 0) {
      setActiveIndex(inside);
      return;
    }
    let next = -1;
    segments.forEach((segment, i) => {
      if (segment.start >= time && (next < 0 || segment.start < segments[next].start)) next = i;
    });
    const index = next >= 0 ? next : 0;
    setActiveIndex(index);
    video.currentTime = segments[index].start;
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

  useEffect(() => {
    onVirtualTimeUpdate?.(virtualCurrentTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualCurrentTime]);

  // Live-preview approximation of the export-time compositing — whichever
  // overlay(s) contain the current *virtual* playhead position. `overlays`
  // is already in this same virtual coordinate space (lesson-scoped since
  // the frame-overlay rework), so no translation is needed here — unlike
  // the old video-scoped/real-time design, which needed a whole
  // `segmentOffsets`-based translation step just to place markers on this
  // scrubber (removed; `markers={overlays}` below is now direct).
  const activeOverlays = overlays.filter(
    (overlay) => virtualCurrentTime >= overlay.start && virtualCurrentTime < overlay.end,
  );

  const currentRegions = activeRegions(regions, virtualCurrentTime);

  // The composed crop's on-screen geometry, while it applies (see `crop`).
  const cropView =
    crop?.enabled && !cropEdit && !drawRect && contentRect && videoWidth > 0 && videoHeight > 0
      ? cropScreenGeometry(contentRect, resolveCropLayout(crop, videoWidth, videoHeight), videoWidth, videoHeight)
      : null;

  // Overlay-mode slides' windows on the virtual timeline, clamped to the
  // lesson's length, same as the export's `overlay_slide_windows`.
  const overlaySlideWindows = useMemo(() => {
    if (totalVirtualDuration <= 0) return [];
    return slides
      .filter((slide) => slide.mode === "overlay")
      .map((slide) => {
        const length = Math.min(slide.duration, totalVirtualDuration);
        const start = slide.position === "intro" ? 0 : totalVirtualDuration - length;
        return { ...slide, start, end: start + length };
      });
  }, [slides, totalVirtualDuration]);
  const activeOverlaySlides = overlaySlideWindows.filter(
    (slide) => virtualCurrentTime >= slide.start && virtualCurrentTime < slide.end,
  );
  const overlaySlideMuted = activeOverlaySlides.some((slide) => slide.mute_audio);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = overlaySlideMuted || voiceTrackPath !== null;
  }, [overlaySlideMuted, voiceTrackPath]);

  const insertedIntro = slides.find((slide) => slide.mode === "insert" && slide.position === "intro") ?? null;
  const insertedOutro = slides.find((slide) => slide.mode === "insert" && slide.position === "outro") ?? null;

  function clearHold() {
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    setHold(null);
  }

  useEffect(
    () => () => {
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    },
    [],
  );

  // Pauses the video and shows `slide` in its place for its duration (scaled
  // by the playback speed), then runs `then`.
  function startHold(slide: PreviewSlide, then: () => void) {
    videoRef.current?.pause();
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    setHold(slide);
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      setHold(null);
      then();
    }, (slide.duration * 1000) / playbackRate);
  }

  function playVideo() {
    void videoRef.current?.play();
  }

  // Pointer position over the content rect, in percent of the frame.
  function pointerPercent(event: React.PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const clamp = (value: number) => Math.min(100, Math.max(0, value));
    return {
      x: clamp(((event.clientX - box.left) / box.width) * 100),
      y: clamp(((event.clientY - box.top) / box.height) * 100),
    };
  }

  // The rect spanned by the drag anchor and the pointer.
  function rectFromDrag(anchor: { x: number; y: number }, point: { x: number; y: number }): PercentRect {
    return {
      x: Math.min(anchor.x, point.x),
      y: Math.min(anchor.y, point.y),
      w: Math.abs(point.x - anchor.x),
      h: Math.abs(point.y - anchor.y),
    };
  }

  /** Moves playback to the start of the next segment (wrapping). */
  function advanceToNextSegment(video: HTMLVideoElement) {
    const nextIndex = (activeIndexRef.current + 1) % segments.length;
    setActiveIndex(nextIndex);
    video.currentTime = segments[nextIndex].start;
    // Wrapping back to the start: play the inserted outro first, then the
    // intro, as the exported file would end and (on replay) begin.
    if (nextIndex === 0 && insertedOutro && !video.paused) {
      startHold(insertedOutro, () => (insertedIntro ? startHold(insertedIntro, playVideo) : playVideo()));
    }
  }

  function handleTimeUpdate(event: React.SyntheticEvent<HTMLVideoElement>) {
    const time = event.currentTarget.currentTime;
    setCurrentTime(time);
    onTimeUpdate?.(time);
    if (segments.length === 0) return;
    const segment = segments[activeIndexRef.current];
    if (!segment) return;
    if (time >= segment.end) advanceToNextSegment(event.currentTarget);
  }

  // Per-frame loop (the approach of Rescript v1.0.9's MediaPreview playback
  // loop): moves on at a segment's end within a frame rather than on the
  // next `timeupdate` (~250 ms later, audible when a Script cut sits right
  // there), and reports the playhead for the word highlight. Latest props
  // and the advance step go through refs, so the loop starts once.
  const frameRef = useRef({ onFrameTime, segments, advance: advanceToNextSegment });
  frameRef.current = { onFrameTime, segments, advance: advanceToNextSegment };
  const frameLoopWanted = onFrameTime !== undefined;
  useEffect(() => {
    if (!frameLoopWanted) return;
    let raf = 0;
    let lastTime = -1;
    let lastPlaying = false;
    const tick = () => {
      const video = videoRef.current;
      const { onFrameTime: report, segments: segs, advance } = frameRef.current;
      if (video) {
        const playing = !video.paused;
        const segment = segs[activeIndexRef.current];
        if (playing && segment && video.currentTime >= segment.end) advance(video);
        const time = video.currentTime;
        if (time !== lastTime || playing !== lastPlaying) {
          lastTime = time;
          lastPlaying = playing;
          report?.(time, playing);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frameLoopWanted]);

  // AI voice: keeps the track at the lesson-time playhead every frame. The
  // lesson time runs on across segment joins, so the track only needs a
  // seek after a user seek (or drift), not at each join. Paused while an
  // inserted slide holds the screen.
  const voiceRef = useRef<HTMLAudioElement | null>(null);
  const voiceSyncRef = useRef({ segments, segmentOffsets, playbackRate, holding: hold !== null, muted: false });
  voiceSyncRef.current = {
    segments,
    segmentOffsets,
    playbackRate,
    holding: hold !== null,
    // Silent under an overlay slide set to mute, as the recording would be.
    muted: overlaySlideMuted,
  };
  useEffect(() => {
    if (!voiceTrackPath) return;
    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      const audio = voiceRef.current;
      const { segments: segs, segmentOffsets: offsets, playbackRate: rate, holding, muted } = voiceSyncRef.current;
      const segment = segs[activeIndexRef.current];
      if (audio && audio.muted !== muted) audio.muted = muted;
      if (video && audio && segment && (video.seeking || video.readyState < 3)) {
        // Jumping to the next row, or buffering: the lesson time is held
        // at the old row's end meanwhile, so wait rather than re-seek the
        // voice back (it would repeat a fragment at every cut).
        if (!audio.paused) audio.pause();
      } else if (video && audio && segment) {
        const lessonTime =
          offsets[activeIndexRef.current] + Math.min(Math.max(video.currentTime, segment.start), segment.end) - segment.start;
        if (!video.paused && !holding) {
          if (audio.playbackRate !== rate) audio.playbackRate = rate;
          if (Math.abs(audio.currentTime - lessonTime) > 0.15) audio.currentTime = lessonTime;
          if (audio.paused) void audio.play().catch(() => undefined);
        } else {
          if (!audio.paused) audio.pause();
          if (Math.abs(audio.currentTime - lessonTime) > 0.05) audio.currentTime = lessonTime;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const audio = voiceRef.current;
    return () => {
      cancelAnimationFrame(raf);
      audio?.pause();
    };
  }, [voiceTrackPath]);

  useImperativeHandle(ref, () => ({
    seekToSource(time: number) {
      const index = segments.findIndex((segment) => time >= segment.start && time < segment.end);
      const video = videoRef.current;
      if (index < 0 || !video) return;
      clearHold();
      setActiveIndex(index);
      video.currentTime = time;
      setCurrentTime(time);
      onTimeUpdate?.(time);
    },
    pause() {
      clearHold();
      videoRef.current?.pause();
    },
  }));

  function togglePlayPause() {
    const video = videoRef.current;
    if (!video) return;
    if (hold) {
      clearHold();
      return;
    }
    if (video.paused) {
      const atStart = activeIndexRef.current === 0 && virtualCurrentTime < 0.05;
      if (insertedIntro && atStart) startHold(insertedIntro, playVideo);
      else playVideo();
    } else video.pause();
  }

  // The only seek control on this preview — drags across the *virtual*
  // (stitched-segments) timeline built from `segmentOffsets` above, and
  // translates that back to a real time within whichever segment it lands
  // in. Since this is the sole way to seek this video (no native
  // controls), playback can never land outside the lesson's own segments.
  function handleVirtualScrub(event: React.ChangeEvent<HTMLInputElement>) {
    const virtualTime = Number(event.target.value);
    clearHold();
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
      className={cn(
        "relative",
        // `lesson-card-player-fullscreen` is a plain hook className (no
        // styles of its own) so styles.css can override
        // `LessonSegmentsView`'s shared-height rule below it — see the
        // matching comment in `SourceVideoPreview.tsx`.
        isFullscreen &&
          "lesson-card-player-fullscreen fixed inset-0 z-[1000] flex max-w-none flex-col justify-center bg-black p-4",
      )}
    >
      <div ref={overlayContainerRef} className="relative">
        {/* Composed crop: the background and the picture's shadow go under
           the video, which is itself clipped to the crop and moved onto the
           fitted box (a transformed element paints above earlier positioned
           siblings), so `contentRect` and everything placed on it stay as
           they are. */}
        {cropView && contentRect && crop && (
          // Clipped to the frame, like the export: a big blur or offset
          // never reaches the letterbox bars.
          <div
            aria-hidden="true"
            className="pointer-events-none absolute overflow-hidden"
            style={{
              left: contentRect.left,
              top: contentRect.top,
              width: contentRect.width,
              height: contentRect.height,
              backgroundColor: crop.bg_color,
            }}
          >
            {crop.shadow_enabled && (
              <div
                className="absolute"
                style={{
                  left: cropView.box.left - contentRect.left,
                  top: cropView.box.top - contentRect.top,
                  width: cropView.box.width,
                  height: cropView.box.height,
                  boxShadow: `0 ${crop.shadow_offset_y * cropView.pixelScale}px ${
                    crop.shadow_blur * cropView.pixelScale
                  }px rgba(0, 0, 0, ${crop.shadow_opacity})`,
                }}
              />
            )}
          </div>
        )}
        <video
          ref={videoRef}
          src={convertFileSrc(videoFilePath)}
          // `lesson-card-video` is kept as a plain hook className (styled
          // entirely via the Tailwind utilities alongside it) because
          // `LessonSegmentsView`'s stylesheet forces this element to a shared
          // height alongside `SourceVideoPreview`'s video via
          // `.lesson-editor-player .lesson-card-video` — see
          // styles.css and this phase's report.
          className={cn(
            "lesson-card-video block max-h-[25vh] w-full bg-black",
            isFullscreen && "h-auto max-h-[82vh] w-full",
          )}
          style={
            cropView ? { transform: cropView.transform, transformOrigin: "0 0", clipPath: cropView.clipPath } : undefined
          }
          onLoadedMetadata={(event) => {
            setMetadataVersion((v) => v + 1);
            setVideoWidth(event.currentTarget.videoWidth);
            setVideoHeight(event.currentTarget.videoHeight);
            onVideoSize?.({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight });
          }}
          onTimeUpdate={handleTimeUpdate}
          onPlay={() => setIsPaused(false)}
          onPause={() => setIsPaused(true)}
        />
        {voiceTrackPath && <audio ref={voiceRef} src={convertFileSrc(voiceTrackPath)} preload="auto" />}
        {/* Before the overlay images, matching the export's chain order
           (shapes -> image overlays). */}
        {/* Shapes are in source-frame percent, so with a crop they move with
           the cropped picture, clipped to it. */}
        {cropView ? (
          <div className="pointer-events-none absolute overflow-hidden" style={cropView.box}>
            <ShapeLayers rect={cropView.sourceRect} regions={currentRegions} pixelScale={cropView.contentScale} />
          </div>
        ) : (
          contentRect &&
          videoWidth > 0 && (
            <ShapeLayers rect={contentRect} regions={currentRegions} pixelScale={contentRect.width / videoWidth} />
          )
        )}
        {/* Positioned against `contentRect` (the video's actual letterboxed
           content area — see `useContainedVideoRect`), same reasoning as
           `SourceVideoPreview`'s identical block. */}
        {contentRect &&
          !cropEdit &&
          activeOverlays.map((overlay) => {
            const width = contentRect.width * (overlay.scale_percent / 100);
            const height = contentRect.height * (overlay.scale_percent / 100);
            return (
              <img
                key={overlay.id}
                src={convertFileSrc(overlay.image_path)}
                alt=""
                className="pointer-events-none absolute object-contain"
                style={{
                  left: contentRect.left + (contentRect.width - width) * (overlay.x_percent / 100),
                  top: contentRect.top + (contentRect.height - height) * (overlay.y_percent / 100),
                  width,
                  height,
                }}
              />
            );
          })}
        {/* Overlay-mode intro/outro, full-frame on top of everything, like
           the export; an inserted one while it's held. */}
        {contentRect &&
          [...(cropEdit ? [] : activeOverlaySlides), ...(hold ? [hold] : [])].map((slide) => (
            <img
              key={`${slide.id}-${slide === hold ? "hold" : "overlay"}`}
              src={convertFileSrc(slide.image_path)}
              alt=""
              className="pointer-events-none absolute bg-black object-contain"
              style={{
                left: contentRect.left,
                top: contentRect.top,
                width: contentRect.width,
                height: contentRect.height,
              }}
            />
          ))}
        {contentRect && (hold ?? (isPaused && virtualCurrentTime < 0.05 ? insertedIntro : null)) && (
          <span
            className="pointer-events-none absolute rounded bg-black/70 px-1.5 py-0.5 text-xs text-white"
            style={{ left: contentRect.left + 6, top: contentRect.top + 6 }}
          >
            {hold
              ? `${hold.position === "intro" ? "Intro" : "Outro"} · ${hold.duration}s`
              : `Intro · ${insertedIntro?.duration}s plays first`}
          </span>
        )}
        {contentRect && cropEdit && (
          <CropBoxEditor rect={contentRect} percentRect={cropEdit.rect} onChange={cropEdit.onChange} />
        )}
        {contentRect && !cropEdit && (dragRect ?? outlineRect) && (
          <RectOutline rect={contentRect} percentRect={(dragRect ?? outlineRect) as PercentRect} />
        )}
        {contentRect && drawRect && !cropEdit && (
          <div
            className="absolute cursor-crosshair touch-none"
            style={{ left: contentRect.left, top: contentRect.top, width: contentRect.width, height: contentRect.height }}
            title="Drag to draw the shape"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const point = pointerPercent(event);
              setDragAnchor(point);
              setDragRect({ x: point.x, y: point.y, w: 0, h: 0 });
            }}
            onPointerMove={(event) => {
              if (dragAnchor) setDragRect(rectFromDrag(dragAnchor, pointerPercent(event)));
            }}
            onPointerUp={(event) => {
              if (!dragAnchor) return;
              const rect = rectFromDrag(dragAnchor, pointerPercent(event));
              setDragAnchor(null);
              setDragRect(null);
              // Ignore a click without a real drag.
              if (rect.w >= 1 && rect.h >= 1) drawRect.onDraw(rect);
            }}
          />
        )}
      </div>

      <div className="mt-1 flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={segments.length === 0}
          onClick={togglePlayPause}
          aria-label={isPaused && !hold ? "Play" : "Pause"}
        >
          {isPaused && !hold ? <Play /> : <Pause />}
        </Button>
        <span className="text-sm tabular-nums opacity-75">
          {formatTimestamp(virtualCurrentTime)} / {formatTimestamp(totalVirtualDuration)}
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
        className="mt-1"
        min={0}
        max={totalVirtualDuration}
        step={0.01}
        value={Math.min(virtualCurrentTime, totalVirtualDuration)}
        disabled={segments.length === 0}
        onChange={handleVirtualScrub}
        aria-label={`Scrub lesson ${lessonTitle}`}
        markers={overlays}
        regionMarkers={regions}
        slideMarkers={overlaySlideWindows}
        duration={totalVirtualDuration}
      />
    </div>
  );
});

export default LessonPreviewPlayer;
