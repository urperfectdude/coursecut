# Text-based editing plan (Desktop)

Written 2026-11-23. Target app: **CourseCut Desktop** (Tauri, v1.7.0). This expands feature 3 ("silence and filler removal") of `docs/hcm-improvements-plan.md` into a full design, and is the desktop counterpart of `docs/rescript-integration-plan.md` (on `feature/rescript-integration`, which targets StepCut).

Goal: let a non-technical educator clean up and trim a lecture **by editing its transcript like a document**. Removing words removes that part of the video. No timeline skills needed.

---

## 1. TL;DR

* **Approach:** one list of words per video, each with a `removed` flag. Cuts are derived from that list. Nothing touches the media until export.
* **Two entry points:**
  * **Quick cleanup** on the Transcript page removes fillers and long pauses across the whole recording in one click.
  * **Fine-tuning** in the Lesson editor lets the user remove sentences and fix misheard words in one lesson.
  * Both edit the same word list.
* **The player skips removed parts live,** so the user never waits for a render to see an edit.
* **Most of the hard parts already exist as MIT code** in Rescript `v1.0.9`: the edit math, the selection hook, VAD alignment and the timeline. We adapt that code. Newer Rescript features are rebuilt from scratch (see §2).
* **We're closer than expected:** desktop transcription already requests word timestamps from Whisper (`src-tauri/src/openai.rs:459`). It uses them only to tighten segment edges and then discards them. Step 1 is to store them.

---

## 2. Licensing

| Source | License | Allowed use |
|---|---|---|
| Rescript up to `41d14da` / tag `v1.0.9` (`fb71f82`, 2026-07-30) | MIT | Copy and adapt. Keep the notice. |
| Rescript from `a9b378e` (2026-07-31) onward, including `main` | PolyForm Noncommercial 1.0.0 | Personal, noncommercial use only. **Not in CourseCut, StepCut or CourseCut Web.** Ideas may be re-implemented independently, without opening the source while doing it. |

Rules:

1. Copy only from a checkout of `fb71f82`.
2. Each adapted file starts with: `Adapted from Rescript v1.0.9 (MIT), https://github.com/wassgha/rescript/blob/fb71f82/<path>`.
3. Add `THIRD_PARTY_NOTICES.md` with Rescript's MIT text.
4. Code an AI tool produces that closely reproduces Rescript files counts as copying. The rules above still apply.

Copyright covers code, not ideas. Reading how something works and writing our own version is fine. Pasting or lightly rewording their files keeps their license attached.

---

## 3. What Rescript v1.0.9 gives us

Checked 2026-11-23 against a local clone at `fb71f82` (about 8k lines of real code).

| Feature | In v1.0.9 (MIT)? | Rescript file | Our plan |
|---|---|---|---|
| Delete words → derived cut ranges, keep ranges, time mapping | ✅ | `lib/edits.ts` (519 lines, plus 298 lines of tests) | Adapt into `src/lib/text-edit.ts` |
| Paint selection while dragging, commit on mouse-up | ✅ | `hooks/useTranscriptSelection.ts` | Adapt |
| Undo/redo with snapshots and drag gestures merged into one step | ✅ | `lib/store.ts` (zustand) | Re-implement in our existing undo pattern, no zustand |
| Show/hide removed words | ✅ | `components/TranscriptPanel.tsx` | Adapt the behaviour, restyle to shadcn |
| Remove filler words (one button) | ✅ | `lib/fillers.ts` | Adapt, extend the word list |
| Remove long pauses | ❌ | — | Build (simple: gaps between words) |
| VAD-based word timing correction | ✅ | `lib/align.ts`, `lib/vad.ts` | Adapt, run in Rust or a TS worker |
| Import SRT/VTT/JSON | ✅ | `lib/parseTranscript.ts` | We already import VTT; not needed |
| Canvas timeline: ruler, waveform, word pills, zoom, split | ✅ | `components/Timeline.tsx` (837 lines) | Later phase, optional drawer |
| Timeline Delete/Restore buttons | ❌ | — | Trivial on top of `edits.ts` |
| `…` placeholders for unspoken fillers | ❌ (post-switch) | — | Clean-room, if at all (§9) |
| Speaker rename/merge menu | ❌ (post-switch) | — | Not needed for lectures |
| Forced alignment | ❌ (post-switch) | — | Not planned; VAD anchoring is enough to start |
| Export | ffmpeg.wasm | `lib/ffmpeg.ts` | **Don't take it.** We use the native ffmpeg sidecar. |
| Transcription | in-browser Whisper | `workers/transcription.worker.ts` | **Don't take it.** We use `whisper-1`. |

---

## 4. Who we're designing for

Educators and corporate trainers (PRD §3) who:

* are comfortable in Word or Google Docs, but not in a video editor
* worry about breaking things, and won't experiment if mistakes feel permanent
* judge quality by ear: a choppy cut reads as "the app is broken"

Design principles that follow:

1. **Text first.** Editing means selecting text and removing it. The timeline is optional.
2. **Nothing is destructive.** Everything has Undo, removed words stay visible (struck through), and Restore is always one click.
3. **Show the payoff.** A constant "52:10 → 47:58" makes the effect of every edit obvious.
4. **Hide the knobs.** Padding, crossfades and merge thresholds have good defaults. The only exposed setting is "Cut tightness: Natural / Tight".
5. **Plain words.** Say "remove", "pause" and "filler word", never "cut range", "silence" or "disfluency".

---

## 5. Where it fits in the workflow

Current flow: Home → Project → **Transcript** (keep/drop sentences) → Analyze → **Lessons** → **Lesson editor** (segments, overlays, shapes) → Export.

New flow:

| Step | Page | What the user does |
|---|---|---|
| 1 | Transcript | Reviews the transcript, clicks **Clean up** (fillers and pauses), skims the result, and removes any off-topic chatter. |
| 2 | Transcript | Clicks **Analyze**. AI proposes lessons, with durations that already reflect the cleanup. |
| 3 | Lesson editor | Fine-tunes one lesson: removes sentences, fixes misheard words, adds intro/outro and blur. |
| 4 | Export | Exports with all removals applied. |

