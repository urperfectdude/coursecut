# Plan: Multi-segment lessons + attached lesson preview

## Problem

Today (`LessonEditorView.tsx`, `src-tauri/src/db.rs`):

* Each lesson has a single `start`/`end` range (one contiguous clip).
* There's one shared, global `<video>` player for the whole editor, plus a separate "Timestamp Mode" tab with numeric start/end fields and a range-slider scrubber.
* "Preview" is a button per lesson that loop-plays `[start, end)` on that one shared player.
* No overlap validation exists anywhere in Rust — nothing currently prevents two lessons from covering the same time range, but nothing is designed around that case either.
* MediaBunny is referenced in the PRD/architecture skill but not installed; preview is plain native `<video>` + `<input type="range">`.

## Goals

1. A lesson can be built from **multiple, possibly non-contiguous segments** of the source video.
2. Segments can **overlap** — both across different lessons and within a single lesson. This is a supported case, not an error state.
3. Drop the separate Timestamp Mode tab. Timestamp/segment adjustment lives **attached to the lesson itself**, not in a separate global editor mode.
4. No single "big" default shared video player. Instead, a compact **source video component** for viewing/scrubbing the raw source, plus a small **attached preview per lesson**.
5. Transcript Mode is unaffected — stays as its own view, operating on `transcript_segments` as it does today.

## Data model

New migration (`src-tauri/migrations/NNNN_lesson_segments.sql`):

```sql
CREATE TABLE lesson_segments (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  start REAL NOT NULL,
  end   REAL NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
```

* Backfill: one `lesson_segments` row per existing lesson, from its current `start`/`end`.
* `lessons.start` / `lessons.end` remain on the table but change meaning: they become a **cached derived bound** (min segment start, max segment end), recomputed by Rust after every segment write. This avoids rewriting every place that currently sorts/displays by lesson start (e.g. `resequence_lessons`, `db.rs:597-617`) to join against segments instead.
* No overlap constraint is added, in either direction (segment-vs-segment within a lesson, or lesson-vs-lesson). This is intentional.

## Rust (`src-tauri/src/db.rs`, `lib.rs`)

* New commands:
  * `list_lesson_segments(lesson_id)`
  * `add_lesson_segment(lesson_id, start, end)`
  * `update_lesson_segment(id, start, end)`
  * `delete_lesson_segment(id)`
* Each segment mutation recomputes and persists the parent lesson's cached `start`/`end`, then calls existing `resequence_lessons` so lesson ordering (by earliest segment) stays correct.
* `delete_lesson_segment` on a lesson's **last remaining segment** deletes the lesson itself instead (a lesson with zero segments isn't a meaningful lesson) — the segment row disappears via the existing `ON DELETE CASCADE` from `lessons`. This avoids ever having a lesson with stale/meaningless cached `start`/`end` bounds. The command's return value should tell the caller whether the lesson itself was deleted (vs. just the segment), so the frontend can remove the lesson from any list rather than trying to re-render a lesson that no longer exists.
* `update_lesson` drops its `start`/`end` params — title/summary only.
* `split_lesson` gains a `segment_id` param (a lesson can now have more than one segment, so a split has to say which one). Logic is otherwise the same as today (`db.rs:694-739`): truncate the segment, create a new lesson holding the tail as a new segment.
* `merge_lessons` gets simpler: concatenate both lessons' segment lists onto the surviving lesson, delete the source lesson. Same-video constraint stays.
* Validation stays exactly what it is today: `start < end` per segment, nothing cross-segment or cross-lesson.

## Frontend

`LessonEditorView.tsx` (currently one 1155-line file, one global player, Transcript/Timestamp tab toggle) splits into:

* **`SourceVideoPreview`** — small, always-visible player against the raw source file. This is *the* place to see the actual source video — compact and secondary, not the old "big default player." Responsibilities:
  * scrub the full video
  * mark in/out points, "Add as segment" to whichever lesson is currently selected
  * render a **non-interactive seek-bar overlay** (see below) highlighting the selected lesson's segment(s)
* **`LessonCard`** (replaces the flat lesson-list row) — owns:
  * its own small attached `<video>`, playing/looping through *that lesson's* segments in order — replaces the old global "Preview" button entirely, since the card always shows its own preview
  * a segment list: each segment has adjustable start/end, trim start/end, delete — this is where Timestamp Mode's controls (frame-step, keyboard shortcuts) move to, now scoped per-segment
  * "Add segment" hooked to `SourceVideoPreview`'s current in/out marks
  * selecting a card sets `selectedLessonId` in the parent view, feeding `SourceVideoPreview`'s overlay
* Transcript Mode: untouched, stays as its own view.

### Seek-bar highlight overlay

* `selectedLessonId` lives in whichever component composes `SourceVideoPreview` + the `LessonCard` list (set on card click/select).
* `SourceVideoPreview` receives the selected lesson's segments as a prop and renders an absolutely-positioned overlay on top of its own scrubber, `pointer-events: none` so it never intercepts drag/click on the real seek control underneath.
* One highlighted block per segment: `left: (segment.start / duration) * 100%`, `width: ((segment.end - segment.start) / duration) * 100%` — generalizes for free to multi-segment lessons.
* No selection → no overlay, just the plain scrubber.
* This is the mechanism for surfacing overlap: since overlap isn't blocked, the highlight is how a user notices they've selected a lesson whose segment(s) sit on top of another lesson's footage. Scoped to one selected lesson at a time (not an always-on multi-lesson strip) — simpler, matches the per-lesson-selection model already in place.

## Sequencing

1. Migration + Rust segment CRUD (`list/add/update/delete_lesson_segment`) + updated `split_lesson`/`merge_lessons`, with tests mirroring the existing style (`db.rs:954+`).
2. Frontend split into `SourceVideoPreview` (+ seek-bar overlay), `LessonCard`, and the per-segment editor, wired to the new commands.
3. `independent-reviewer` pass before merging (per CLAUDE.md convention).
