// Copied from apps/web/src/lib/timestamp.ts — a generic timestamp
// formatter/parser, no coursecut-specific logic. Not a "ported from
// desktop" file: apps/stepcut has no desktop counterpart, so there is
// nothing upstream to stay in sync with here.

/** Seconds → `hh:mm:ss` — used for read-only, second-precision displays. */
export function formatTimestamp(seconds: number): string {
  const total = Math.round(seconds);
  const s = total % 60;
  const totalMin = Math.floor(total / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Seconds → `hh:mm:ss:fff` — the format the step start/end editor fields
 * show and accept, so a boundary can be set frame-accurately by typing
 * rather than only by scrubbing to it. */
export function formatTimestampMs(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(ms).padStart(3, "0")}`;
}

/** Inverse of `formatTimestampMs` — strict `hh:mm:ss:fff` only. Returns
 * `null` on anything else. */
export function parseTimestampMs(input: string): number | null {
  const match = /^(\d+):([0-5]?\d):([0-5]?\d):(\d{3})$/.exec(input.trim());
  if (!match) return null;
  const [, hh, mm, ss, fff] = match;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(fff) / 1000;
}
