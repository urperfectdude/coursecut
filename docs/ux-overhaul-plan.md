# Plan: UX overhaul — onboarding, progress, staged flow, smarter segmentation

The app's capabilities are largely there; the interaction design around them isn't.
This plan covers five problem areas, in dependency order.

It builds on the in-flight multi-segment work (`docs/lesson-segments-plan.md`,
migration `0006_lesson_segments.sql`, `src/components/LessonCard.tsx`,
`src/components/SourceVideoPreview.tsx`), which is uncommitted on `main`.
**Phase 0 below fixes two gaps in that work that block everything else.**

## Current state (verified, not assumed)

* Routing is a hand-rolled `useState` union in `App.tsx:8-19` — five flat views,
  no breadcrumbs, no nesting.
* `ProjectDetailView.tsx:476-530` renders six buttons per video row (View
  transcript / Analyze / View lessons / Edit / Retry / Remove). This is the
  "button pile."
* **There is no Tauri event emission anywhere in the codebase** — `grep` for
  `emit`/`Emitter` returns only unrelated matches. All progress reporting is new
  infrastructure, not a matter of surfacing something already published.
* `processVideo` (`ProjectDetailView.tsx:149-190`) awaits `extractAudioForVideo`
  then `transcribeVideo` with no intermediate reporting. The UI's only signals
  are an `importing` boolean, a `"Working…"` label, and the row's
  `transcript_status` badge.
* Chunked transcription already loops per chunk at `openai.rs:95-104` and knows
  `chunks.len()` — the data for a percentage exists, it's just never reported.
* `getOpenAiKeyStatus()` already exists (`src/db.ts:254`, `settings.rs:57`).
  `HomeView.tsx` never calls it.
* `ANALYSIS_SYSTEM_PROMPT` (`openai.rs:431-445`) instructs the model to
  **"Cover the whole transcript"** and emits one flat `{start, end}` per lesson.
  That single clause plus that schema is the direct cause of the forced
  contiguous `0-2, 2-4, 4-5` segmentation.
* `kind: "silence"` is already an allowed classification (`openai.rs:429`), but
  it's inferred from transcript text, not detected from audio.

## Phase 0 — Fix two blocking gaps in the in-flight segment work

Both are pre-existing in the uncommitted diff. Neither is caught by
`npm run typecheck` (which passes) because both are runtime/SQL-level.

**0a. `analyze_video` never writes `lesson_segments`.**
`openai.rs:802-820` inserts into `lessons` only. Migration 0006 backfills
segments for lessons that existed *at migration time*; every lesson created by
analysis afterwards has **zero** segment rows. Consequence: `LessonCard` renders
an empty segment list and no preview for every AI-generated lesson — i.e. for
essentially all of them. Fix: insert one `lesson_segments` row per suggestion in
the same transaction.

**0b. Export ignores segments entirely.**
`export.rs:694-736` cuts using `job.start`/`job.end` — the cached derived bound.
For a multi-segment lesson that bound spans min-start to max-end, so **the
export re-includes exactly the gaps the user excluded.** Fix: load the lesson's
segments, cut each, and concat. `generate_srt` (`export.rs:176`) needs the same
treatment — cues must be re-timed against concatenated output, not source
timeline.

0b is the larger of the two and should be scoped as its own change; it is the
one place where "silently produces a wrong file" is the failure mode.

## Phase 1 — API key onboarding

CourseCut is BYOK and the home page says nothing about it.

* `HomeView` calls `getOpenAiKeyStatus()` on mount.
* No key → a persistent banner above the project list explaining a key is
  required, with a direct button into Settings. Not a dismissible toast.
* Key present → no banner; the existing Settings button is enough.
* Also gate the import flow: `ProjectDetailView` should surface the missing key
  *before* a user imports a 90-minute lecture and watches it fail at the
  transcription step. Today that only appears as a per-video error at
  `ProjectDetailView.tsx:176-180`.

## Phase 2 — Real pipeline progress

New infrastructure. Introduce a single typed progress event rather than one
event per stage, so the frontend has one listener and one reducer.

