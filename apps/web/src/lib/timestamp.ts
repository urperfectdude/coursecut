// PORTED FROM: src/lib/timestamp.ts @ 16d83e5
// DEVIATIONS: none
// One-way port — desktop is upstream. Don't edit this for web-only reasons;
// port the change to the desktop file first. See docs/web-app-plan.md §7.1,
// and re-run scripts/ui-drift.sh (which reads the SHA above) after syncing.
/** Seconds → `hh:mm:ss` — the single timestamp format for every video
 * position, duration, or segment bound displayed across the app (playback
 * readouts, mark in/out, segment/lesson ranges, editable fields). */
export function formatTimestamp(seconds: number): string {
  const total = Math.round(seconds);
  const s = total % 60;
  const totalMin = Math.floor(total / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Inverse of `formatTimestamp` — strict `hh:mm:ss` only (always what the
 * field itself displays), so there's no ambiguity over what a partial or
 * differently-shaped input would mean. Returns `null` on anything else. */
export function parseTimestamp(input: string): number | null {
  const match = /^(\d+):([0-5]?\d):([0-5]?\d)$/.exec(input.trim());
  if (!match) return null;
  const [, hh, mm, ss] = match;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
}

/** Seconds → `hh:mm:ss:fff` — the one place in the app that still shows
 * millisecond precision: the lesson page's per-segment start/end editor,
 * where frame-accurate trims matter. Everywhere else uses `formatTimestamp`
 * above. */
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
