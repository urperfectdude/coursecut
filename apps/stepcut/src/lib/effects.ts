// The editor-preview twin of `apps/stepcut-worker/src/effects.ts`'s zoom
// curve. The worker builds the same curve as ffmpeg expressions for the
// finished render; this evaluates it in JS for the live preview. The two are
// separate copies (the apps share no code) — change the ramp or easing in
// one, change it in the other, or the preview stops matching the render.

import type { SpeedRegion, ZoomRegion } from "@/api/effects";

/** Must match the worker's `ZOOM_RAMP_SECS`. */
export const ZOOM_RAMP_SECS = 0.6;

function smoothstep(p: number): number {
  const c = Math.min(1, Math.max(0, p));
  return c * c * (3 - 2 * c);
}

export interface ZoomState {
  scale: number;
  /** Top-left of the visible window, as a fraction of the unzoomed frame. */
  offsetX: number;
  offsetY: number;
}

/**
 * The camera at source time `t`. Regions are non-overlapping (the API
 * enforces it), so at most one contributes. The offset mirrors the worker's
 * crop: center on the focus point, clamped so the window never leaves the
 * frame.
 */
export function zoomAt(t: number, zooms: readonly ZoomRegion[]): ZoomState {
  for (const zoom of zooms) {
    if (t < zoom.start || t >= zoom.end) continue;
    const ramp = Math.min(ZOOM_RAMP_SECS, (zoom.end - zoom.start) / 2);
    const strength = smoothstep((t - zoom.start) / ramp) - smoothstep((t - (zoom.end - ramp)) / ramp);
    const scale = 1 + (zoom.scale - 1) * strength;
    const maxOffset = 1 - 1 / scale;
    return {
      scale,
      offsetX: Math.min(maxOffset, Math.max(0, zoom.focus_x - 0.5 / scale)),
      offsetY: Math.min(maxOffset, Math.max(0, zoom.focus_y - 0.5 / scale)),
    };
  }
  return { scale: 1, offsetX: 0, offsetY: 0 };
}

/** The CSS transform that shows `state` on an element sized to the frame
 * (with `transform-origin: 0 0`). */
export function zoomTransform(state: ZoomState): string {
  if (state.scale === 1) return "none";
  return `scale(${state.scale}) translate(${-state.offsetX * 100}%, ${-state.offsetY * 100}%)`;
}

export function rateAt(t: number, speeds: readonly SpeedRegion[]): number {
  return speeds.find((speed) => t >= speed.start && t < speed.end)?.rate ?? 1;
}