**One source of truth:** words belong to the **video**, not to a lesson. A removal made on the Transcript page appears in every lesson, and the reverse. Lessons and `lesson_segments` stay source-time ranges; word removals cut further inside them.

**The existing sentence keep/drop toggle** (`transcript_segments.keep`) becomes "remove this paragraph", which removes all its words. A migration turns existing `keep = 0` segments into removed words, so there's one system, not two.

---

## 6. UX design

### 6.1 Transcript page

```
┌──────────────────────────────────────────────────────────────────┐
│ ✨ Quick cleanup                                                  │
│   ☑ Filler words (um, uh, you know)        142 found             │
│   ☑ Long pauses (longer than 1 s)           38 found             │
│   Length: 52:10  →  47:58      [ Clean up ]   Let me review first │
└──────────────────────────────────────────────────────────────────┘
 ↶ Undo  ↷ Redo   👁 Show removed     52:10 → 47:58   [ Analyze → ]

 Speaker 1                                        ┌───────────────┐
 Okay so this is ~~um~~ what Saurav is            │               │
 mentioning ⏸1.8s all the hosts need to go        │    video      │
 to this page…                                    │               │
                                                  └───────────────┘
```

* **Quick cleanup card** shows counts and the time saved *before* the user commits. **Clean up** applies immediately and shows a toast: "Removed 142 filler words and shortened 38 pauses · Undo". **Let me review first** marks them as *suggested* (amber), without removing anything.
* **Inline pause chips** `⏸1.8s` make silence visible in text. Click one to choose: shorten / remove / keep.
* **Colours:** amber means suggested (not yet removed), red strikethrough means removed. The user can tell what the app proposed from what they decided.
* **Click a word** to jump the video there.
* **Select text** to get a floating bar: **Remove · Restore · Fix spelling**. The Delete/Backspace key removes; ⌘Z undoes.
* **Show removed** (eye toggle): on by default, so removed text stays visible and restorable. Turning it off shows the final script.
* **The active word is highlighted** during playback, and the transcript scrolls along until the user scrolls themselves (then a "Back to playhead" pill appears).

### 6.2 Preview player

* **Plays the edited version by default**, skipping removed ranges live (a `requestAnimationFrame` loop seeks past cuts).
* **"Hear original" switch** for comparing before and after.
* **The scrubber shows removed ranges** as faint hatched bands on the existing `SegmentedScrubber`.

### 6.3 Lesson editor (`LessonSegmentsView`): tabs and one video

**Decided 2026-11-24:** the lesson editor moves from stacked cards with two videos side by side to **tabs on the left and one video on the right**.

**Today:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Home › HCM Batch › lecture-01.mov › Lessons                                 │
│ Lesson 3: Checking in at a venue             [Undo] [Redo]  [ Export ]      │
├─────────────────────────────────────────────────────────────────────────────┤
│   Original video                    →     Final video                       │
│  ┌──────────────────────────┐          ┌──────────────────────────┐         │
│  │        (source)          │          │   (lesson preview)       │         │
│  └──────────────────────────┘          └──────────────────────────┘         │
│  ▶ ━━━━━━●━━━━━━━━━━━━━ 12:40         ▶ ━━●━━━━━━━━━━━━━━━ 0:42 / 6:10      │
├─────────────────────────────────────────────────────────────────────────────┤
│ Segments  (Start / End / Final range / Trim Start / Trim End / Split)       │
├─────────────────────────────────────────────────────────────────────────────┤
│ Image overlays …        Shapes (blur & cover) …        Intro / Outro …      │
└─────────────────────────────────────────────────────────────────────────────┘
```

**New:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Home › HCM Batch › lecture-01.mov › Lessons                                 │
│ Lesson 3: Checking in at a venue      6:10 → 5:22  (−0:48)                  │
│                                       [↶ Undo] [↷ Redo]  [ Export ]         │
├───────────────────────────────────────────┬─────────────────────────────────┤
│ [ Script ]  Segments   Overlays   Blur & cover   Intro/Outro                │
│ ─────────                                 │  Final video ▾  ◯ Hear original │
│ ✨ 9 filler words · 4 long pauses          │ ┌─────────────────────────────┐ │
│    in this lesson      [Clean up]         │ │                             │ │
│                                           │ │   (plays the edited         │ │
│ 👁 Show removed                            │ │    version, skipping        │ │
│                                           │ │    removed parts)           │ │
│ ┄┄ Segment 1 · 12:02–15:40 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │ │                             │ │
│ Okay so this is ~~um~~ what Saurav is     │ └─────────────────────────────┘ │
│ mentioning ⏸1.8s all the hosts need to    │ ▶  0:42 / 5:22                  │
│ go to this page app.smallworld.co and     │ ━━━━━━━●━━━━━━━━━━━━━━━━━━━━━   │
│ where they can see… ░this░ ░can░ ░be░     │ ▒   ▒▒      ▒          ▒  ▒     │
│ accessible on mobile ~~uh~~ from also…    │ ↑ removed bits (faint hatch)    │
│                                           │ ▬▬ overlays ▬ shapes ▬ slides   │
│ ┄┄ Segment 2 · 18:10–20:42 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │                                 │
│ ~~So let me just check if the screen~~    │                                 │
│ ~~is sharing properly~~ ⏸2.4s Now in the  │                                 │
│ admin panel you can see attendance…       │                                 │
│                                           │                                 │
│        ⌃ ↓ Back to playhead               │                                 │
└───────────────────────────────────────────┴─────────────────────────────────┘
   ░word░ = currently playing      ~~word~~ = removed (red)
   ⏸1.8s  = pause chip             amber underline = suggested, not yet removed
```

**Layout rules:**

* **Left: tabs.**
  * **Script** is the default tab. It shows only this lesson's words, grouped by segment.
  * **Segments, Overlays, Blur & cover and Intro/Outro** are the existing cards, moved into tabs without changing their contents. The exception is the Segments additions below.
  * The tab bar and the "Clean up" card stay pinned; only the tab content scrolls.
  * Remember the last-used tab per lesson, as a per-viewer convenience in `localStorage`.
