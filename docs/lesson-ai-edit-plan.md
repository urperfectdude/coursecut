# Plan: Per-lesson AI edit prompt

## Problem

`LessonSegmentsView.tsx` (a single lesson's segment-editing page) already has manual segment
tools: trim start/end at playhead, split at playhead, delete segment, reorder. There's no way to
say "cut the part where he goes off about pricing" or "split this into two segments, drop the
Q&A in the middle" — the user has to find the boundaries by scrubbing and do it by hand,
segment by segment.

This adds one free-text prompt box to that page: the user describes the change in plain
language, the AI proposes a revised segment list for *this lesson only*
(`lesson_segments` rows for `lessonId`), and the user reviews an old-vs-new popup before
anything is written to the database. Same shape of feature as the existing whole-video
"Analyze" (`analyze_video`/`analyze_transcript` in `src-tauri/src/openai.rs`), just scoped to
one already-created lesson, driven by an instruction instead of "find lesson boundaries from
scratch," and — unlike `analyze_video`, which replaces DB rows directly — gated behind an
explicit review step before it touches anything.

## Non-goals

* Not an open-ended chat — but the popup does allow refining the *current* proposal with a
  follow-up instruction before deciding to Apply (see Frontend below). That refinement loop is
  scoped entirely to one review session: Cancel (or Apply) ends it, and the next fresh prompt
  from the main textarea always starts over from the lesson's real, current DB segments — never
  from whatever was last proposed and abandoned.
* Doesn't touch `lessons.title`/`summary`/`kind` — those already have their own editors on this
  page. The AI only proposes segment ranges.
* Doesn't touch other lessons or `transcript_segments.keep` — scope is exactly this lesson's
  `lesson_segments`.
* No dedicated undo stack for this — matches the existing convention on this page (segment
  trim/split/delete/reorder aren't undoable either; only lesson renames are, in
  `LessonEditorView`). The user can always re-run with a corrective instruction or fix segments
  by hand afterward.
* The popup-before-apply requirement below is specific to this AI prompt path — it doesn't
  change how the existing manual tools on this page work (Trim/Split/Delete segment keep their
  current immediate-apply / `window.confirm` behavior). Only AI-proposed changes go through a
  review step, because this is the one path here where the *content* of the change isn't
  something the user directly clicked/typed — it needs to be seen before it's trusted.

## Backend (`src-tauri/src/openai.rs`)

New function `edit_lesson_segments_via_ai(current_segments, transcript_segments, instruction, api_key) -> Vec<(f64, f64)>`,
sitting next to `analyze_transcript` and reusing its shape:

* **Context sent to GPT-5.5** (text only, per `coursecut-privacy-invariants`):
  * the lesson's current segment ranges (`start`/`end`, in order)
  * the underlying video's kept transcript segments that overlap the lesson's current
    `[min start, max end]` span, expanded by a small pad (e.g. 60s) each side — enough for the
    model to see a little context around the edges ("remove the tangent right before the demo
    starts") without shipping the whole video's transcript for a scoped edit
  * the user's instruction, verbatim
* **System prompt**: explain the task is to revise one lesson's segment list per the
  instruction — segments may be split (return more ranges), merged/removed (return fewer, or
  none of a given span), or trimmed (adjusted start/end); ranges must come from within the
  transcript context sent; respond with the same
  `{"segments": [{"start": number, "end": number}, ...]}` shape `analyze_transcript` already
  parses (`parse_lesson_suggestions`'s segment-array logic is reusable almost as-is — extract a
  shared segment-array parser rather than duplicating the validation). Also states explicitly:
  the instruction may contain literal timestamps (e.g. "cut from 2:15 to 3:40", "split at
  12:03"), on the *source video's own timeline* — the same timeline every transcript line and
  segment range in this prompt is already given in (seconds, via the `[start-end]` prefixes).
  When a timestamp is given, treat it as a precise, authoritative boundary — convert it to
  seconds and use it directly rather than approximating from nearby transcript content; use the
  transcript content/wording only for whatever the instruction doesn't pin to a specific time.

**Explicit timestamps in the instruction** — a user typing "remove everything after 14:30" needs
that boundary to land exactly on 870s, not wherever the model guesses "after" means. Two parts:

* A small pure helper, `extract_timestamps_seconds(text: &str) -> Vec<f64>` (`openai.rs`, tested
  like `merge_chunk_segments`/`silence_gaps` above), regex-scans the *raw instruction string*
  for `h:mm:ss`, `mm:ss`, or `hh:mm:ss:fff` patterns (a looser match than the segment-editing
  UI's own strict `parseTimestamp` in `LessonSegmentsView.tsx`, since users typing into a prompt
  box won't reliably zero-pad or include milliseconds) and converts each match to seconds. This
  doesn't validate or clamp anything — it's just "what timestamps, if any, did the user type,"
  used purely to size the context window below. The instruction text itself (unmodified) is
  still what's sent to the model — this isn't a substitute for the model reading it.
* Before loading the transcript context window in `preview_lesson_segment_edit` (step 2 below),
  extract timestamps from `instruction` and fold each one (± the same pad, e.g. 60s) into the
  window's bounds — `window_start = min(lesson_padded_start, timestamp - pad)`, `window_end =
  max(lesson_padded_end, timestamp + pad)` for every extracted timestamp. This means a
  timestamp the user types can reach outside the lesson's own current span (e.g. "also cut the
  part at 45:00" on a lesson that currently only covers `[10:00, 20:00]`) and the transcript
  context sent still covers it, rather than the model being asked about a time range it was
  never shown any transcript text for.
* **Validation**: same as today's — `start < end`, each range within (transcript context range
  ± tolerance), reject/drop malformed entries without failing the whole response. An empty
  result (zero valid ranges — e.g. the instruction amounts to "delete everything") is a valid,
  representable proposal here; nothing is written to the database at this stage regardless, so
  there's no destructive-side-effect concern to guard against the way there would be if this
  step wrote directly.

Split into two commands — proposing a change is a network call with no side effects; applying
one is a local DB write with no network call — so the popup in between has a clean boundary and
"just show what preview already returned" is literally all Apply does:

**1. `#[tauri::command(async)] preview_lesson_segment_edit(lesson_id, instruction, baseline: Option<Vec<{start, end}>>, attempt) -> Result<Vec<(f64, f64)>, String>`**

1. Load the lesson (for its video_id and original bounds — used for the transcript context
   window in step 2 regardless of `baseline`, so a refinement's context doesn't drift). If
   `baseline` is `None` (the main prompt box's initial submission), also load the lesson's
   current `lesson_segments` from the DB and use that as the baseline. If `baseline` is `Some`
   (a refinement typed inside the popup, see Frontend below), use exactly what was passed —
   i.e. the *previous proposal*, not the DB rows, since the DB hasn't been touched yet and the
   user is iterating on what's currently showing in the popup.
2. Load that video's kept `transcript_segments` in the padded window described above — expanded
   to cover any timestamps `extract_timestamps_seconds` finds in `instruction`, per the previous
   section.
3. Reject empty/whitespace-only `instruction` before spending an API call.
4. Call `edit_lesson_segments_via_ai` with whichever baseline was resolved in step 1, and return
   its (possibly empty) result. **No database write of any kind happens in this command**,
   whether it's an initial preview or a refinement — this is the one place the AI's output
   exists before the user has seen and accepted it, so it can't yet have side effects.

**2. `#[tauri::command] apply_lesson_segment_edit(lesson_id, segments: Vec<{start, end}>) -> Result<Vec<LessonSegmentRow>, String>`**

Synchronous, no network call — it just commits ranges the frontend already displayed in the
popup (the exact array `preview_lesson_segment_edit` returned, round-tripped back). In one
transaction: delete the lesson's existing `lesson_segments`, insert the given ranges (sorted by
start, `sort_order` assigned by that order), recompute the lesson's cached `start`/`end` — same
pattern `replace_ai_lessons_tx` already uses per-lesson, just scoped to one lesson instead of a
whole video's AI lessons. Re-validates `start < end` per range defensively (the frontend
shouldn't be able to send anything `preview` didn't already produce, but this command doesn't
trust that on its own). Called with an empty `segments` array is rejected with an `Err` —
*"That would remove every segment in this lesson — to delete the whole lesson, use Delete
Lesson instead."* — this path never deletes a lesson as a side effect, whole-lesson deletion
already has its own explicit, confirmed affordance (`handleDeleteLesson` in
`LessonEditorView`, with its own `window.confirm`), and an AI-authored empty proposal — even
after the user has seen and confirmed it — shouldn't be able to reach through a segment-editing
command to trigger it. Contrast with `delete_lesson_segment`'s "last segment gone deletes the
lesson" rule: that one fires from an explicit, unambiguous per-segment delete click, not a
free-text instruction's model-authored interpretation.

No new migration — this only rewrites rows in the existing `lesson_segments` table.

## Frontend

`LessonSegmentsView.tsx`:

* New `db.ts` wrappers: `previewLessonSegmentEdit(lessonId, instruction, attempt, baseline?): Promise<{start: number; end: number}[]>`
  and `applyLessonSegmentEdit(lessonId, segments): Promise<LessonSegment[]>`.
* New panel between the summary textarea and the preview player: a short textarea ("Describe the
  change — e.g. 'cut the part about pricing' or 'split at 12:30' or 'trim everything after
  4:15'") plus a "Preview changes" button, disabled while empty or while a request is in flight.
  A small caption under the textarea notes that exact timestamps (`m:ss`, `h:mm:ss`) are honored
  precisely when included — matching what `extract_timestamps_seconds` actually looks for, so
  the hint doesn't promise more than the backend does. The refine textarea inside the popup gets
  the same caption, since it goes through the same backend command.
* Submitting calls `previewLessonSegmentEdit(lessonId, instruction, attempt)` — no `baseline`,
  so the backend loads it fresh from the DB — and, on success, opens a popup (modal). This
  doesn't touch `segments` state or the DB. The popup owns its own local state (a single
  `proposedSegments` array, replaced in place on every refine — no history list kept) and
  renders the diff plainly: current segment list (start/end, count) side by side with the
  proposed one, each row visually flagged as kept unchanged / trimmed / new / removed (a
  straightforward interval comparison against the current list — no need for anything fancier
  for a first cut).
* The popup has three controls: a second, smaller textarea ("Refine this proposal — e.g. 'keep
  more of the ending'") with an **Update proposal** button, plus **Apply** and **Cancel**.
  * **Update proposal** calls `previewLessonSegmentEdit(lessonId, refineInstruction, attempt, proposedSegments)`
    — passing the popup's *current* `proposedSegments` as `baseline`, so the next result iterates
    on what's showing, not on the lesson's real DB rows. Replaces `proposedSegments` with the new
    result and re-renders the diff (still against the *original* current segments, so the user
    always sees "real lesson today" vs "what would land if I hit Apply now," not a diff against
    the intermediate step). Clears the refine textarea; the outer instruction textarea and
    `proposedSegments` before this refine are not kept around anywhere once replaced.
  * If the proposed list is empty (initial or after a refine), the popup says so explicitly
    ("This would remove every segment in this lesson") and disables Apply — no point letting the
    user hit an Apply the backend will reject anyway; point them at the page's existing
    lesson-level delete instead if that's really the intent. Update proposal and Cancel stay
    available.
* **Apply** calls `applyLessonSegmentEdit(lessonId, proposedSegments)`, then on success closes
  the popup, clears the outer instruction textarea, discards all popup-local state, and
  `fetchSegments()` to reload the real rows.
* **Cancel** closes the popup and discards all popup-local state (`proposedSegments`, the refine
  textarea) immediately — no calls made, `segments` state untouched. The outer instruction
  textarea is left as-is (so the user can tweak their original wording and resubmit if they
  want), but a resubmission always goes through the no-`baseline` path above, so it starts from
  the lesson's real current segments — nothing from the cancelled proposal carries forward.
* Busy/error state: reuse the existing pattern (`segmentsError` for failures from any of the
  three calls; a shared `aiPreviewBusy` flag covering both the initial preview and Update
  proposal — they're the same call shape — and a separate `aiApplyBusy` for the apply request,
  so the popup's own buttons can disable independently of the outer prompt box).
* No streaming/progress bar needed — every call here is bounded (one chat completion, or one
  local transaction), not the chunked-upload path `transcribe_video` has.

## Open questions to confirm before implementing

* Padding window size around the lesson for transcript context (suggested 60s above) —
  arbitrary, worth confirming against a real lecture's pacing.
* Whether the popup needs a per-row "exclude this change" toggle (accept some of the AI's
  proposed edits but not others) or whether all-or-nothing (Apply commits the full proposed
  list, or Cancel and re-prompt with refined wording) is enough for a first cut — leaning
  all-or-nothing to keep the popup and the two commands simple; can add partial-accept later if
  whole-proposal rejection turns out to be a common frustration in practice.
* Exact timestamp regex coverage for `extract_timestamps_seconds` — `m:ss`/`h:mm:ss` covers the
  common case, but worth confirming whether bare-minute phrasing ("at minute 5") or ranges typed
  as "2:15-3:40" (one match vs. two) need explicit handling, or whether letting the model parse
  those from the untouched instruction text (just without the context-window-expansion benefit)
  is an acceptable fallback for anything the regex doesn't catch.