```rust
// emitted on channel "video-progress"
struct VideoProgress {
    video_id: String,
    stage: Stage,        // Importing | ExtractingAudio | Transcribing | Analyzing
    // None = indeterminate (show a spinner, not a bar)
    fraction: Option<f64>,
    detail: Option<String>,  // e.g. "chunk 3 of 12"
    attempt: u32,            // >1 renders as "Retrying (2 of 3)…"
}
```

Emit points:

* `ffmpeg.rs` — extraction start/end. ffmpeg's `-progress` output could drive a
  real fraction here; start with indeterminate and refine only if it's cheap.
* `openai.rs:95-104` — per-chunk, `fraction = (index + 1) / chunks.len()`,
  `detail = "chunk N of M"`. This is the highest-value emit point and the one
  the user explicitly asked for.
* `openai.rs` single-shot path (`:89`) and `analyze_video` — indeterminate.
* Retries increment `attempt` so status is visible on retry, not just first try.

Frontend: a `useVideoProgress()` hook owning one `listen()` subscription, keyed
by `video_id`, consumed by the video row and the stage pages. Progress state is
ephemeral — on reload, fall back to the row's persisted `transcript_status`.

Emitting requires the `tauri::Emitter` trait in scope; the `AppHandle` is
already threaded through these functions for other reasons.

## Phase 3 — Staged page flow with breadcrumbs

Replace the six-button row with navigation.

Extend the `App.tsx` view union rather than adding a router dependency — the
existing idiom is fine at this size:

```ts
| { name: "video"; projectId: string; videoId: string;
    stage: "transcript" | "lessons" }
```

`{ name: "editor" }` is retired; `LessonEditorView` becomes the `lessons` stage.

* **Video row becomes clickable** once transcribed, navigating to
  `stage: "transcript"`. Remove/Retry stay as explicit row buttons; everything
  else moves into the flow.
* **Breadcrumbs** — `Projects / <project> / <video> / <stage>` — as a shared
  component in the app shell, since every stage needs it.
* **Transcript stage.** Only transcript UI. Review, mark segments to drop
  (`update_transcript_segment` already supports `keep`). Advances via a single
  **Analyze** button with the Phase 2 loading indicator.
* **Lessons stage.** Only lesson UI. Reached after analysis, but **navigable
  back and forth without re-analyzing** — going back to transcript and returning
  must not re-trigger `analyze_video`. Since lessons are persisted, this falls
  out of loading via `listLessons(videoId)` on mount and only calling
  `analyze_video` on explicit Analyze. Guard against a user landing on `lessons`
  with zero lessons (never analyzed) — show an empty state that offers Analyze
  rather than auto-running it.

## Phase 4 — Lessons page layout

* **Source video at top** — `SourceVideoPreview` already exists and is the right
  component; it becomes context-only here (scrub the raw source), not the
  primary editing surface.
* **Lessons as a large tile grid**, replacing the flat list. Each tile is a
  `LessonCard` with its own preview that plays **only that lesson's segments**,
  in order, skipping the gaps. `LessonCard.tsx` already implements
  segment-sequenced playback — this phase is mostly layout plus selection state.
* **Export selection** — multi-select across tiles, then export the selected
  set. Depends on Phase 0b being fixed, or exports will be wrong.
* **Create Lesson** (top-right) — opens a transcript picker modal. User checks
  transcript segments; contiguous runs of checked segments collapse into one
  `lesson_segments` row each, so a non-contiguous selection naturally produces a
  multi-segment lesson. Writes with `source != 'ai'`, which the existing
  `analyze_video` delete-and-reinsert (`openai.rs:796-800`) already preserves
  across re-analysis.

## Phase 5 — Smarter segmentation

**5a. Stop forcing contiguous coverage.** Two changes to
`ANALYSIS_SYSTEM_PROMPT` (`openai.rs:431`):

* Drop **"Cover the whole transcript"** and replace it with an instruction to
  select only material that belongs in a lesson, explicitly allowing gaps
  between lessons and overlap between them where content justifies it.
* Change the response schema from one `{start, end}` per lesson to
  `segments: [{start, end}, ...]`, so a lesson can be assembled from
  non-contiguous parts in one response.

