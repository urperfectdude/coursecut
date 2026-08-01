// PORTED FROM: src/lib/badge-variants.ts @ 16d83e5
// DEVIATIONS: none
// One-way port — desktop is upstream. Don't edit this for web-only reasons;
// port the change to the desktop file first. See docs/web-app-plan.md §7.1,
// and re-run scripts/ui-drift.sh (which reads the SHA above) after syncing.
/** Tailwind className overlays for `<Badge variant="outline">`, keyed by
 * `Lesson.kind` / `Video.transcript_status` / `ExportRow.status` (`src/db.ts`).
 * shadcn's own `Badge` variants are generic (`default`/`secondary`/
 * `destructive`/`outline`/`ghost`/`link`) and have no per-status color
 * concept, so this file holds one small map + accessor per status-like field
 * that needs one. */

const LESSON_KIND_BADGE_CLASS_NAMES: Record<string, string> = {
  lesson: "text-emerald-700 border-emerald-600/40 dark:text-emerald-400 dark:border-emerald-400/40",
  qna: "text-sky-700 border-sky-600/40 dark:text-sky-400 dark:border-sky-400/40",
  discussion: "text-purple-700 border-purple-600/40 dark:text-purple-400 dark:border-purple-400/40",
  break: "text-muted-foreground border-border opacity-70",
  silence: "text-muted-foreground border-border opacity-70",
  duplicate: "text-red-700 border-red-600/40 dark:text-red-400 dark:border-red-400/40",
};

/** Maps a `Lesson.kind` value to the Tailwind classes that give its badge the
 * kind-specific color it had under the old `.kind-badge.kind-<kind>` CSS.
 * Falls back to the plain outline look for any unrecognized kind. */
export function getLessonKindBadgeClassName(kind: string): string {
  return LESSON_KIND_BADGE_CLASS_NAMES[kind] ?? "";
}

/** Keyed by `Video.transcript_status` (`src/db.ts`) — mirrors the color intent
 * of the old `.status-badge.status-<status>` CSS: `audio_ready`/`transcribed`
 * were green, `error` was red, and `pending` had no explicit rule (fell back
 * to the plain neutral `.status-badge` look), so it gets a muted treatment
 * here instead of a color of its own. */
const VIDEO_STATUS_BADGE_CLASS_NAMES: Record<string, string> = {
  pending: "text-muted-foreground border-border opacity-70",
  audio_ready: "text-emerald-700 border-emerald-600/40 dark:text-emerald-400 dark:border-emerald-400/40",
  transcribed: "text-emerald-700 border-emerald-600/40 dark:text-emerald-400 dark:border-emerald-400/40",
  error: "text-red-700 border-red-600/40 dark:text-red-400 dark:border-red-400/40",
};

/** Maps a `Video.transcript_status` value to the Tailwind classes for its
 * status badge. Falls back to the plain outline look for any unrecognized
 * status. */
export function getVideoStatusBadgeClassName(status: string): string {
  return VIDEO_STATUS_BADGE_CLASS_NAMES[status] ?? "";
}

/** Keyed by `ExportRow.status` (`src/db.ts`) — the old CSS never gave export
 * statuses distinct per-status colors (just a shared `.status-badge` look),
 * so this is a fresh, judgement-call palette: done=green, failed=red,
 * running=blue, queued/paused=amber (in progress but not yet running),
 * cancelled=neutral/muted. */
const EXPORT_STATUS_BADGE_CLASS_NAMES: Record<string, string> = {
  queued: "text-amber-700 border-amber-600/40 dark:text-amber-400 dark:border-amber-400/40",
  paused: "text-amber-700 border-amber-600/40 dark:text-amber-400 dark:border-amber-400/40",
  running: "text-sky-700 border-sky-600/40 dark:text-sky-400 dark:border-sky-400/40",
  done: "text-emerald-700 border-emerald-600/40 dark:text-emerald-400 dark:border-emerald-400/40",
  failed: "text-red-700 border-red-600/40 dark:text-red-400 dark:border-red-400/40",
  cancelled: "text-muted-foreground border-border opacity-70",
};

/** Maps an `ExportRow.status` value to the Tailwind classes for its status
 * badge. Falls back to the plain outline look for any unrecognized status. */
export function getExportStatusBadgeClassName(status: string): string {
  return EXPORT_STATUS_BADGE_CLASS_NAMES[status] ?? "";
}

/** Keyed by `SegmentDiffKind` (`"unchanged" | "trimmed" | "new"`) plus the
 * separately-tracked `"removed"` case from `LessonSegmentsView`'s
 * `diffProposedSegments` — mirrors the color intent of the old
 * `.lesson-segments-ai-diff-<kind>` CSS: unchanged had no color (a plain,
 * slightly faded row), trimmed was amber/yellow, new was green, and removed
 * was red with strikethrough text. */
const SEGMENT_DIFF_BADGE_CLASS_NAMES: Record<"unchanged" | "trimmed" | "new" | "removed", string> = {
  unchanged: "text-muted-foreground border-border opacity-70",
  trimmed: "text-amber-700 border-amber-600/40 dark:text-amber-400 dark:border-amber-400/40",
  new: "text-emerald-700 border-emerald-600/40 dark:text-emerald-400 dark:border-emerald-400/40",
  removed: "text-red-700 border-red-600/40 dark:text-red-400 dark:border-red-400/40",
};

/** Maps a proposed-segment diff row's `kind` (or the separate `"removed"`
 * case) to the Tailwind classes for its badge. */
export function getSegmentDiffBadgeClassName(kind: "unchanged" | "trimmed" | "new" | "removed"): string {
  return SEGMENT_DIFF_BADGE_CLASS_NAMES[kind];
}
