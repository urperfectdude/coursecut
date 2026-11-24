# HCM batch improvements plan (Desktop)

Requested 2026-11-23 for the HCM corporate training batch, which starts the week of 2026-11-30. Target app: **CourseCut Desktop** (Tauri, v1.7.0 on `main`). Branch: `feature/hcm-slides-crop-blur`.

Client asks:

1. Intro and outro slides.
2. Crop the screen between timestamps, and blur parts of the screen.
3. Remove filler words, and optionally replace the voice with a studio AI voice.

## Final scope

| # | Feature | Status on branch |
|---|---|---|
| 1 | Intro/outro: **overlay** or **insert** mode | **Built** (`0013_lesson_slides`, `IntroOutroPanel`, title cards via `titleCard.ts`); needs a hands-on test |
| 2 | Shape layers (blur / solid cover) | **Built** (`0012_lesson_regions`); crop removed 2026-11-23, so it needs a fresh review, and the in-app editor still needs a hands-on test |
| 3 | Rescript-style silence and filler removal, with word correction | In progress: see `docs/text-editing-plan.md` |
| 4 | AI studio voice from the (corrected) transcript | **V1 built** (2026-11-24): opt-in, AI voice tab, generate + preview. Export (V2) not yet; see §4 |

Build order: 2 → 1 → 3 → 4. The voice comes last because it should read the corrected transcript and fit the cut timeline.

All timed things are positioned on the lesson's **virtual timeline**, the same one `frame_overlays` uses (`0009`): 0 is the start of the lesson's own output, running across its `lesson_segments`.

> **Changing later (decided 2026-11-24):** when text editing lands (`docs/text-editing-plan.md` §7.3, Phase 4), image overlays and shapes move to **source time** so they stay on the content when words are cut, and shapes become keyed by video instead of lesson. Build features 1–2 on the virtual timeline as planned; the migration converts them.

---

## 1. Intro and outro: overlay or insert

Each lesson can have at most one intro and one outro. Each is an image (for example a PPT slide exported as PNG) or an in-app title card, with a duration and a **mode**:

* **Insert** (default): the slide becomes its own piece before or after the lecture. It adds time and covers nothing, and the lecture audio is never cut. Its audio is silence, or the AI voice's intro line once feature 4 exists.
* **Overlay**: the slide is composited over the first or last N seconds of the lesson. This is the existing `frame_overlays` mechanism. It adds no time, and there's an optional **"Mute lecture audio while showing"** toggle. Good when the lesson opens with dead air or a greeting.

Data: `lesson_slides(id, lesson_id, position 'intro'|'outro', mode 'insert'|'overlay', duration, kind 'image'|'title', image_path, title, subtitle, bg_color, text_color, mute_audio, created_at)`, with `UNIQUE(lesson_id, position)`. This will be migration `0013`. Mid-lesson slides are out of scope. The existing image overlays already cover those.

Export:

* **Insert pieces.** The image is looped with `anullsrc`, scaled and padded to the main W×H, and encoded with exactly the lecture pieces' stream params: yuv420p, probed fps, `-video_track_timescale 90000`, probed sample rate and channel count. Then everything is joined with the stream-copy `concat_videos`.
* **Overlay mode** reuses the overlay filter. Mute is `volume=0:enable='between(t,s,e)'` on the audio.
* Title cards are rendered with a frontend `<canvas>` to PNG at the video resolution and saved to the app cache dir, so the preview matches the export and there's no `drawtext` dependency.

UI: an **Intro / Outro** card in `LessonSegmentsView` with an image-or-title picker, duration, a mode toggle, and the mute toggle when the mode is overlay. The preview plays the inserted slide before or after the lecture, and shows the overlaid one on top.

---

## 2. Shape layers (blur / solid cover)

Crop was dropped by the user on 2026-11-23: shape layers cover the need, and a crop would also require a background layer.

`lesson_regions(id, lesson_id, start, end, x_percent, y_percent, w_percent, h_percent, shape 'rect'|'rounded'|'ellipse', fill 'blur'|'solid', blur_strength, color, created_at)`. Times are on the virtual timeline, and shapes may overlap each other.

