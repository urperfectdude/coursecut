import type { LessonRegion } from "../db";
import type { ContainedRect } from "../lib/useContainedVideoRect";

/** A shape layer as the preview players need it, with `start`/`end`
 * already in whichever clock that player runs on (virtual for
 * `LessonPreviewPlayer`, source for `SourceVideoPreview`). */
export type PreviewRegion = Pick<
  LessonRegion,
  | "id"
  | "start"
  | "end"
  | "x_percent"
  | "y_percent"
  | "w_percent"
  | "h_percent"
  | "shape"
  | "fill"
  | "blur_strength"
  | "color"
>;

/** A rect in percent of the frame, top-left + size. */
export interface PercentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Regions whose `[start, end)` contains `time`. */
export function activeRegions(regions: readonly PreviewRegion[], time: number): PreviewRegion[] {
  return regions.filter((region) => time >= region.start && time < region.end);
}

/** Absolutely positioned boxes for each active shape layer, placed against
 * the video's content rect. `pixelScale` is on-screen pixels per source
 * pixel.
 *
 * * blur: `backdrop-filter: blur()`. ffmpeg's `boxblur` with radius r and
 *   power 2 has a standard deviation of about 0.8r, and CSS `blur()` takes a
 *   standard deviation, so the preview uses 0.8 x the export's (capped)
 *   radius, scaled to screen pixels.
 * * solid: a plain background colour.
 * * rounded: `border-radius` of 20% of the shorter side, same as the export
 *   mask (`rounded_corner_radius` in ffmpeg.rs). ellipse: `border-radius: 50%`. */
export function ShapeLayers({
  rect,
  regions,
  pixelScale,
}: {
  rect: ContainedRect;
  regions: readonly PreviewRegion[];
  pixelScale: number;
}) {
  return (
    <>
      {regions.map((region) => {
        const width = (rect.width * region.w_percent) / 100;
        const height = (rect.height * region.h_percent) / 100;
        const style: React.CSSProperties = {
          left: rect.left + (rect.width * region.x_percent) / 100,
          top: rect.top + (rect.height * region.y_percent) / 100,
          width,
          height,
          borderRadius:
            region.shape === "ellipse" ? "50%" : region.shape === "rounded" ? Math.min(width, height) / 5 : 0,
        };
        if (region.fill === "solid") {
          style.backgroundColor = region.color;
        } else {
          const sourceSide = Math.min(width, height) / pixelScale;
          const radius = Math.max(0, Math.min(region.blur_strength, Math.floor(sourceSide / 2) - 1));
          const blur = `blur(${Math.max(1, 0.8 * radius * pixelScale)}px)`;
          style.backdropFilter = blur;
          style.WebkitBackdropFilter = blur;
        }
        return <div key={region.id} aria-hidden="true" className="pointer-events-none absolute" style={style} />;
      })}
    </>
  );
}

/** Dashed outline of `percentRect` over the content rect, marking the
 * region currently being drawn/edited. */
export function RectOutline({ rect, percentRect }: { rect: ContainedRect; percentRect: PercentRect }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute border-2 border-dashed border-sky-400"
      style={{
        left: rect.left + (rect.width * percentRect.x) / 100,
        top: rect.top + (rect.height * percentRect.y) / 100,
        width: (rect.width * percentRect.w) / 100,
        height: (rect.height * percentRect.h) / 100,
      }}
    />
  );
}