* **Right: one video, sticky.** It stays in view while the left side scrolls.
  * **Final video** (default) plays the edited lesson and skips removed parts.
  * **Original video** (dropdown) plays the source, the current left-hand player. The two existing components stay; the dropdown chooses which one is mounted. Switching keeps the matching position: final time maps to source time through `timeline.ts`.
  * **Hear original** is a toggle. It plays from the same spot with cuts *not* skipped, for a quick comparison, without changing which video is shown.
  * The scrubber gains a faint hatched band for removed parts, above the existing overlay, shape and slide bands.
* **Header:** the lesson's before → after length (`6:10 → 5:22 (−0:48)`) next to the title, always visible.
* **Tools that place things on the video** (overlay position, shape drag handles) work on the one video. If the user is on Original video when they open the Overlays or Blur & cover tab, switch to Final video automatically, because those are placed on the output frame.
* **Narrow windows** (under about 1000 px): the video stacks above the tabs instead of beside them. It stays sticky at the top, at a smaller height.

**Selecting text in Script:**

```
│ Okay so this is what Saurav is mentioning
│              ┌────────────────────────────────────────┐
│              │ 🗑 Remove   ↺ Restore   ✏ Fix spelling  │  ⌫ also removes
│              └────────────────────────────────────────┘
│ all the hosts ▓need▓to▓go▓to▓this▓page▓ app.smallworld…
```

* **Restore** only appears if the selection contains removed words. **Fix spelling** only appears for a single word.
* The bar closes on click-away or Esc.
* Lesson-edge actions also live here: **Start lesson here** and **End lesson here** trim the lesson's first or last segment to the selected word's edge.

**Fix spelling on one word:**

```
│ go to this page ┌──────────────────┐ and where they…
│                 │ app.smallworld.co│ ✓  ✕
│                 └──────────────────┘
│                 was: "app .smallroll .com"
```

**Pause chip:**

```
│ mentioning ⏸1.8s all the hosts
│            ┌───────────────────────┐
│            │ ● Shorten to 0.3s     │
│            │ ○ Remove completely   │
│            │ ○ Keep as is          │
│            └───────────────────────┘
```

**Segments tab additions:**

```
│ Script  [ Segments ]  Overlays  Blur & cover  Intro/Outro
│ 1  "Okay so this is what Saurav…"  →  "…locations here"
│    Start 12:02  End 15:40   3:38 → 3:11 after removals
│    [Trim Start] [Trim End] [Split at playhead]
│ 2  "So let me just check…"  →  "…in the attendance tab"
│    Start 18:10  End 20:42   2:32 → 2:11 after removals
```

* Each segment shows its first and last words, so users recognise segments by what's said, not by timestamps.
* Each segment's length shows before and after removals.
* Trim Start, Trim End and Split snap to the nearest word edge.

**Undo/redo:** one stack per lesson editor covering word edits *and* the existing segment, overlay and shape edits. The user shouldn't have to know which tab an action came from to undo it. Word edits use the in-memory snapshot undo (§8.0); the existing actions keep their current undo entries on the same stack.

### 6.4 Fix spelling

* **Click a word, then Fix spelling,** to get a small inline input. The word's timing stays the same; only its text changes.
* **The corrected text is used everywhere text is shown:** the transcript, the AI analysis input (if re-run), future captions and the future AI voice.

### 6.5 Sound quality (automatic, invisible)

| Default | Value | Why |
|---|---|---|
| Pad kept beside speech | 50 ms | Avoids clipping word edges |
| Lead pad before a removed word | 80 ms | Whisper word starts run late |
| Merge cuts closer than | 0.35 s | Avoids micro-fragments |
| Long pause threshold | 1.0 s | Decision 2 |
| Long pause handling | shorten to 0.3 s | Sounds natural; full removal sounds rushed |
| Crossfade at each join | 10 ms audio `afade` | Prevents clicks and pops |

"Cut tightness: Tight" in Settings lowers the pause threshold to 0.6 s and shortens to 0.15 s.

### 6.6 Safety rails

1. **Re-transcribing an edited video would wipe its edits.** Warn first: "You've removed 312 words and fixed 4. Listening again will reset these." Offer to carry edits across by matching on time.
2. **VTT-imported videos** (`transcript_source = 'vtt'`) only have per-cue timing. Show a one-time prompt: "To edit word-by-word, CourseCut needs to listen once (about 3 min). Your VTT text is kept." The Whisper pass then gives word timings, and we keep showing the VTT text where possible.
3. **Overlays and blur shapes must stay attached to the content.** See §7.3. If a cut would remove an entire blur shape's window, keep the shape and warn instead of silently dropping it.
4. **Export summary:** "Exporting 47:58 (4:12 removed)" with a link back to the review.

### 6.7 Wording

