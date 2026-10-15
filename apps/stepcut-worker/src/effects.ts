// Render-time effects: zoom regions, speed regions, and a template's styled
// frame — turned into ffmpeg filter expressions for `ffmpeg.ts`'s
// `cutSegment`.
//
// A clean-room implementation (see `docs/stepcut-plan.md` §10): the feature
// set is modeled on what screen-recording editors like Recordly offer, but
// none of that code is used here — Recordly is AGPL-3.0 and renders in a
// browser canvas, while StepCut renders server-side through ffmpeg.
//
// The zoom curve below has one twin: `apps/stepcut/src/lib/effects.ts`'s
// `zoomAt`, which the editor's live preview uses. The two are separate copies
// (the frontend and the worker share no code), so a change to the ramp
// length or easing here has to be mirrored there, or the preview and the
// finished render drift apart.

/** A zoom region in *source-video* seconds, as snapshotted onto a render. */
export interface ZoomRegion {
  start: number;
  end: number;
  /** Magnification at the region's hold, e.g. 1.8. */
  scale: number;
  /** The point to keep centered, normalized to the frame (0..1). */
  focusX: number;
  focusY: number;
}

/** A speed region in source-video seconds. `rate` 2 plays twice as fast. */
export interface SpeedRegion {
  start: number;
  end: number;
  rate: number;
}

/** A template's frame styling, resolved to what the worker needs. */
export interface FrameStyle {
  backgroundKind: "none" | "color" | "gradient" | "image";
  backgroundColor: string;
  backgroundColor2: string | null;
  /** Local path to the downloaded background image, for `"image"`. */
  backgroundImagePath?: string;
  paddingPx: number;
  radiusPx: number;
  /** Shadow opacity, 0..1. 0 means no shadow. */
  shadow: number;
}

/** How long a zoom takes to ease in (and, separately, out). Capped at half
 * the region's length so a short region still reaches its full scale. */
export const ZOOM_RAMP_SECS = 0.6;

/** One contiguous piece of a cut played at a single rate — what speed
 * regions split a step into. Times are relative to the cut's start. */
export interface SpeedPiece {
  start: number;
  end: number;
  rate: number;
}

/**
 * Splits `[0, duration)` of a cut starting at `cutStart` (source seconds)
 * into pieces at every speed-region boundary that falls inside it. Gaps
 * between speed regions play at rate 1. Regions are assumed non-overlapping
 * (the API enforces that); anything shorter than a frame is dropped rather
 * than handed to ffmpeg as a zero-length trim.
 */
export function speedPieces(cutStart: number, duration: number, regions: readonly SpeedRegion[]): SpeedPiece[] {
  const MIN_PIECE_SECS = 0.02;
  const inside = regions
    .map((r) => ({ start: Math.max(0, r.start - cutStart), end: Math.min(duration, r.end - cutStart), rate: r.rate }))
    .filter((r) => r.end - r.start >= MIN_PIECE_SECS && r.rate !== 1)
    .sort((a, b) => a.start - b.start);

  const pieces: SpeedPiece[] = [];
  let cursor = 0;
  for (const region of inside) {
    const start = Math.max(region.start, cursor);
    if (region.end - start < MIN_PIECE_SECS) continue;
    if (start - cursor >= MIN_PIECE_SECS) pieces.push({ start: cursor, end: start, rate: 1 });
    pieces.push({ start, end: region.end, rate: region.rate });
    cursor = region.end;
  }
  if (duration - cursor >= MIN_PIECE_SECS || pieces.length === 0) {
    pieces.push({ start: cursor, end: duration, rate: 1 });
  }
  return pieces;
}

/** How long a cut plays once its speed pieces are applied. */
export function outputDuration(pieces: readonly SpeedPiece[]): number {
  return pieces.reduce((sum, piece) => sum + (piece.end - piece.start) / piece.rate, 0);
}

/** A number formatted for an ffmpeg expression — fixed precision, no
 * exponent notation (which ffmpeg's expression parser reads differently). */
function num(value: number): string {
  return Number(value.toFixed(4)).toString();
}

/** `smoothstep(clip((t - a) / r, 0, 1))` as an ffmpeg expression. */
function easeExpr(a: number, r: number): string {
  const p = `clip((t-${num(a)})/${num(r)},0,1)`;
  return `(${p}*${p}*(3-2*${p}))`;
}

/**
 * The zoom expressions for one speed piece. `offset` is the piece's start
 * relative to the cut, and `cutStart` the cut's start in source seconds, so
 * `t` (which restarts at 0 for each piece's own input) maps back to source
 * time as `t + cutStart + offset`.
 *
 * Returns `undefined` when no region touches this piece, so the caller can
 * skip the per-frame scale/crop entirely.
 */