`parse_lesson_suggestions` (`openai.rs:578`) validates per-lesson bounds today;
it moves to validating each segment (`start < end`, within transcript range,
drop bad segments individually, drop a lesson only if *all* its segments are
invalid). Its existing unit tests are the model for the new ones.

**5b. Silence handling.** Recommend transcript-gap detection first: gaps between
consecutive `transcript_segments` above a threshold (~2s) are dead air, computed
locally with no extra API cost or dependency. Trim lesson segment boundaries
against those gaps. Only if that proves insufficient, add ffmpeg
`silencedetect` as a second pass — more accurate on non-speech audio, but it's a
new subprocess stage and belongs in Phase 2's progress reporting if added.

Note this must not silently discard content the user kept — trimming should be
visible in `LessonCard`'s segment list, not invisible.

## Privacy check

Nothing here changes what leaves the device: progress events are local IPC, the
analysis prompt change is transcript-text-only, and gap-based silence detection
is local arithmetic. Per `CLAUDE.md`, re-read `coursecut-privacy-invariants`
before touching `openai.rs` in Phase 5, and if ffmpeg `silencedetect` is added,
confirm it stays local-only.

## Milestones

Phases above are grouped by *problem area*. Milestones below are grouped by
*shippable increment* — each one ends with the app in a working, demonstrable
state, with a concrete acceptance test. They don't map 1:1 onto phases.

### M0 — Key onboarding (Phase 1)

The quick win. Touches `HomeView.tsx` and `ProjectDetailView.tsx`'s import guard
and nothing else, so it conflicts with no other milestone and can land any time.

*Accept:* fresh install with no key shows a persistent banner explaining BYOK
with a route into Settings; saving a key clears it; importing without a key
warns before transcoding rather than after.

### M1 — Multi-segment lessons work end to end (Phases 0a + 0b)

**Blocking, and the highest-priority milestone.** 0a and 0b ship together
deliberately: a lesson whose segments persist but whose export re-includes the
gaps is not a shippable state, and splitting them means the acceptance test
can't be written. Together they have one clean criterion.

*Accept:* analyze a video → each generated lesson has ≥1 `lesson_segments` row →
build a deliberately non-contiguous lesson → **the exported file matches what
the card's preview plays**, and its SRT cue times line up with the concatenated
output rather than the source timeline.

**Decided:** a multi-segment lesson exports as a **single concatenated video
file**, not one file per segment. So 0b cuts each segment and concats them into
one output.

**Decided: SRT export is dropped entirely.** Exports become video-only. This
removes the fiddliest part of 0b — with gaps between segments, cues would have
had to be re-timed against the concatenated timeline (source time minus the
duration of all preceding gaps), and a wrong offset there produces a file that
still plays fine, so the error would ship unnoticed. Removing the feature is
both less work and less risk than getting that right.

Sites to remove in `export.rs`: `generate_srt` / `lesson_srt_cues` /
`format_srt_timestamp`, the `.srt` write (`:736-738`), the `.srt` arm of
filename-collision handling (`:247-248`), the cleanup-on-cancel/failure
`remove_file` calls (`:554`, `:765`), and the associated tests (`:853-904`,
`:1009-1034`). `docs/PRD.md:270` lists "SRT subtitles" as a feature — update the
PRD in the same change, since it's the scope source of truth per `CLAUDE.md`.

Note the transcript itself is untouched: `load_kept_segments` still drives which
footage is cut. Only subtitle *file output* goes away.

Unblocked; ready to start.

### M2 — Progress event backbone (Phase 2)

Land the Rust event infrastructure *and* consume it in the existing video row,
before any restructuring. Deliberate: it makes the events verifiable immediately
against a UI that already works, instead of landing blind infrastructure that
only becomes observable two milestones later. The `useVideoProgress()` hook
carries into M3/M4 unchanged — the row is throwaway, the hook isn't.

*Accept:* importing a long video shows distinct upload → extract → transcribe
stages; a chunked transcription shows "chunk N of M" with a moving bar; a
failure and retry shows the attempt count.

### M3 — Staged navigation (Phase 3)