| Avoid | Use |
|---|---|
| Cut, cut range, delete segment | Remove |
| Silence | Pause |
| Disfluency | Filler word |
| Re-transcribe | Listen again |
| Keep ranges, timeline | (don't show) |

---

## 7. Data model

Run the `coursecut-data-model` skill before writing the migration.

### 7.1 New table (migration `0014_transcript_words`)

`0013` is reserved for `lesson_slides` (HCM feature 1).

```sql
CREATE TABLE transcript_words (
    id            TEXT PRIMARY KEY,
    video_id      TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    idx           INTEGER NOT NULL,          -- order within the video
    text          TEXT NOT NULL,             -- display text (corrected if fixed)
    original_text TEXT,                      -- set when the user fixes a word
    start         REAL NOT NULL,             -- source seconds
    end           REAL NOT NULL,
    removed       INTEGER NOT NULL DEFAULT 0,
    suggested     TEXT                       -- NULL | 'filler' | 'hallucination'
);
CREATE INDEX idx_transcript_words_video_idx ON transcript_words(video_id, idx);  -- not unique, see Phase 1 status

CREATE TABLE transcript_pauses (            -- user decisions on pauses
    after_word_id TEXT PRIMARY KEY REFERENCES transcript_words(id) ON DELETE CASCADE,
    action        TEXT NOT NULL              -- 'shorten' | 'remove' | 'keep'
);
```

* **Cuts are derived, never stored.** They come from `removed` words, plus pause actions, plus existing `lesson_segments`.
* **Pauses themselves aren't stored either.** They're gaps between consecutive words, recomputed on load, and only the user's decision is persisted.
* **`transcript_segments` stays** for the AI prompt and as the paragraph grouping in the UI. Each word maps to a segment by time.
* **Data migration:** words inside a `keep = 0` segment become `removed = 1`.
* **`transcript_segments.keep` must stay in sync, not be retired.** Three existing things read it:
  * `flag_likely_hallucinations` in `openai.rs` sets `keep = false` on repeated phrases
  * GPT lesson analysis only sends `keep = 1` segments
  * export's `load_kept_segments`

  Rule: a segment's `keep` is derived as "has at least one word not removed". Write it whenever words change, in the same transaction. Hallucination flagging marks that segment's words removed **and suggested as `'hallucination'`**, so the user sees why and can restore them.

### 7.2 Transcription change

* **In `src-tauri/src/openai.rs`,** extend `WhisperWord` with `word: String` and stop discarding words after `tighten_segment_bounds_to_words`. Return them alongside segments, offset by chunk start the same way segments are.
* **Store them** in `transcript_words`, and run the existing hallucination flagging over words too.
* **The transcript cache** (by content hash) copies words along with segments. A cached entry without words counts as a miss for word editing.
* **Privacy:** no change. The same audio goes to the same endpoint, and only the response is parsed more fully. Confirm against `coursecut-privacy-invariants`.

### 7.3 Timelines: where overlays, shapes and slides live

Three things on the branch are positioned on the lesson's **virtual timeline** today (0 = start of the lesson output, running across `lesson_segments`):

| Thing | Table | How its time is set | With word cuts |
|---|---|---|---|
| Image overlays | `frame_overlays` (0009) | user-placed start/end | **Move to source time** so they stay on the content |
| Blur / solid shapes | `lesson_regions` (0012) | user-placed start/end | **Move to source time**. This matters most, because a shifted blur exposes names and emails. |
| Overlay-mode intro/outro | `lesson_slides` (0013) | derived: `[0, N)` and `[L − N, L)` from the lesson length `L` | **Stay derived,** but `L` must become the **edited** length. A slide is tied to the start and end of the output, not to content. |

**Decided (decision 3):** overlays and shapes store source seconds, the same as words. Preview and export map them through the keep ranges. If a removal covers part of a shape's window, the shape gets shorter; if it covers all of it, keep it and warn.

* **Migration** `0015_overlay_source_time` converts existing `frame_overlays` and `lesson_regions` rows from virtual to source time using each lesson's segments. `src/lib/timeline.ts` already has the virtual-to-source helpers (`finalToSource`, `virtualRangeToSourceRanges`). One virtual range can map to several source ranges when it crosses a segment join; in that case, split the row.
* **Bonus:** once on source time, shapes could be keyed by `video_id` instead of `lesson_id`. That would fix the HCM follow-up where shapes are silently cascade-deleted when lessons are merged or regenerated. Decided: yes for shapes, not for image overlays (decision 6). The migration moves `lesson_regions` to `video_id`. A shape then applies to every lesson that includes its part of the recording, which is what a privacy blur should do. The Blur & cover tab lists the shapes that fall inside the current lesson.
* **What must update for slides:** `lesson_length` in `export.rs::do_export` / `overlay_slide_windows` and `totalVirtualDuration` in `LessonPreviewPlayer` must use the edited length.

This replaces the HCM plan's earlier rule ("overlays stay on the uncut virtual timeline").

---

## 8. Architecture

```
transcript_words (SQLite, Rust-owned)
   │  get_transcript_words / update_transcript_words (IPC, batched)
   ▼
src/lib/text-edit.ts          ← adapted from Rescript v1.0.9 lib/edits.ts (MIT)
   getCutRanges(words, pauses, duration)
   getKeepRanges(cuts, duration)
   originalToEdited / editedToOriginal
   getEditedDuration
src/lib/fillers.ts            ← adapted from v1.0.9 lib/fillers.ts (MIT)
src/lib/pauses.ts             ← ours
src/hooks/useWordSelection.ts ← adapted from v1.0.9 hooks/useTranscriptSelection.ts (MIT)
   │
   ├─ TranscriptStageView / Lesson "Script" tab  → render words, selection bar
   ├─ LessonPreviewPlayer / SourceVideoPreview   → skip cuts via rAF
   └─ export (Rust)                              → keep ranges ∩ lesson_segments
                                                   → trim/atrim + 10 ms afade → concat
```

* **Keep ranges are computed in TS** and sent with the export request, or **computed again in Rust** from the same rules. Decide during Phase 3. Rust is safer, since exports shouldn't depend on UI state, but then the logic lives in two places, so both need the same unit-test fixtures.
* **Reuse `src/lib/timeline.ts`** for every mapping between virtual (lesson-output) time and source time. It already has `segmentOffsets`, `finalToSource` and `virtualRangeToSourceRanges`. Word cuts are just more holes in the same mapping, so extend those helpers to take cut ranges rather than adding a parallel `originalToEdited` in `text-edit.ts`. Keep `text-edit.ts` for word → cut-range logic only.

### 8.0 Efficiency: what Rescript does, and what we change

Checked 2026-11-24 against `fb71f82`. Rescript is built for short clips held fully in browser memory. Our lectures run up to about 2 hours (about 20k words), so some of its choices carry over and some don't.

| Area | Rescript v1.0.9 | Our version |
|---|---|---|
| **Skipping cuts in the preview** | A `requestAnimationFrame` loop (`MediaPreview.tsx`) checks `cutRangeAt(currentTime)` every frame (about 16 ms) and seeks to `cut.end + 1 ms`. At the media end it pauses at the cut start. | **Take this.** Our `LessonPreviewPlayer` moves between segments on the `timeupdate` event, which fires only about every 250 ms, so a removed "um" would be audible before the skip. Move segment jumps and word cuts onto one rAF loop. |
| **Seek stutter** | Not handled. Short clips seek fast. | **Risk for us.** Screen recordings often have long keyframe intervals, so each skip may stall. Measure in Phase 2 on a real HCM file. If it stutters: (1) **look ahead**, starting the seek one frame *before* the cut instead of after entering it; (2) if that's not enough, make a **short-keyframe preview proxy** in the background (`-g 15`, cached by content hash like the audio cache). |
| **Video on the Transcript page** | Always plays the media. | Today the Transcript page plays **audio-only WAV clips per segment** (`prepare_segment_playback_clip`). Phase 2 adds a real video player there by reusing `SourceVideoPreview`, which already plays the original file. The per-segment WAV clips then go away. |
| **Finding the active word** | Binary search over words (`lib/transcript.ts` `findActiveWordId`), O(log n). | **Take it.** |
| **Re-rendering during playback** | The time lives in zustand, and the panel subscribes only to the derived `activeWordId`, so a frame tick re-renders nothing unless the active word changes. `WordSpan` is `memo`'d. | We don't use zustand. **Keep the playback time out of React state for the transcript.** Toggle the active-word class directly on the DOM node (`[data-wid]`) from the rAF loop. Memo per **paragraph** (segment), so one edit re-renders one paragraph, not 20k words. |
| **Long transcripts** | No virtualisation (short clips). | Full virtualisation would break native text selection across unmounted words. Use **`content-visibility: auto`** on each paragraph instead. The browser skips layout and paint for off-screen text, while selection and find still work. Test with a 2 h transcript in Phase 2. |
| **Selection while dragging** | Paints `data-*` marks on word spans imperatively during the drag and commits to state only on mouse-up (`useTranscriptSelection.ts`). The trailing space sits inside each word span, so highlights are continuous. | **Take both.** |
| **Undo/redo** | Snapshot stacks (`past`/`future`) holding *references* to immutable arrays: cheap, with no copying. `beginGesture`/`endGesture` merge a drag into one step. | **Take this, and drop our current pattern for word edits.** Today's `TranscriptStageView` undo stores async closures that each `await` a database write. With in-memory snapshots, undo is instant and the database catches up through the debounced save. |
| **Saving** | Debounced autosave (500 ms) with an in-flight guard and a queued re-run (`lib/autosave.ts`); `flush` before leaving. | **Same pattern over IPC.** Edits apply in memory at once, then one batched `update_transcript_words` call fires 500 ms after the last edit. **Flush before export, before navigating away and on window close.** Undo never waits on the database. |
| **Waveform data** | Keeps the full mono 16 kHz float PCM in memory and scans samples per pixel on every redraw. | **Not viable at our length:** 2 h is about 460 MB of floats. Compute **peaks in Rust** once (about 100 min/max pairs per second, about 1.4 MB for 2 h as `i8`), cached by content hash next to the audio cache. The timeline draws from peaks only. |
| **VAD alignment** | Runs in the browser over that in-memory PCM. | Run in **Rust** over the cached audio, right after transcription. It reuses the same decoded PCM pass as the peaks. |
| **Export** | One ffmpeg command, trim/concat filtergraph. | See §8.1. |

### 8.1 Export: cuts go inside each piece, not between pieces

`export.rs::do_export` encodes **one ffmpeg run per lesson segment** (plus inserted intro/outro slides), then joins the pieces with stream-copy concat. Overlays, shapes and slide windows are mapped per piece by `overlays_for_segment`, `regions_for_segment` and `slides_for_segment`.

Turning every word cut into its own piece would mean hundreds of ffmpeg runs and hundreds of concat seams for one lesson. Instead:

* **Keep one piece per lesson segment.** Inside each piece, add a `trim`/`atrim` → short `afade` → `concat` stage for the keep ranges that fall inside that segment, then run the existing overlay and shape chain on the result.
* **Map piece-local times through the cuts.** `overlays_for_segment` and `regions_for_segment` currently compute `local = virtual − segment_offset`. With source-time rows this becomes "source → piece-local edited time", using the piece's keep ranges.
* **`ExportPiece::duration()`, progress and `lesson_length` use edited durations.**
* **Extend the single-segment fast path** (`export_lesson`) the same way.
* **Rescript v1.0.9 does the same** (`lib/ffmpeg.ts` `exportVideo`). It runs one ffmpeg command for the whole file, with one `trim`+`setpts` / `atrim`+`asetpts` branch per keep range, all fed to a single `concat=n=N`, re-encoded `libx264 -preset ultrafast -crf 22`. It never makes a separate file per cut. Two differences on our side:
  * **Seeking.** Rescript decodes the source from the start; that's fine for a 1-minute clip but not for one lesson inside a 2-hour lecture. We keep our per-segment `-ss` seek and run the trim branches inside that piece, with times relative to the seek point.
  * **Joins.** Rescript adds no fades and relies on pads and merged cuts alone. We add a 10 ms `afade` out and in at each join (cheap, prevents clicks), behind a constant we can turn off if it sounds worse.
* **Pass the graph through a file, not the command line.** A lesson with 300 keep ranges is about 70 KB of filtergraph text, which is over Windows' 32 KB command-line limit. Our `build_filter_complex` currently passes it with `-filter_complex` on the command line. Switch to `-filter_complex_script <file>` (written to the job's temp dir) whenever the graph is long, or always for simplicity.
* **Test on the existing ffmpeg test matrix:** a segment with no cuts must produce a filtergraph identical to today's, so current exports don't change.
* **Writes are batched and debounced** (`update_transcript_words` with `[{id, removed?, text?}]`), so a drag-select of 300 words is one IPC call and one undo step.
* **Undo/redo** extends the existing per-page stack pattern in `TranscriptStageView`. One action holds a word-ID set plus the before and after values.