export function zoomExpressions(
  regions: readonly ZoomRegion[],
  cutStart: number,
  piece: SpeedPiece,
): { z: string; fx: string; fy: string } | undefined {
  const base = cutStart + piece.start;
  const pieceEnd = cutStart + piece.end;
  const touching = regions.filter((r) => r.end > base && r.start < pieceEnd);
  if (touching.length === 0) return undefined;

  const zTerms: string[] = [];
  const fxTerms: string[] = [];
  const fyTerms: string[] = [];
  for (const region of touching) {
    const a = region.start - base;
    const b = region.end - base;
    const ramp = Math.min(ZOOM_RAMP_SECS, (region.end - region.start) / 2);
    // Eases in over [a, a+ramp], holds, eases out over [b-ramp, b]: the
    // difference of two saturating eases is 0 outside the region and 1 in
    // its hold.
    const strength = `(${easeExpr(a, ramp)}-${easeExpr(b - ramp, ramp)})`;
    zTerms.push(`${num(region.scale - 1)}*${strength}`);
    // Focus switches only at region bounds, where strength is already 0, so
    // the switch is never visible.
    const within = `gte(t,${num(a)})*lt(t,${num(b)})`;
    fxTerms.push(`${num(region.focusX - 0.5)}*${within}`);
    fyTerms.push(`${num(region.focusY - 0.5)}*${within}`);
  }
  return {
    z: `(1+${zTerms.join("+")})`,
    fx: `(0.5+${fxTerms.join("+")})`,
    fy: `(0.5+${fyTerms.join("+")})`,
  };
}

/** Largest even integer ≤ `value` — yuv420p needs even dimensions. */
export function even(value: number): number {
  return Math.max(2, 2 * Math.floor((value + 1e-6) / 2));
}

export interface Layout {
  /** The final frame. */
  width: number;
  height: number;
  /** Where the recording sits inside it, at the source's aspect ratio. */
  boxWidth: number;
  boxHeight: number;
  boxX: number;
  boxY: number;
}

/** Fits the source's aspect ratio inside the target frame minus padding,
 * centered — the same box `scale…force_original_aspect_ratio=decrease,pad`
 * produced before styled frames existed, when padding is 0. */
export function layoutFor(
  targetWidth: number,
  targetHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  paddingPx: number,
): Layout {
  const padding = Math.max(0, Math.min(paddingPx, Math.floor(Math.min(targetWidth, targetHeight) / 3)));
  const availW = targetWidth - 2 * padding;
  const availH = targetHeight - 2 * padding;
  const scale = Math.min(availW / sourceWidth, availH / sourceHeight);
  const boxWidth = even(sourceWidth * scale);
  const boxHeight = even(sourceHeight * scale);
  return {
    width: targetWidth,
    height: targetHeight,
    boxWidth,
    boxHeight,
    boxX: Math.floor((targetWidth - boxWidth) / 2),
    boxY: Math.floor((targetHeight - boxHeight) / 2),
  };
}

/**
 * The per-piece video chain: fit the source into the layout's box, zooming
 * if a region touches this piece, then retime for the piece's rate.
 *
 * Zoom works by scaling the *source* up to `box × z` every frame and cropping
 * a box-sized window out of it — `scale` with `eval=frame` is the one stock
 * filter that can change magnification per frame with sub-pixel smoothness
 * (unlike `zoompan`, which snaps its crop to whole source pixels and visibly
 * judders on slow zooms). Scaling straight from the source rather than from
 * an already-fitted copy keeps a high-resolution recording sharp when zoomed.
 *
 * `crop`'s own `iw`/`ih` report the link's *configured* size, not the
 * per-frame one, so the crop offset is computed from the same `z` expression
 * rather than from `iw`.
 */
export function pieceVideoChain(
  layout: Layout,
  zoom: { z: string; fx: string; fy: string } | undefined,
  piece: SpeedPiece,
  fps: number,
): string {
  const bw = layout.boxWidth;
  const bh = layout.boxHeight;
  const filters: string[] = [];
  if (zoom) {
    const sw = `(2*trunc(${bw}*${zoom.z}/2))`;
    const sh = `(2*trunc(${bh}*${zoom.z}/2))`;
    filters.push(`scale=w='${sw}':h='${sh}':eval=frame:flags=bicubic`);
    filters.push(
      `crop=w=${bw}:h=${bh}` +
        `:x='clip(${zoom.fx}*${sw}-${bw}/2,0,${sw}-${bw})'` +
        `:y='clip(${zoom.fy}*${sh}-${bh}/2,0,${sh}-${bh})'`,
    );
  } else {
    filters.push(`scale=${bw}:${bh}:flags=bicubic`);
  }
  filters.push("setsar=1");
  filters.push(piece.rate === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${num(piece.rate)}`);
  filters.push(`fps=${fps}`);
  return filters.join(",");
}

/** `atempo` only accepts 0.5..100 per instance, so a slower rate is chained. */
export function atempoChain(rate: number): string {
  if (rate === 1) return "anull";
  const parts: string[] = [];
  let remaining = rate;
  while (remaining < 0.5) {
    parts.push("atempo=0.5");
    remaining /= 0.5;
  }
  parts.push(`atempo=${num(remaining)}`);
  return parts.join(",");
}

/**
 * The ffmpeg `geq` luma expression for a rounded-rectangle mask of the
 * input's own size (`W`/`H`), anti-aliased over one pixel. Rendered once per
 * render to a still PNG — `geq` is far too slow to run on every frame.
 */
export function roundedMaskExpr(radiusPx: number): string {
  const r = num(Math.max(0, radiusPx));
  const dx = `max(max(${r}-X,X-(W-1-${r})),0)`;
  const dy = `max(max(${r}-Y,Y-(H-1-${r})),0)`;
  return `clip((${r}+0.5-hypot(${dx},${dy}))*255,0,255)`;
}

/** Whether a style changes anything about the frame compared to a plain,
 * black-letterboxed cut. */
export function isStyled(style: FrameStyle | undefined): style is FrameStyle {
  return (
    style !== undefined &&
    (style.backgroundKind !== "none" || style.paddingPx > 0 || style.radiusPx > 0 || style.shadow > 0)
  );
}
