# Plan: Desktop UI optimizations — dark-only theme, sticky lesson preview, timeline-context toggle

Status: Implemented on `web-app-m1` (desktop tree only) — see §3's "What shipped"
Scope: **desktop app only** (`src/`, `src-tauri/`, `index.html`, `tauri.conf.json`)
Explicitly **not** in scope: `apps/web` — see §4 for how these land there later
Companion to: [`docs/PRD.md`](./PRD.md), [`docs/lesson-segments-plan.md`](./lesson-segments-plan.md), [`docs/lesson-ai-edit-plan.md`](./lesson-ai-edit-plan.md)

---

## 0. What this covers

Three independent changes, requested together, all on the desktop app:

1. **Dark theme only** — no light theme, no OS-preference switching, no toggle.
2. **Sticky video preview on the lesson segments page** — the two players stay pinned at the top while the segment list scrolls under them, so a long lesson can be edited without scrolling back up to see the effect.
3. **Timeline-context toggle in the floating AI input** — the user picks whether the timestamps they type refer to the **original (source) video** or the **final (stitched) lesson video**, and the AI edit path interprets them accordingly.

They touch three mostly-disjoint parts of the codebase (global CSS / one view's layout / one view plus a new `src/lib` helper — no Rust in the end, see §3), so they can ship as three commits in any order. Recommended order is the one above: cheapest and most visible first, riskiest last.

The web app (`apps/web`) is mid-flight on its own milestone and gets **no changes now** — §4 records these three so they are ported forward through the existing drift discipline instead of being rediscovered later.

---

## 1. Dark theme only

### Current state

`src/styles.css` ships a full light palette in `:root` (lines 8–43) and overrides it inside `@media (prefers-color-scheme: dark)` (lines 189–223). `:root` declares `color-scheme: light dark`, and line 6 declares `@custom-variant dark (@media (prefers-color-scheme: dark))`, so every `dark:` Tailwind utility in the app is keyed to the OS preference too. There are ~21 `dark:` utilities across `src/components/ui/*` (shadcn-generated) and four views. Nothing in the app ever adds a `.dark` class, and there is no theme toggle anywhere — so today the app is "whatever macOS/Windows is set to."

### Target

The app renders dark regardless of OS setting, and there is exactly one palette to maintain.

### Steps

1. **`src/styles.css` — collapse the two palettes into one.**
   * Promote every custom property currently inside `@media (prefers-color-scheme: dark)` into `:root`, replacing the light values in place.
   * Delete the `@media (prefers-color-scheme: dark)` block entirely.
   * Set `color-scheme: dark` (not `light dark`) on `:root` — this is what makes native scrollbars, `<video>` controls, form controls, and the default canvas dark, and it must not be skipped.
   * Update the comment at lines 185–188, which currently explains the OS-preference approach and would otherwise become a lie.

2. **Keep the `dark:` utilities live.** With the media query gone, `@custom-variant dark (@media (prefers-color-scheme: dark))` would silently disable ~21 utilities that carry real styling (`dark:bg-input/30` on inputs, `dark:border-amber-400/70` on the AI diff rows, etc.). Change it to an always-matching variant:

   ```css
   /* The app has one palette (dark). `dark:` is kept as an always-on variant
      rather than stripped from ~21 shadcn/view utilities, so files stay
      diffable against upstream shadcn output. */
   @custom-variant dark (&);
   ```

   *Alternative if that reads as too clever:* put a literal `class="dark"` on `<html>` in `index.html` and use `@custom-variant dark (.dark &)` — same result, one more moving part. Pick one; do not do both.

3. **Native window chrome.** Add `"theme": "Dark"` to the window object in `src-tauri/tauri.conf.json` (currently only `title`/`width`/`height`) so the titlebar and webview default background match the app instead of flashing light on launch. Add `<meta name="color-scheme" content="dark">` to `index.html` for the same reason at first paint, before CSS loads.

4. **Audit the hardcoded light-only colors** that the palette collapse does not reach:
   * `.error { color: #d33 }` in `styles.css` — too dark on a dark background; use `var(--destructive)`.
   * `HomeView.tsx:119,126` — `border-amber-600/40 bg-amber-50 text-amber-900` + `dark:` counterparts. Keep only the dark values, drop the light ones and the now-redundant `dark:` prefixes.
   * `SettingsView.tsx:141,192` — same shape with emerald.
   * `SegmentedScrubber.tsx:76` — `ring-black/20 dark:ring-white/20` → `ring-white/20`.
   * `LessonSegmentsView.tsx:1297–1300` — the `SEGMENT_DIFF_ROW_CLASS_NAMES` map has both light and dark tints per row kind; keep the dark ones.

   This step is optional cleanup in the sense that step 2 makes them all render correctly either way — but leaving both palettes in the class strings means the next person cannot tell which one is live.

5. **Sweep for anything else that assumed light.** `rg 'bg-white|text-black|#fff|prefers-color-scheme' src/` should come back empty (or explained) when this is done.

### Non-goals

* No theme toggle, no persisted preference, no `next-themes`-style provider. "Dark only" means the light code path stops existing, not that it becomes non-default.
* No re-tuning of the dark palette's actual values — it stays the shadcn default dark neutrals. Changing the design is a separate task from removing the light theme.

### Verification

`npm run build` (Tailwind must still emit the `dark:` rules — spot-check the built CSS for `dark:bg-input` compiling to an unconditional selector), `npm run tauri dev` with the OS set to **light** mode, walking every view: Home, Project detail, Transcript stage, Lessons, Lesson segments, Lesson editor, Export history, Settings. The OS being light is the whole test — that is the case that regressed before.

---

## 2. Sticky video preview on the lesson segments page

### Current state

`LessonSegmentsView.tsx:976` renders `.lesson-segments-preview-row` — the source player (left), a `»`, and the final-lesson player (right) — as a normal block in document flow. The segment list (`ul`, line 1027) follows it. Both `<video>` elements are capped at `height: 25vh` by `styles.css:116–121`. The page scrolls the window (`.app-shell` in `App.tsx:28` has padding and no `overflow`), and the view's root is `<div className="pb-32">` — no scroll container in between, so `position: sticky` will work without restructuring the layout.

With a lesson of a dozen-plus segments, editing a segment near the bottom means the players are off-screen: the user scrubs, scrolls down, types a bound, scrolls back up to check. That round trip is what this removes.

### Target

The preview row pins to the top of the viewport once scrolled to; segment rows pass underneath it.

### Steps

1. **Make the row sticky.** On `.lesson-segments-preview-row` (line 976), add `sticky top-0 z-30` plus an opaque background — the row must not let segment rows show through it. Reuse the same treatment as the floating AI input for visual consistency: `bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80`.

2. **Cover the shell padding.** `.app-shell` has `padding: 2rem`, so a `top-0` sticky element leaves a 2rem gap above it through which content scrolls visibly. Bleed the row horizontally and vertically with negative margins and matching padding (`-mx-8 px-8 pt-4` against the 2rem shell padding), and add `border-b border-border` so there is a clear edge between the pinned players and the scrolling list.

3. **Decide the breadcrumb/title interaction.** Breadcrumbs, title, and summary sit above the row and should scroll away normally — only the players pin. That is what `top-0` gives; no change needed, but it is the behavior to confirm rather than assume.

4. **Budget the vertical space.** Two 25vh players plus their controls is roughly 40–45vh pinned, leaving over half the viewport for the list. That is acceptable at the 1200×800 default window, tight below ~700px height. Two mitigations, in preference order:
   * Reduce the players' cap from `25vh` to `22vh` when pinned (a `.is-pinned` class toggled by an `IntersectionObserver` sentinel), or
   * Leave the height alone and accept it. **Recommended: leave it alone for the first pass** — ship the plain sticky behavior, look at it in a real window, and only add the shrink-on-pin if it actually feels cramped. Height-changing sticky headers cause scroll jitter and are not worth pre-emptive complexity.

5. **Check the stacking context.** The floating AI input is `z-50` (line 1250) and must stay above the pinned row; shadcn dialogs/alert-dialogs portal to the body and are unaffected. `z-30` on the row satisfies both. Also verify the fullscreen escape hatch (`styles.css:131–135`, `.source-preview-fullscreen`) still works — a `position: sticky` ancestor creates no containing block for `position: fixed` descendants, but the fullscreen wrapper should be re-checked in the running app rather than reasoned about.

6. **CSS location.** Prefer Tailwind utilities directly on the element, consistent with the shadcn migration Phases 5–6 noted throughout `styles.css`. Only fall back to a rule in `styles.css` for the negative-margin bleed if the utility version gets unreadable.

### Non-goals

* No collapse/expand control for the preview row, no "hide preview" toggle, no persisted pin preference. Always pinned.
* No change to either player's own behavior, controls, mark in/out, or the shared `currentTime` wiring.

### Verification

Manual, in `npm run tauri dev`, on a lesson with enough segments to scroll (create one by splitting repeatedly if needed): scroll to the last segment and confirm both players stay visible, nothing shows through the header band, the AI input still floats above everything, and opening the AI review modal and the delete confirmation still layer correctly.

---

## 3. Timeline-context toggle in the floating AI input

### Current state

The floating input (`LessonSegmentsView.tsx:1250–1271`) sends free text to `preview_lesson_segment_edit` (`src-tauri/src/openai.rs:1713`). Timestamps typed into it are interpreted on **one** timeline — the source video's — in two places:

* `extract_timestamps_seconds` (`openai.rs:1506`) scans the raw instruction and folds each timestamp ± 60s into the transcript context window (`openai.rs:1783`).
* `LESSON_EDIT_SYSTEM_PROMPT` (`openai.rs:1537`) tells the model, in as many words, that instruction timestamps are "on this same source video timeline" as the transcript's `[start-end]` prefixes, and to treat them as authoritative boundaries.

So "cut from 2:15 to 3:40" means 135s–220s **in the original recording**. If the user is watching the *final* lesson video — where 2:15 might be 47:30 of the source — that instruction silently edits the wrong part of the video.

The final-cut timeline already exists on the frontend, computed twice: `LessonSegmentsView.tsx:826–833` (`segmentOffsets`, driving the read-only "final video" columns) and `LessonPreviewPlayer.tsx:129–135` (driving its own playback readout). Both are the same cumulative-duration math.

### Target

A two-state toggle in the floating input — **Original video** / **Final video** — that determines which timeline the timestamps in the instruction are read against. Default is **Original video**, i.e. today's behavior exactly.

### Design decision: converted on the frontend, before the instruction is sent

**Shipped this way.** Two options were on the table:

* **(A)** Send the mode plus the segment map to GPT-5.5 and let it convert.
* **(B)** Convert the instruction's timestamps to source seconds ourselves, then send the backend the same source-timeline prompt it already handles.

(A) was rejected: the conversion is exact arithmetic over data we already hold, and asking the model to do it introduces silent off-by-minutes errors on precisely the thing `LESSON_EDIT_SYSTEM_PROMPT` insists must be exact.

Within (B), the conversion was planned for Rust but **implemented on the frontend** — `LessonSegmentsView` already holds the lesson's segments and the final-timeline math, so rewriting the instruction there means **zero backend changes**: no new IPC parameter, no `EditTimeline` enum, no Rust helper. `preview_lesson_segment_edit` receives an instruction whose timestamps are already source-timeline, which is exactly the contract it documents today. The context-window sizing in `openai.rs:1783` then widens around the converted values for free.

The tradeoff accepted: the instruction sent to OpenAI is not byte-identical to what the user typed (timestamps are substituted). Nothing else about it changes, and no new data category leaves the device.

### What shipped

* **`src/lib/timeline.ts`** (new) — `segmentOffsets`, `finalToSource`, and `rewriteFinalTimestampsToSource`. Its timestamp regex is deliberately the same pattern as `extract_timestamps_seconds` in `src-tauri/src/openai.rs`, including the fractional-group scaling (`78` → 0.78s, `078` → 0.078s), so the two sides can't disagree about what counts as a timestamp.
* **`LessonSegmentsView`** — `promptTimeline` state (defaults to `"original"`, not persisted), an Original/Final toggle in the floating prompt bar, and a `resolveInstruction` helper applied to both the main prompt and the review popup's refine box. The toggle's Final half is disabled when the lesson has no segments.
* The view's own `segmentOffsets` `useMemo` now calls the shared helper, so the "Final video start/end" columns and the conversion can't drift.
* **No Rust, no `db.ts`, no IPC changes.**

Also folded in while here (not in the original three): the AI review dialog is capped at `max-h-[80vh]` with a scrolling body, because its two `30vh` lists plus the refine box and footer overflowed a short window and pushed Apply/Cancel off-screen.

### Verified

The conversion was checked against the real 39-segment lesson in the local database, not just by inspection. That caught a genuine bug: offsets are a running sum of floats, so a boundary the user reads off the segment list as `00:02:52:900` (172.9) compares as *less than* the accumulated `172.90000000000003`, sending "cut from segment 38's start" to the **end of segment 37** — a different part of the video. `finalToSource` now compares with a `1e-6` tolerance. Post-fix, all 39 segment starts round-trip exactly, and boundary/clamp/negative cases match the values the app's own list displays.

This package has no frontend test runner (only Rust has tests), so that verification was a one-off script rather than a committed test. Adding `vitest` for it is the obvious follow-up if this math grows.

### Edge cases to settle in code, not at review time

* **Segment boundaries.** In the final timeline, the end of segment *i* and the start of segment *i+1* are the same instant. Treat offsets as half-open `[offset, offset + duration)` — a timestamp landing exactly on a boundary maps to the **start of the following segment**. Document the rule where the helper is defined; it is arbitrary but it must be the same arbitrary choice on both sides of the IPC boundary.
* **Timestamps past the end of the final video.** Clamp to the last segment's `end`. "Trim everything after 25:00" on a 20-minute lesson should mean "nothing to trim," not an out-of-range range the validator silently drops.
* **A lesson with no segments.** The final timeline is empty; the toggle is meaningless. Disable the Final option (with a tooltip) when `segments.length === 0`.
* **Non-timestamp instructions.** "Cut the part where he goes off about pricing" has no timestamps — the rewrite is a no-op and the mode is irrelevant. This is fine and needs no special handling, but it means the toggle only ever matters for instructions that name a time.
* **Ambiguous numbers.** The existing regex matches `h:mm:ss` / `mm:ss` / `hh:mm:ss:fff` shapes only, so "split into 3 parts" is untouched. Keep it that way — do not broaden the regex as part of this change.

### Privacy

No change to what leaves the device. The rewritten instruction is still text, still the only thing sent alongside transcript text; the timeline mode itself never leaves Rust. Re-read [`coursecut-privacy-invariants`](../.claude/skills/coursecut-privacy-invariants/SKILL.md) before touching `openai.rs` regardless — that skill is a review gate for this file.

### Non-goals

* No third mode, no per-segment-relative timestamps.
* No change to the model's contract or `LESSON_EDIT_SYSTEM_PROMPT`, which continues to describe exactly one (source) timeline.
* The manual segment editors (start/end fields, Trim/Split at playhead) stay on source time. This toggle governs the AI prompt box only — the fields are already labeled with both timelines side by side.

### Verification

`cargo test` for the new pure helpers (mapping, boundary rule, clamping, rewrite of each timestamp shape). Then manually, in a real lesson with at least three non-contiguous segments: note a moment in the final player, switch the toggle to Final, ask for a cut at that time, and confirm the review popup's proposed range lands where expected in source seconds. Run the same instruction in Source mode to confirm the old behavior is untouched.

---

## 4. Carry-forward to the web app

**No `apps/web` changes in this plan.** The web milestone is mid-flight and `docs/web-app-plan.md` §7.1 is explicit that `src/` is upstream and `apps/web/src/` is downstream — a UI change lands on desktop first and is ported forward afterward.

This section is the dock. When each change below lands on desktop, it becomes a pending port; `scripts/ui-drift.sh` will flag the upstream commits against the copied files' provenance headers, and this table says what the port actually involves.

| # | Desktop change | Upstream files | Web port notes |
|---|---|---|---|
| 1 | Dark theme only | `src/styles.css`, `index.html`, `src-tauri/tauri.conf.json` | Ports cleanly; `apps/web` has its own `styles.css` copy. The `tauri.conf.json` step has no web counterpart — the browser equivalent is the `color-scheme: dark` in `:root` plus the `<meta name="color-scheme">`, both of which carry over |
| 2 | Sticky lesson preview | `src/views/LessonSegmentsView.tsx`, `src/styles.css` | Ports as-is **if** the web shell scrolls the window like `.app-shell` does. If the web app has introduced its own scroll container, `top-0` needs re-checking against that container — the only real risk in this port |
| 3 | Timeline toggle | `src/views/LessonSegmentsView.tsx`, `src/lib/timeline.ts` (new) | **Straight copy — no web-side work.** Because the conversion ended up entirely on the frontend (§3), there is no backend counterpart to reimplement in `apps/api`: copy `timeline.ts` verbatim and port the view's toggle. Keep the regex in sync with `extract_timestamps_seconds` on both platforms |

When porting, follow §7.1's provenance-header discipline: update the recorded SHA on each copied file, including for a no-op re-sync.