Routing union, breadcrumbs, transcript stage. Retires the six-button row.

*Accept:* a transcribed row is clickable into the transcript stage; breadcrumbs
navigate every level; Analyze advances to the lessons stage with a live
indicator; **navigating back to transcript and forward again does not re-run
analysis.**

### M4 — Lessons page (Phase 4)

Source video header, tile grid, multi-select export, Create Lesson modal.

The **selected lesson's segments highlight in yellow on the source player's
seekbar**, so it's obvious at a glance which parts of the video that lesson
takes. The highlight blocks themselves are built already
(`SourceVideoPreview.tsx:165-175`, styled yellow via
`.source-preview-segment-highlight`), but they currently sit on the wrong bar.

**Consolidate to one seekbar.** The component today renders *two*: the native
one from `<video controls>` (`:148`) and a separate `<input type="range">`
scrubber (`:155-164`) that carries the overlay. The highlight must live on the
main player's own seekbar, not a detached second bar.

Native `<video>` controls are shadow DOM and can't be overlaid or styled, so the
fix is to drop `controls` and promote the custom scrubber to *be* the player's
seekbar — which means adding back what `controls` provided: a play/pause button
and a current-time / duration readout, in a control row directly under the
video. The existing keyboard shortcuts (`:139` — space, arrow-key stepping)
already cover the interactions and stay as-is. Net result is one player, one
seekbar, yellow highlight on it.

Then keep it wired as the source player becomes the lessons-page header: pass
the selected lesson's segments down, and clear the selection (and so the
overlay) when no tile is selected.

*Accept:* the source player shows exactly one seekbar; selecting a tile
highlights exactly its segments in yellow on that seekbar and deselecting clears
them; play/pause, scrubbing, and the keyboard shortcuts all still work without
native controls; each tile plays only its own segments and skips gaps; a
non-contiguous manual selection in the Create Lesson modal produces one lesson
with multiple segment rows; multi-select export produces one correct file per
selected lesson.

### M5 — Non-contiguous analysis (Phase 5a)

Prompt change plus the per-segment validation rewrite in
`parse_lesson_suggestions`.

*Accept:* analysis of a lecture with a mid-session break produces lessons with
gaps between them — not wall-to-wall coverage — and a lesson assembled from
non-contiguous segments survives the round trip into `lesson_segments`. Existing
`openai.rs` parse tests extended for multi-segment and partial-invalid payloads.

### M6 — Silence handling (Phase 5b)

Last because it needs both M4's segment list (to make trimming visible) and M5's
segment shape.

*Accept:* dead air above the threshold is trimmed from lesson boundaries, and
every trim is visible in the card's segment list rather than applied silently.

## Scheduling

```
M0 ─────────────────────────────────────────────  (anytime, no conflicts)

M1 ──┬── M2 ── M3 ── M4 ──┬── M6
     │                    │
     └── M5 ──────────────┘
```

Two things make this cheaper than running straight down the list:

* **M5 is backend-only** (`openai.rs`) while **M3/M4 are frontend-only**
  (`App.tsx`, views, components). After M1 they're a genuine parallel track with
  no overlapping files — worth two worktrees
  (`.claude/skills/parallel-worktrees`).
* **M3 → M4 must stay sequential.** Both rewrite `App.tsx` and
  `LessonEditorView.tsx` heavily; running them in parallel buys nothing and
  costs a painful merge.

M2 sits before M3 so the stage pages have indicators to render on arrival,
rather than shipping a new flow with dead loading states.

Per `CLAUDE.md`, implement each milestone with `feature-implementer`, then
`independent-reviewer` before merging. M1 warrants the closest review — it's the
one where a mistake produces a silently wrong output file.

## Open questions

* ~~Export of a multi-segment lesson: single concatenated file, or one file per
  segment?~~ **Resolved: single concatenated file.** See M1.
* Should overlapping lessons warn at export time? The segment plan deliberately
  allows overlap, but exporting two lessons sharing footage may be a mistake
  worth flagging (non-blocking).
* Silence-gap threshold — hardcode ~2s, or expose in Settings alongside the
  existing analysis instructions?
