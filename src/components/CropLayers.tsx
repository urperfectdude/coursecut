import { useRef } from "react";
import type { CropInput } from "../db";
import type { ContainedRect } from "../lib/useContainedVideoRect";
import type { PercentRect } from "./RegionLayers";

/** Smallest crop side, in percent of the source frame (`db.rs` checks the
 * same). */
export const MIN_CROP_PERCENT = 5;

/** The crop fields the layout needs. */
export type CropGeometry = Pick<CropInput, "x_percent" | "y_percent" | "w_percent" | "h_percent" | "padding_percent">;

/** A crop resolved to source pixels: the crop rect, the fitted picture's
 * size, and its centred top-left in the output frame. */
export interface CropLayout {
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  fitW: number;
  fitH: number;
  x: number;
  y: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Keeps a crop rect inside the frame and at least `MIN_CROP_PERCENT` a side. */
export function normalizeCropRect(rect: PercentRect): PercentRect {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const w = clamp(round2(rect.w), MIN_CROP_PERCENT, 100);
  const h = clamp(round2(rect.h), MIN_CROP_PERCENT, 100);
  return { x: clamp(round2(rect.x), 0, round2(100 - w)), y: clamp(round2(rect.y), 0, round2(100 - h)), w, h };
}

/** Same arithmetic as `ffmpeg.rs::resolve_crop`, so the preview lands on the
 * export's pixels: even crop rect inside the frame; padding = percent of the
 * shorter side; the crop scaled by one factor to fit inside the padded box;
 * centred, top-left rounded down to even. */
export function resolveCropLayout(crop: CropGeometry, mainW: number, mainH: number): CropLayout {
  const even = (value: number) => Math.floor(value / 2) * 2;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const size = (percent: number, main: number) => clamp(even(Math.round((main * percent) / 100)), 2, even(main));
  const cropW = size(crop.w_percent, mainW);
  const cropH = size(crop.h_percent, mainH);
  const pos = (percent: number, main: number, side: number) =>
    clamp(even(Math.round((main * percent) / 100)), 0, even(main - side));
  const cropX = pos(crop.x_percent, mainW, cropW);
  const cropY = pos(crop.y_percent, mainH, cropH);

  const padding = Math.round((Math.min(mainW, mainH) * crop.padding_percent) / 100);
  const availW = Math.max(2, even(mainW - 2 * padding));
  const availH = Math.max(2, even(mainH - 2 * padding));
  const factor = Math.min(availW / cropW, availH / cropH);
  const fitW = clamp(even(Math.round(cropW * factor)), 2, availW);
  const fitH = clamp(even(Math.round(cropH * factor)), 2, availH);
  return { cropX, cropY, cropW, cropH, fitW, fitH, x: even((mainW - fitW) / 2), y: even((mainH - fitH) / 2) };
}

/** Where the composed (cropped) picture goes on screen, for a `<video>`
 * whose content rect is `rect` inside an element of the same centre (the
 * `object-fit: contain` box `useContainedVideoRect` measures):
 *
 * * `box`: the fitted picture, in container pixels.
 * * `transform` / `clipPath`: applied to the `<video>` element itself, so
 *   only the crop shows and it lands exactly on `box` (clip first, in the
 *   element's own coordinates, then translate + scale from its top-left).
 * * `sourceRect`: the whole source frame in `box`'s coordinates, for layers
 *   placed in source-frame percent (shapes) inside a clipping `box`.
 * * `pixelScale`: screen pixels per source pixel of the composed frame
 *   (shadow sizes); `contentScale`: the same for the cropped content. */
export function cropScreenGeometry(rect: ContainedRect, layout: CropLayout, mainW: number, mainH: number) {
  const s = rect.width / mainW;
  const kx = layout.fitW / layout.cropW;
  const ky = layout.fitH / layout.cropH;
  const box = {
    left: rect.left + layout.x * s,
    top: rect.top + layout.y * s,
    width: layout.fitW * s,
    height: layout.fitH * s,
  };
  const cropLeft = rect.left + layout.cropX * s;
  const cropTop = rect.top + layout.cropY * s;
  const clipPath = `inset(${cropTop}px ${rect.left + (mainW - layout.cropX - layout.cropW) * s}px ${
    rect.top + (mainH - layout.cropY - layout.cropH) * s
  }px ${cropLeft}px)`;
  const transform = `translate(${box.left - kx * cropLeft}px, ${box.top - ky * cropTop}px) scale(${kx}, ${ky})`;
  const sourceRect: ContainedRect = {
    left: -layout.cropX * s * kx,
    top: -layout.cropY * s * ky,
    width: rect.width * kx,
    height: rect.height * ky,
  };
  return { box, clipPath, transform, sourceRect, pixelScale: s, contentScale: s * kx };
}

type DragMode = "move" | "draw" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLES: { mode: DragMode; left: string; top: string; cursor: string }[] = [
  { mode: "nw", left: "0%", top: "0%", cursor: "nwse-resize" },
  { mode: "n", left: "50%", top: "0%", cursor: "ns-resize" },
  { mode: "ne", left: "100%", top: "0%", cursor: "nesw-resize" },
  { mode: "e", left: "100%", top: "50%", cursor: "ew-resize" },
  { mode: "se", left: "100%", top: "100%", cursor: "nwse-resize" },
  { mode: "s", left: "50%", top: "100%", cursor: "ns-resize" },
  { mode: "sw", left: "0%", top: "100%", cursor: "nesw-resize" },
  { mode: "w", left: "0%", top: "50%", cursor: "ew-resize" },
];

/** The rect after dragging `mode` by `(dx, dy)` percent from `start`
 * (`anchor` is where a "draw" began). Kept in the frame and at least
 * `MIN_CROP_PERCENT` a side; the opposite edge of a resize stays put. */
function dragRect(mode: DragMode, start: PercentRect, anchor: { x: number; y: number }, dx: number, dy: number): PercentRect {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  if (mode === "move") {
    return { ...start, x: clamp(start.x + dx, 0, 100 - start.w), y: clamp(start.y + dy, 0, 100 - start.h) };
  }
  if (mode === "draw") {
    const px = clamp(anchor.x + dx, 0, 100);
    const py = clamp(anchor.y + dy, 0, 100);
    return { x: Math.min(anchor.x, px), y: Math.min(anchor.y, py), w: Math.abs(px - anchor.x), h: Math.abs(py - anchor.y) };
  }
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (mode.includes("w")) left = clamp(left + dx, 0, right - MIN_CROP_PERCENT);
  if (mode.includes("e")) right = clamp(right + dx, left + MIN_CROP_PERCENT, 100);
  if (mode.includes("n")) top = clamp(top + dy, 0, bottom - MIN_CROP_PERCENT);
  if (mode.includes("s")) bottom = clamp(bottom + dy, top + MIN_CROP_PERCENT, 100);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The crop box over the uncropped frame (the Crop tab): the area outside
 * it dimmed, 8 resize handles, drag inside to move, drag outside to draw a
 * new box. Reports every change live through `onChange` (percent of the
 * source frame, normalized). */
export function CropBoxEditor({
  rect,
  percentRect,
  onChange,
}: {
  rect: ContainedRect;
  percentRect: PercentRect;
  onChange: (rect: PercentRect) => void;
}) {
  const dragRef = useRef<{ mode: DragMode; start: PercentRect; anchor: { x: number; y: number }; moved: boolean } | null>(
    null,
  );

  function pointerPercent(event: React.PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, ((event.clientX - box.left) / box.width) * 100)),
      y: Math.min(100, Math.max(0, ((event.clientY - box.top) / box.height) * 100)),
    };
  }

  return (
    <div
      className="absolute cursor-crosshair touch-none overflow-hidden"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      title="Drag the box to move it, its handles to resize it, or outside it to draw a new one"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-crop-mode]");
        const mode = (target?.dataset.cropMode as DragMode | undefined) ?? "draw";
        dragRef.current = { mode, start: percentRect, anchor: pointerPercent(event), moved: false };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const point = pointerPercent(event);
        const dx = point.x - drag.anchor.x;
        const dy = point.y - drag.anchor.y;
        // A click without a real drag doesn't draw a box.
        if (!drag.moved && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        drag.moved = true;
        onChange(normalizeCropRect(dragRect(drag.mode, drag.start, drag.anchor, dx, dy)));
      }}
      onPointerUp={() => {
        dragRef.current = null;
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
    >
      <div
        data-crop-mode="move"
        className="absolute cursor-move border-2 border-white"
        style={{
          left: `${percentRect.x}%`,
          top: `${percentRect.y}%`,
          width: `${percentRect.w}%`,
          height: `${percentRect.h}%`,
          boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55)",
        }}
      >
        {HANDLES.map((handle) => (
          <span
            key={handle.mode}
            data-crop-mode={handle.mode}
            aria-hidden="true"
            className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-sky-600 bg-white"
            style={{ left: handle.left, top: handle.top, cursor: handle.cursor }}
          />
        ))}
      </div>
    </div>
  );
}