---

## 9. Phases

| Phase | Scope | Estimate | Depends on |
|---|---|---|---|
| **0. Groundwork** | `THIRD_PARTY_NOTICES.md`; pin `fb71f82`; copy `edits.ts` and its tests into `src/lib/text-edit.ts` with the header; get the tests running | ½ day | — |
| **1. Store words** | Keep Whisper words (§7.2), migration `0014`, data migration from `keep = 0`, cache, the VTT "listen once" prompt | 1–2 days | 0 |
| **2. Edit on the Transcript page** | Video player on the Transcript page (`SourceVideoPreview`); rAF skip loop; word-level rendering grouped by segment with `content-visibility`; selection bar, Remove/Restore; in-memory snapshot undo plus debounced save; eye toggle; before → after length; click-to-seek; follow-playhead. **Measure seek stutter and 2 h scroll performance on a real HCM file.** | 4–6 days | 1 |
| **3. Quick cleanup + export** | Filler and pause detection, cleanup card, suggested/removed states, pause chips; export with keep ranges and crossfades; re-transcribe warning | 3–4 days | 2 |
| **4. Overlays follow content** | Move `frame_overlays` and `lesson_regions` to source time (§7.3), migration `0015`, remap in preview and export, slide windows on edited length | 2–3 days | 3, and HCM features 1–2 merged |
| **5. Lesson editor redesign + Script tab + Fix spelling** | Tabs on the left and one sticky video on the right (§6.3): move the existing cards into tabs; Final/Original dropdown and Hear original; Script tab; word-snapped trims; segment first/last words; corrections; one shared undo stack | 4–5 days | 3, and HCM features 1–2 merged |
| **6. Polish (pick à la carte)** | VAD alignment (`align.ts`, run in Rust); timeline drawer with waveform (`Timeline.tsx` concepts, drawn from Rust-computed peaks); SRT/VTT export on the edited timeline; clean-room `…` markers for unspoken fillers | later | 3 |

