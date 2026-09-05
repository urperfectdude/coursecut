import { useEffect, useState } from "react";

export interface ContainedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Tracks the actual on-screen rect of `video`'s *content* within
 * `container`'s box — i.e. what `object-fit: contain` (the letterboxing
 * both `SourceVideoPreview` and `LessonPreviewPlayer` use, via
 * `.lesson-segments-preview-row .source-preview-video`/`.lesson-card-video`
 * in styles.css, to keep two differently-shaped recordings the same
 * height) actually renders the video into, as opposed to `container`'s own
 * (usually wider/taller) box.
 *
 * Needed because a plain percentage-of-container overlay `<img>` — the
 * naive first cut — sizes itself against the *box*, not the letterboxed
 * *content*, so it ends up a different (wrong) aspect ratio than the video
 * itself whenever the video's own aspect ratio doesn't match the box's
 * (which `object-fit: contain` exists specifically to handle without
 * distorting the video — the overlay needs the same treatment). Returns
 * `null` until the video's intrinsic dimensions are known (before
 * `loadedmetadata`) or if either ref isn't attached yet.
 *
 * Recomputes on any container resize (window resize, fullscreen toggle,
 * flex layout changes) via `ResizeObserver`, not just once on mount. */
export function useContainedVideoRect(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  // Bumped by the caller's `onLoadedMetadata` to force a recompute once
  // `video.videoWidth`/`.videoHeight` become available — a plain mount-time
  // effect would run before that, seeing 0x0.
  metadataVersion: number,
) {
  const [rect, setRect] = useState<ContainedRect | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!container || !video) return;

    function recalc() {
      const video = videoRef.current;
      const container = containerRef.current;
      if (!video || !container || !video.videoWidth || !video.videoHeight) {
        setRect(null);
        return;
      }
      const boxW = container.clientWidth;
      const boxH = container.clientHeight;
      if (boxW <= 0 || boxH <= 0) {
        setRect(null);
        return;
      }
      const videoAspect = video.videoWidth / video.videoHeight;
      const boxAspect = boxW / boxH;
      let width: number;
      let height: number;
      if (videoAspect > boxAspect) {
        width = boxW;
        height = boxW / videoAspect;
      } else {
        height = boxH;
        width = boxH * videoAspect;
      }
      setRect({ left: (boxW - width) / 2, top: (boxH - height) / 2, width, height });
    }

    recalc();
    const observer = new ResizeObserver(recalc);
    observer.observe(container);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadataVersion]);

  return rect;
}