* **Shape layers** are a rectangle, rounded rectangle or ellipse, either blurred or filled with a solid colour, used to hide names, emails and participant strips. Coordinates are percentages of the output frame. They are static: they don't follow moving content.
* Export chain: **shapes → image overlays**, all in literal pixels resolved in Rust (see the `resolve_segment_overlay` doc comment). Each shape is enabled on a half-open `[start, end)` window. A blurred shape cuts its patch out with ffmpeg's `crop` filter and runs `boxblur` on it; rounded and ellipse shapes use a one-frame `geq` alpha mask, looped, merged with `alphamerge`. Blur radius is capped at `min(w,h)/2 - 1` for luma and `min(w,h)/4 - 1` for chroma. With no shapes, the filter graph is unchanged from the overlay-only one.
* UI: a **Shapes (blur & cover)** card. Drag the shape on the preview, set start and end from the playhead, and see markers on the scrubber. The preview uses `backdrop-filter` for blur and `border-radius` for rounded and ellipse shapes.

---

## 3. Silence and filler removal (Rescript-style)

> Full design, including UX for non-technical users, the data model and phases, is in `docs/text-editing-plan.md`. Where the two disagree, that doc is newer, in particular on overlay and shape timing (§7.3 there).

* **Word timestamps first.** Add a `transcript_words` table (SQLite version of StepCut's, see `docs/rescript-integration-plan.md` Phase 1). It's filled by `whisper-1` with `timestamp_granularities[]=word`. VTT-imported videos still need this Whisper pass, since a VTT only has per-cue timing. The VTT text can stay the displayed transcript.
* **Fillers.** Whisper tends to drop "um" and "uh". Test on an HCM recording first with a disfluent `prompt`. Pause detection catches what's left.
* **Silences.** Gaps of at least 0.3 s (configurable) get cut, with 50 ms pads, and cuts merge across gaps under 0.35 s.
* **Word correction.** Click a word to fix it; timings stay. This feeds the captions and the AI voice.
* **Review before applying.** Proposed cuts are listed and struck through in the transcript, with one-click restore and "remove all". Cuts are derived from `deleted` flags, never stored as edits to the media.
* **Timeline.** Overlays and shape layers stay on the uncut virtual timeline and are remapped through the keep ranges at export. A cut that removes an overlay's whole span drops that overlay.
* **Licence.** Code may be adapted only from Rescript `fb71f82` (MIT), with a provenance header and `THIRD_PARTY_NOTICES.md`.
* **Privacy.** No change: the same audio goes to the same Whisper endpoint.

---

## 4. AI studio voice

The voice reads the lesson's **corrected script**: the words the lesson keeps (its `lesson_segments`), with the user's text fixes from the Script tab's **Edit** option (`docs/text-editing-plan.md` §6.4). It's an OpenAI stock voice (`gpt-4o-mini-tts`), not a clone.

### How it works (decided 2026-11-24)

* **Lines, not segments.** With per-lesson cuts a lesson can have dozens of short rows after Quick cleanup, and a clip per row would sound choppy. Instead the script is split into **one line per sentence** (transcript segment), in lesson order. A sentence with words cut out of it is still one line. A backward jump (a reordered lesson) starts a new line. Built in TS by `src/lib/voice-script.ts::buildVoiceLines` (tested).
* **Placement.** Each line starts where its first word is said in the lesson (lesson time, 0 = first kept frame; inserted intros not counted). Its slot runs to the next line's start.
* **Fitting** (`voice.rs::place_lines`, tested):
  * Shorter than its slot: played at normal speed, the rest is silence (like a speaker's pause). Never slowed down.
  * Longer: sped up with ffmpeg `atempo`, at most **1.25×**.
  * Still too long: it runs over and the next line starts when it ends (lines never overlap). Lines that start more than 0.3 s late are flagged in the tab: "shorten the text". The video is never frozen or stretched. This replaces the earlier "freeze the last frame" idea, which would have changed the edited timeline under the overlays.
* **Cache.** Each clip is cached as raw PCM (24 kHz mono) in `$APPCACHE/tts/<sha256(model, voice, style, text)>.pcm`, so regenerating after an edit only pays for changed lines. The track is rebuilt locally every time (a mono WAV in `$APPCACHE/voice_tracks/`, one per lesson).
* **Non-destructive.** The original audio stays. Nothing about the voice is stored in SQLite yet; the track lives for the editor visit and is rebuilt from the cache (free) on the next Generate.
* **Privacy.** Sending script text to the speech endpoint is a new purpose. It's behind an explicit opt-in (`ai_voice_enabled` in `app_settings`, off by default), checked in Rust on every call. `coursecut-privacy-invariants` lists it as the third allowed use. Only line text, the voice name and the optional speaking style are sent.

### Phases

| Phase | Scope | Status |
|---|---|---|
| **V0. Text fixes** | Script tab: select words, **Edit**, type the right text. Timing stays; `original_text` keeps Whisper's text; one undo step; edited words get a dotted blue underline. | **Built** 2026-11-24 |
| **V1. Generate and preview** | Settings → AI voice (opt-in, 11 stock voices, speaking style). Lesson editor **AI voice** tab: the lines, Generate (4 requests at a time, progress), per-line speed/late flags, click a line to play there. "Hear the AI voice in the Final video" mutes the recording and plays the track in sync. | **Built** 2026-11-24, needs a hands-on test with a real key |
| **V2. Export with the voice** | Per-lesson "Use AI voice" saved in SQLite (a `lesson_voice` row: enabled + the script signature), so an export can tell when the voice is stale. Export: after the pieces are joined, one more ffmpeg pass maps the video stream (copy) and the voice track as audio, delayed by an inserted intro's length and padded to the full length. Refuse with a clear message if the script changed since the voice was made. | Next |
| **V3. Polish** | Per-line regenerate; a pronunciation glossary (open question 4); intro/outro lines read by the voice; keep the recording faintly under the voice (ducking) as an option. | Later |

### Known limits of V1

* **Re-transcribing** ("Listen again", or a chunk retry) replaces the words and drops text fixes, like the other word edits (`text-editing-plan.md` §6.6).
* **Text fixes don't change `transcript_segments.text`**, so the Transcript page and GPT analysis still show Whisper's sentence. The Script tab, the voice and future captions use the fixes.
* **An edit with fewer words than it replaces** leaves the leftover words empty (still timed, shown as nothing). An edit with more words puts several on one word.
* **Edit only touches kept words.** Struck-through (cut) words in a selection are left out of the edit box, since they're never read.
* **Review (independent-reviewer, 2026-11-24): nothing blocking; privacy passes.** Fixed: Edit spreading text onto cut words; the preview voice repeating a fragment at every cut (it now waits while the video seeks or buffers); typing Whisper's own text being treated as "not edited" (reverts are now explicit, `text: null`); a stale track still playing after an edit (listening switches off); the voice playing under a muted overlay slide; track cleanup deleting another run's temp file. **Open, cosmetic:** words the user didn't change can occasionally get the "edited" underline when a paragraph starts mid-sentence (the box's text and the comparison are aligned slightly differently).
* **The track isn't saved.** Leaving the lesson and coming back needs Generate again (it reuses every cached clip, so it's free and quick).

---

## Open questions

1. **Other speakers.** HCM VTTs include students (`vidya iyer: …`). Should AI voice replace only the trainer, use one voice for everyone, or mute student lines?
2. **Captions.** Should there also be subtitles in the output (burned in, or an SRT on the edited timeline)? Cheap once feature 3 exists.
3. **Per-project defaults.** Should the intro/outro and shape layers be set once per project and inherited by every lesson?
4. **HCM pronunciation glossary** for the AI voice: wanted?

## Follow-ups found in review (feature 2)

* Shape layers, like image overlays, are silently cascade-deleted when lessons are merged or AI lessons are regenerated. A trim or split can also move or drop them on the virtual timeline. That matters more for blur shapes that hide names and emails, so warn before such an edit, or carry the shapes across.
* When a segment runs past the end of the source file, the filter path holds the last frame until `-t`. Image overlays already did this. It only matters at the very end of a recording.