**Phase 0 status: done (2026-11-24).**

* `src/lib/text-edit.ts` is Rescript `fb71f82` `lib/edits.ts`, with the types from `lib/types.ts` inlined. The logic is byte-identical to upstream, apart from one blank line.
* `src/lib/text-edit.test.ts` is upstream `tests/edits-test.ts`, with only the import paths changed.
* `npm test` runs the tests with plain Node 24 TypeScript (no test framework added). All pass; typecheck and lint are clean.
* `THIRD_PARTY_NOTICES.md` carries the MIT text and pins `fb71f82`.
* Upstream names (`deleted`, numeric `id`) are kept to make re-checking against upstream easy. Phase 1 maps them to `transcript_words.removed` and the text `id` at the DB boundary.
* The whole of `edits.ts` was copied, including the manual-cut, scene-boundary and trim functions that only the Phase 6 timeline will use, so provenance stays one file to one file.

**Phase 1 status: built and reviewed (2026-11-24), pending a hands-on check.**

* Migration `0014_transcript_words`: `transcript_words` and `transcript_pauses`. Two changes from §7.1:
  * The `(video_id, idx)` index is **not unique**, so renumbering after a chunk re-transcription can't collide.
  * Pause decisions are keyed by **word id**, not `idx`, because `idx` is renumbered.
* **No data migration was needed.** Old videos have no words. They get them only through "Listen again" (`fetch_word_timestamps`), never automatically, since it's a paid call.
* `openai.rs`:
  * Whisper words now keep their text and come back with segments from every path (single upload, WAV chunks, time chunks, chunk retry, cache).
  * The cache copies only from a **Whisper-sourced** sibling **with words**. A VTT sibling no longer counts, which fixes VTT text being copied in as a Whisper transcript.
  * New command `fetch_word_timestamps` stores words only and leaves segments untouched. The UI prompt for it comes in Phase 2, where words are first shown.
* `words.rs` holds storage, renumbering, segment sync and `list_transcript_words`.
* **Segments and words stay in agreement:**
  * Transcription removes words inside hallucination-flagged segments (`suggested = 'hallucination'`).
  * The Transcript page's segment toggle removes or restores its words in the same transaction.
  * VTT import keeps existing words, since they time the same audio, and resets their flags.
* **Tests:** 11 new Rust tests (storage order, chunk replacement, segment sync, cache copy, cascade delete, Whisper word conversion, chunk merge). Full suite passes.
* **Review (independent-reviewer): nothing blocking.** Fixed:
  * **Segment tightening** could leave a zero-length last word outside its own segment, so it escaped the segment's keep flag. Tightened segments now end just past their last word's start.
  * **`retranscribe_chunk`** on a video with no words would have stored just that chunk's words, a partial list that looks complete. It now refreshes words only if the video already had them.
  * **Overlapping segments:** restoring one segment no longer un-removes a word that another, still-dropped segment contains.
  * **Docs:** the data-model skill now covers both tables and the invariant.
* **Phase 2 must:** label `fetch_word_timestamps` progress as "Getting word timings", not as re-transcribing (it reuses the Transcribing progress events).
* **Still to check by hand:** transcribe one real recording and confirm `transcript_words` fills with sensible timings.

**Phase 2 status: built and reviewed (2026-11-24); its Transcript-page UI was then removed, see "Change of direction" below.**

* **Transcript page, word mode** (when the video has word timings):
  * Paragraphs of words, one per segment, with punctuation and casing copied from the segment text (`punctuateWords`, display only).
  * Select words, then Remove/Restore from the floating bar or Delete/Backspace. Escape clears the selection.
  * Click a word or a paragraph's timestamp to play from there.
  * Removed words show struck through in red, or hidden with the eye toggle. A hallucination-flagged word explains itself on hover.
  * "Length 52:10 → 47:58 (−4:12)" above the transcript.
  * Undo/Redo buttons and ⌘Z / ⇧⌘Z.
  * Search and the chunk filter still work; they filter paragraphs.
* **Sticky video on the right** (`SourceVideoPreview`, two new optional props):
  * `skipRanges` jumps removed parts on every animation frame. "Skip removed parts while playing" turns it off to hear the original.
  * `onFrameTime` drives the word highlight directly on the DOM. The transcript follows the playhead until the user scrolls, then shows "Back to playhead".
* **Without word timings** the page shows the existing segment list plus an "Edit by word" card. Its **Get word timings** button runs `fetch_word_timestamps`, labelled "Getting word timings", as Phase 1's review asked.
* **Saving:**
  * Edits apply in memory at once. A batched `update_transcript_words` call goes out 500 ms after the last edit and re-derives segment `keep` in the same transaction, so Analyze sees the edits.
  * Edits are flushed before Analyze, VTT import and chunk re-transcribe, and on leaving the page.
  * A failed save keeps its edits pending and retries.
* **Performance:**
  * Paragraphs are memoised and reuse their word arrays when untouched, so an edit re-renders only the paragraphs it touched.
  * `content-visibility: auto` on each paragraph.
  * The playback time never goes through React state.
* **Adapted from Rescript v1.0.9:** `useWordSelection.ts` (from `useTranscriptSelection.ts`) and `findActiveWordIndex` (from `lib/transcript.ts`). Both have provenance headers and are listed in `THIRD_PARTY_NOTICES.md`.
* **Review (independent-reviewer): nothing blocking.** Fixed:
  * **Stop on failed save.** `flush()` now rejects if anything is still unsaved, and Analyze, VTT import, chunk re-transcribe and Get word timings stop instead of running on stale data or discarding edits.
  * **`flush()` waits for every in-flight save,** not just the first.
  * **Read-only while busy.** The transcript is read-only (no Remove/Restore/undo) while those operations run, so the reload afterwards can't drop an edit.
  * **Failed saves retry by themselves** every 3 s.
  * **The selection toolbar's actions** follow the words' current state after an undo, and the toolbar stays inside the window and container.
  * **Playhead lookup:** the DOM lookup runs only when the active word changes, not every frame.
  * **Stable callbacks:** the page uses the hook's stable functions, not the per-render object.
* **Known gaps, accepted for now:**
  * **Quitting within ~0.5 s of an edit can lose that edit.** Cmd+Q doesn't fire a close event we could wait on, and closing a window from code would need a new Tauri permission.
  * **Shift+Arrow can't extend a selection.** The video player's existing arrow-key shortcuts take those keys. Mouse selection is unaffected.
  * **Gap words are attributed differently.** A word in a gap between segments shows in the paragraph before it, but the database treats it as belonging to no segment. Display only: a paragraph can still show one kept gap word after all its own words are removed.
* **Not yet:** pause chips and the Quick cleanup card (Phase 3); Fix spelling (Phase 5).
* **Still to check by hand:**
  * whether seeking stutters on a real screen recording
  * scroll and select speed on a 2-hour transcript
  * whether the original video file plays on the Transcript page for the recordings that once needed the per-segment WAV workaround. The Lesson editor already plays them directly.

**Change of direction (2026-11-24): word editing lives only on the lesson edit screen.** After trying Phase 2, the user decided the Transcript page (where lessons are created) should not edit by word. The Transcript page is back to its sentence list with keep/drop toggles; those toggles still update the words underneath (`db::update_transcript_segment`). Word editing moved to the lesson screen as Phase 5's layout, built ahead of Phase 3b:

* **Lesson screen layout (§6.3):**
  * Tabs on the left: **Script** (default), Segments, Overlays, Blur & cover, Intro/Outro. Panels stay mounted and are hidden, so drafts survive switching.
  * One sticky video on the right with a **Final video / Original recording** toggle. Overlays, Blur & cover and Intro/Outro switch it to Final.
  * The lesson's length before → after cuts sits under the title.
  * One undo stack for word and segment edits; ⌘Z / ⇧⌘Z.
* **Script tab** (`LessonScript`):
  * This lesson's words in lesson order under "Segment N" headers, clipped to each segment's range.
  * Quick cleanup card for the lesson: fillers plus undecided long pauses, one undo step.
  * Pause chips; amber-underlined fillers; show/hide removed.
  * "Get word timings" when the video has none.
  * An amber note that exports don't apply cuts yet.
* **The Final video** skips removed words and pauses (`LessonPreviewPlayer` `skipRanges`). Clicking a word seeks there (`seekToSource`).
* **Phase 3a** (filler and pause detection, pause decisions, Quick cleanup) is built into this.
* **Not done from Phase 5:**
  * keeping the playback position when switching Final/Original
  * Fix spelling
  * first/last words per segment in the Segments tab
  * word-snapped trims
* **Review (independent-reviewer): nothing blocking.** Fixed:
  * **Undo:** one step at a time, and ⌘Z ignores key repeat and open dialogs. Holding ⌘Z could interleave segment snapshot restores.
  * **Hidden Script tab:** it can't remove words (its selection is dropped when you leave the tab).
  * **The Final player stays mounted** while Original shows, so clicking a word always seeks and toggling no longer resets playback.
  * **The cleanup message's Undo** disappears once any other edit lands on the undo stack.
  * **The word highlight and follow mode** are refreshed when returning to the Script tab.
  * **"Back to playhead"** no longer covers the AI prompt. Under 1000 px the video no longer sticks over the tab bar.
  * **Segment keep flags:** a word save now re-derives them only for segments containing a changed word, so Transcript-page keep/drop choices elsewhere aren't overwritten.
* **Next: Phase 3b + 4 together.** Export with cuts, and overlays/shapes/slide windows moved onto the edited timeline. The Final video's scrubber still shows the uncut lesson length until then.

**Per-lesson cuts (decided 2026-11-24, replaces the shared-word model on the lesson screen).** The user wants removing words to add rows in the Segments tab, and doesn't need edits shared between lessons. So:

* **Removing words in the Script tab cuts them out of this lesson's segments.** A segment becomes two rows, or shrinks. Restoring joins the rows back. Shorten/Remove on a pause chip and Quick cleanup are cuts too. Pure range logic is in `src/lib/lesson-cuts.ts` (tested).
* **The lesson's segments are the only edit state.** Each Script edit is one ordinary segment undo step (`applySegmentSnapshot`).
* **Exports cut removed words now,** because they export segments. Phase 3b's export work becomes an optimisation rather than a prerequisite.
* **Overlays and shapes** stay on the lesson's own timeline, as they do for any segment edit.
* **Script tab display:**
  * Segments that run forward in time with gaps under 60 s form one block.
  * The gaps inside a block show as struck-through words (restorable). A bigger or backward jump starts a new block under its own header.
  * The length line under the title is "blocks' span → segments' total".
* **The Final player** checks segment ends every animation frame, so it stops right before a cut-out word. The `skipRanges` prop is no longer used on this page.
* **Dropped from the lesson screen:** stored `removed` flags and pause decisions. `useWordEdits` is deleted. The backend commands `update_transcript_words` and `list_transcript_pauses` and the `transcript_pauses` table are now unused; remove them, or reuse them for StepCut. The Transcript page's keep/drop toggle still writes `removed` on words, which nothing on the lesson screen reads.
* **Review fixes (2026-11-24):**
  * **One transaction per change.** Segment changes go through a single new command, `replace_lesson_segments`, so a Script cut, an undo or a redo can't be left half done.
  * **One segment change at a time**, guarded by a single lock covering undo/redo, Script cuts and every `withSegmentUndo` edit.
  * **Selections are cut per run.** A selection is split into runs of consecutive words within one block, so selecting across blocks can't cut what lies between them.
  * **Cuts and restores know where words start.** A short unselected word between two cuts is kept; silent slivers under 0.3 s are still dropped. Restoring word by word rejoins rows without leaving hidden micro-cuts.
  * **The lesson's outer edges are restorable.** Each block shows the whole sentences at its edges, so words cut from the lesson's first or last row stay visible (struck through), and restoring them extends that row, or adds one if other removed words lie between.
  * **Quick cleanup's confirmation** (and its Undo) appears only once the cut is saved.
  * **The Final player keeps its place** when segments change, instead of jumping to row 1.
  * **The Script tab warns** when the lesson has overlays or blur boxes, which move when earlier parts are cut.
  * **The video column** fills its width at the video's aspect ratio, and a draggable divider resizes it (double-click resets; remembered per viewer).
* **Second review fixes:**
  * **Segment edits queue rather than being refused,** so an AI proposal, a typed time or a Mark In/Out add is never dropped. Each queued edit starts from the database, not stale state. Undo/redo and Script cuts ignore input while one is running.
  * **Deleting a segment** runs under the same lock.
  * **An undo step is only recorded when there is something to go back to.**
  * **Restore only touches struck parts.** It restores just the struck parts of a mixed selection (`subtractRows`), and only extends rows of the block the words are shown under, so reordered lessons restore in the right place.
  * **Known, pre-existing:** undoing a "Split at playhead" (which creates a new lesson) restores the ranges but leaves the new lesson.
* **Cost to watch:**
  * Quick cleanup on a long lesson can make dozens of rows, and each row is one ffmpeg run at export. Group consecutive rows into one run with trim/concat (the §8.1 approach applied to segments).
  * Many short rows also mean many seeks in the preview.

About **15–20 working days** for Phases 0–5.

**Testing:**
* Unit tests for `text-edit.ts`, starting from Rescript's 298-line suite, and for pauses and fillers.
* Rust tests for the keep-range export filtergraph.
* Hands-on checks on a real HCM recording: no clipped words, no pops at joins, and exported duration matching the on-screen "after" length to within 0.1 s.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| `whisper-1` drops most "um/uh", so there's little filler to find | Test a disfluent `prompt` on an HCM recording in Phase 1. Pause handling still catches most dead air. Clean-room `…` markers come in Phase 6. |
| Whisper word timings run late, so cuts clip the next word | 80 ms lead pad (Phase 3); VAD alignment (Phase 6) |
| Long lectures (2 h, ~20k words) make the transcript view slow | Paint-on-drag selection (from v1.0.9), per-paragraph memo, `content-visibility: auto`, playback time kept out of React state, batched IPC (§8.0) |
| Skipping cuts stutters on long-keyframe screen recordings | Look-ahead seek; short-keyframe preview proxy if needed (§8.0) |
| A removed word is audible before the skip | rAF loop instead of `timeupdate` (§8.0) |
| Users lose edits when re-transcribing | Warning plus carry-across by time (§6.6) |
| A cut exposes a blurred name or email | Overlays and shapes on source time (§7.3), warning on full removal |
| License slip | §2 rules; the reviewer checks every adapted file header against `fb71f82` |

---

## 11. Decisions

All decided 2026-11-24, taking the recommendations. The lesson-editor layout (tabs plus one video, §6.3) was decided the same day.

| # | Question | Decision |
|---|---|---|
| 1 | Run Quick cleanup automatically after transcription, or on click? | **On click.** One step, and the user knows what happened. |
| 2 | Long-pause threshold and handling? | **Over 1 s, shortened to 0.3 s,** not removed. "Tight" in Settings: over 0.6 s, shortened to 0.15 s. |
| 3 | Store overlay and blur-shape times on source time so they follow the content? | **Yes.** This replaces the HCM plan's "uncut virtual timeline" rule. Intro/outro overlay windows stay derived from the edited length. |
| 4 | Build before the HCM batch starts (2026-11-30), or after? | **After.** Ship HCM features 1–2 first. |
| 5 | Desktop first, or StepCut first? | **Desktop.** The pure `text-edit.ts` copies over to StepCut afterwards. |
| 6 | When moving shapes to source time, also key them by video instead of lesson? | **Yes for blur/solid shapes,** so regenerating or merging lessons no longer deletes them. Image overlays stay keyed by lesson for now. |

---|---|---|
| 1 | Run Quick cleanup automatically after transcription, or on click? | **On click.** One step, and the user knows what happened. |
| 2 | Long-pause threshold and handling? | **Over 1 s, shortened to 0.3 s,** not removed |
| 3 | Store overlay and blur-shape times on source time so they follow the content (changes the HCM plan)? | **Yes** |
| 4 | Build before the HCM batch starts (2026-11-30), or after? | **After.** Phases 0–5 are about 3 weeks. Ship HCM features 1–2 first. |
| 5 | Desktop first, or StepCut first (as `rescript-integration-plan.md` proposed)? | **Desktop,** given the HCM client need. The pure `text-edit.ts` copies over to StepCut afterwards. |
| 6 | When moving shapes to source time, also key them by video instead of lesson, so regenerating or merging lessons doesn't delete them? | **Yes for shapes** (privacy), decide separately for image overlays |

---

## 12. Sequencing with the HCM branch

Checked 2026-11-23 against the uncommitted work on `feature/hcm-slides-crop-blur`: `lesson_regions` (0012), `lesson_slides` (0013, intro/outro is now in progress), and the per-piece export changes in `export.rs` / `ffmpeg.rs`.

* **Start text editing on a new branch from `main` only after that branch is merged.** Phases 3–4 rewrite the same functions (`do_export`, `overlays_for_segment`, `regions_for_segment`, `LessonPreviewPlayer`), so working in parallel would mean painful conflicts.
* **Phases 0–2 touch different files** (`openai.rs`, a new migration, `TranscriptStageView`). They can start in a separate worktree (see `parallel-worktrees`) if waiting isn't an option. Migration numbers: words take `0014`, overlay source time takes `0015`. Re-check before merging, in case the HCM branch adds another.
