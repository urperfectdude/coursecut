# Rescript integration plan

Source: <https://github.com/wassgha/rescript> — reviewed at `039f75a` (2026-10-04, current `main`) and at `41d14da` / tag `v1.0.9` (2026-07-30, last MIT-licensed commit).

Goal: bring Rescript-style **text-based editing** (delete words in the transcript → the video is cut there) to our apps, without creating a licensing problem.

---

## 1. TL;DR

* **The license changed partway through.** Rescript was MIT until 2026-07-30. Commit `a9b378e` (2026-07-31) switched it to **PolyForm Noncommercial 1.0.0**, which does not allow use in a commercial product. The author's README says earlier releases "remain available under MIT for those versions only."
* **The core of what we want is in the MIT era.** Word-level cut/restore, the live preview that skips cuts, timeline sync, filler and silence removal, word correction, SRT/VTT import/export and undo/redo all shipped by `v1.0.9`. Code from that snapshot can be reused if we keep its MIT notice.
* **Anything added after 2026-07-30 must be rebuilt from scratch.** That includes CTC forced alignment, disfluency placeholders, windowed diarization, speaker editing tools and NLE/DAW timeline export. Use the idea, never the code (same approach as Recordly).
* **The single biggest gap on our side:** every app stores **segment-level** transcripts (Whisper `verbose_json` segments, roughly one sentence each). Text editing needs **word-level** timestamps. `whisper-1` can already return those (`timestamp_granularities[]=word`), so the first step is small and needs no new model.
* **Recommended first target: StepCut.** It's the product under active development, its renders are already keyed to the source timeline (zoom and speed regions compose with cuts without remapping), and "clean up the narration of a tutorial" is the obvious use. The desktop app and CourseCut Web come next, built on the same pure core.

---

## 2. Licensing — the "safely" part

| Rescript code | License | What we may do |
|---|---|---|
| Commits up to and including `41d14da` (tags `v0.1.1`–`v1.0.9`) | **MIT** | Copy and adapt. Keep the copyright notice: `Copyright (c) 2026 Rescript contributors` plus the MIT text. |
| Commit `a9b378e` (2026-07-31) onward, including today's `main` | **PolyForm Noncommercial 1.0.0** | **No code.** Re-implement the idea independently, or buy a commercial license from the author. |
| Dependencies Rescript uses: `@ffmpeg/core-mt` (ffmpeg.wasm) | GPL-family build | Not needed. We render with native ffmpeg (desktop sidecar, server-side worker). Don't adopt it. |
| `@huggingface/transformers`, `onnxruntime-web` | Apache-2.0 / MIT | Fine if we ever do on-device ASR (see §6, Phase 4). |

Rules for whoever implements this:

1. **Check out the MIT snapshot, not `main`.** `git checkout v1.0.9` (`fb71f82`) or `41d14da`. Any file copied must come from there. A file that has the same name on `main` is a different, noncommercially licensed work.
2. **Record where copied code came from.** Put a header in each adapted file: `Adapted from Rescript v1.0.9 (MIT), https://github.com/wassgha/rescript/blob/fb71f82/<path>`, and add a `THIRD_PARTY_NOTICES.md` with the MIT text.
3. **For post-switch features, don't open the post-switch source while implementing.** Work from public techniques instead: CTC/Viterbi forced alignment (wav2vec2, MMS), pyannote's own docs, the FCPXML/EDL specs.
4. **Get a quick legal look before shipping.** The MIT grant for old versions is explicit, but StepCut and CourseCut Web are paid, hosted products.

---

## 3. How Rescript's text editing works (why it feels smooth)

The whole design is "one list of words is the source of truth; everything else is derived."

```
Word { id, text, start, end, speaker, deleted }      ← the only edited state
  │
  ├─ cut ranges   = runs of consecutive deleted words, merged if < 0.35 s apart
  │                 ∪ manual cuts (timeline blade/trim)
  ├─ keep ranges  = inverse of cuts over [0, duration]
  ├─ preview      = <video> plays normally; a rAF loop jumps over cut ranges
  └─ export       = ffmpeg trim/atrim per keep range → concat → re-encode
```

What makes it feel smooth, in order of impact:

1. **Deleting never touches the media.** It flips `deleted` on some words. Cuts are derived, so delete, undo and restore are instant, and undo is just a snapshot of the word list.
2. **The preview skips cuts live.** There is no re-render to see an edit. The player loop checks the current time against cut ranges on every frame and seeks past them.
3. **Word-accurate cuts.** Export re-encodes through a trim+concat filtergraph, so cuts land on word boundaries rather than keyframes.
4. **Selection is cheap while dragging.** Native text selection marks words imperatively during the drag and commits to app state only on mouse-up, so long transcripts don't stutter.
5. **The transcript and the timeline stay in sync both ways.** Selecting in either selects in both. The active word follows the playhead, and following pauses as soon as the user scrolls.
6. **Timestamps are cleaned up before editing starts.** Whisper's word timestamps run late. MIT-era Rescript corrects this by anchoring word starts to voice-activity onsets (`lib/align.ts`), so a deleted word's cut doesn't clip the next word.
7. **Small pads.** Silence cuts leave 50 ms beside speech, and adjacent cuts merge across gaps under 0.35 s, so the result doesn't sound choppy.

---

## 4. Feature comparison

Legend: ✅ have · 🟡 partial · ❌ missing · — not applicable. "Rescript era" says which license the feature's code is under: **MIT** (reusable) or **PNC** (PolyForm Noncommercial, clean-room only).

### 4.1 Transcription

| Feature | Rescript | Era | CourseCut Desktop | CourseCut Web | StepCut |
|---|---|---|---|---|---|
| Transcription engine | Local Whisper Base/Small (transformers.js, WebGPU→WASM); Parakeet TDT optional | MIT (Parakeet: PNC) | OpenAI `whisper-1`, chunked | OpenAI `whisper-1` | OpenAI `whisper-1` |
| Runs fully on-device | ✅ | MIT | ❌ audio goes to OpenAI (video never does) | ❌ | ❌ |
| **Word-level timestamps** | ✅ | MIT | ❌ segment-level only | ❌ segment-level only | ❌ segment-level only |
| Timestamp drift correction (VAD onset anchoring) | ✅ | MIT (v1); expanded in PNC | ❌ | ❌ | ❌ |
| CTC forced alignment (exact word edges) | ✅ | **PNC** | ❌ | ❌ | ❌ |
| VAD: skip silence/music before ASR | ✅ | MIT | ❌ | ❌ | 🟡 rejects fully silent files (< −60 dBFS peak) |
| Hallucination cleanup | ✅ n-gram collapse, known phrases, trailing loop trim | MIT | 🟡 `flag_likely_hallucinations` (flags only) | ❌ not carried over in the port | 🟡 drops repeated short phrases |
| Filler detection (um/uh) | ✅ incl. untranscribed fillers via VAD placeholders | MIT (word list); placeholders: PNC | ❌ | ❌ | ❌ |
| Speaker diarization | ✅ pyannote | MIT (single pass); windowed stitching: PNC | ❌ | ❌ | ❌ |
| Language selection | ✅ EN/DE (+more later) | MIT | ❌ auto only | ❌ | ❌ |
| Import transcript (SRT/VTT/JSON) | ✅ | MIT | ❌ | ❌ | ❌ |
| Transcript cache by content hash | ❌ | — | ✅ | ✅ | ✅ |

### 4.2 Editing

| Feature | Rescript | Era | CourseCut Desktop | CourseCut Web | StepCut |
|---|---|---|---|---|---|
| **Delete words → cut video** | ✅ | MIT | ❌ (segment keep/drop toggle only) | ❌ (same) | ❌ |
| Live preview that skips cuts | ✅ | MIT | 🟡 lesson preview stitches segments virtually | 🟡 same | 🟡 per-step clip player |
| Undo / redo | ✅ snapshots | MIT | ✅ transcript stage + lesson segments | ✅ | ❌ (step delete "cannot be undone") |
| Correct a misheard word | ✅ popover, timings redistributed | MIT | ❌ | ❌ | ❌ |
| One-click remove fillers | ✅ | MIT | ❌ | ❌ | ❌ |
| One-click remove silences (≥ 0.3 s) | ✅ | MIT | ❌ | ❌ | ❌ |
| Show/hide deleted words | ✅ | MIT | 🟡 dropped segments shown struck through | 🟡 | — |
| Speaker rename/merge/move boundary | ✅ | **PNC** | ❌ | ❌ | ❌ |
| AI-proposed structure (lessons / steps) | ❌ | — | ✅ GPT-5.5 lessons + AI refine | ✅ | ✅ AI steps |
| Split at playhead / trim | ✅ scene boundaries, clip trim handles | MIT | ✅ lesson segments | ✅ | ✅ step split/merge/bounds |
| Timeline with waveform | ✅ canvas, ruler, word pills, zoom/pan | MIT | ❌ scrubber with segment overlay | ❌ | 🟡 effects timeline strip, no waveform |
| Drag word edges / cut edges | ✅ | MIT | ❌ | ❌ | ❌ |
| Transcript follows playhead | ✅ | MIT (refined in PNC) | ❌ | ❌ | ❌ |
| Zoom / speed / styled frame | ❌ | — | ❌ | ❌ | ✅ |
| Title cards, intro/outro, brand templates | ❌ | — | ❌ | ❌ | ✅ |

### 4.3 Export

| Feature | Rescript | Era | CourseCut Desktop | CourseCut Web | StepCut |
|---|---|---|---|---|---|
| MP4 with word-accurate cuts | ✅ | MIT | 🟡 segment-accurate | 🟡 | 🟡 step-accurate |
| WebM / resolution choice | ✅ | MIT | ❌ | ❌ | ❌ |
| Audio-only export (M4A/MP3/WAV) | ✅ | MIT | ❌ | ❌ | ❌ |
| Transcript TXT / Markdown | ✅ | MIT (DOCX/PDF: PNC) | ❌ | ❌ | ✅ Markdown / HTML docs per step |
| Captions SRT / VTT on the edited timeline | ✅ | MIT | ❌ (dropped in UX overhaul M1) | ❌ | ❌ |
| NLE / DAW export (FCPXML, Premiere, Resolve, AAF, EDL) | ✅ | **PNC** | ❌ | ❌ | ❌ |
| Burned-in captions | ❌ (roadmap) | — | ❌ | ❌ | ❌ |
| Public API / webhooks | ❌ | — | — | ❌ | ✅ |

### 4.4 Platform

| | Rescript | CourseCut Desktop | CourseCut Web | StepCut |
|---|---|---|---|---|
| Shell | Next.js static + Electron | Tauri v2 | React SPA + Hono API + worker | React SPA + Hono API + worker |
| Media engine | ffmpeg.wasm / native ffmpeg in Electron | ffmpeg sidecar | server ffmpeg | server ffmpeg 7.1 |
| Storage | IndexedDB (10 most recent projects) | SQLite | Postgres (RLS) + R2 | Postgres (RLS) + R2 |
| Multi-user / orgs | ❌ | ❌ | ✅ | ✅ |
| Audio-only files | ✅ | ❌ | ❌ | ❌ |

---

## 5. What we lack, ranked by value for us

1. **Word-level transcripts.** Everything else depends on this.
2. **Delete-words-to-cut, with a live preview that skips cuts.** The headline feature.
3. **Remove fillers / remove silences in one click.** The fastest win once words exist. Screen-recording narration is full of both.
4. **Better timestamp accuracy (VAD onset anchoring).** Without it, word cuts clip the following word. The MIT version is a good start.
5. **Correct a word.** Fixes transcript errors that would otherwise show up in captions and step docs.
6. **SRT/VTT export on the edited timeline.** Cheap once keep ranges exist. This is the thing desktop dropped because the timing was hard, and keep ranges make the timing straightforward.
7. **Waveform timeline with draggable cut edges.** Polish. Make it after 1–3 prove out.
8. **Speakers, NLE export, on-device ASR.** Lower priority for tutorial and lecture content. NLE export and speaker tools are PNC-era work, so they're clean-room only.

---

## 6. Integration plan

### Architecture: one pure core, copied per app

Following our existing rule that apps own their copy (`apps/web` copies the desktop UI rather than sharing a package), the edit model is a small **pure TypeScript module with no dependencies**: words in, cut/keep ranges out. It is written once and copied into each app's `src/lib/` when that app adopts it. It has no React, no store and no I/O, so it's fully unit-testable.

```
lib/text-edit.ts   (adapted from Rescript v1.0.9 lib/edits.ts, MIT)
  getCutRanges(words, duration, manualCuts) → TimeRange[]
  getKeepRanges(cuts, duration)             → TimeRange[]
  sourceToEdited / editedToSource           (time mapping for the player + captions)
lib/silences.ts    (adapted from v1.0.9, MIT)    findSilenceRanges(words, duration)
lib/fillers.ts     (adapted from v1.0.9, MIT)    filler word list + matcher
```

### Data model

Add a word table rather than widening `transcript_segments`. Segments stay as they are for the AI prompt and the existing UIs.

```sql
-- StepCut (Postgres, RLS by org like every other table)
CREATE TABLE transcript_words (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  video_id    text NOT NULL,           -- composite FK → videos(id, org_id), ON DELETE CASCADE
  idx         integer NOT NULL,        -- order within the video
  text        text NOT NULL,
  start       double precision NOT NULL,
  "end"       double precision NOT NULL,
  deleted     boolean NOT NULL DEFAULT false,
  original_text text                   -- set when the user corrects a word
);
CREATE INDEX ON transcript_words (video_id, idx);
```

* Cuts are **derived**, not stored. Only `deleted` and corrections persist, the same as Rescript.
* Cuts live on the **source timeline**, the same as StepCut's zoom and speed regions, so all three compose in one filtergraph without remapping.
* The transcript content-hash cache copies words alongside segments.
* Desktop (SQLite) and Web get the same table in their own migration later. Run the `coursecut-data-model` skill before writing either.

### Phase 0 — Groundwork (½ day)

* Add `THIRD_PARTY_NOTICES.md` with Rescript's MIT notice.
* Add a pinned reference: in the plan or notices file, record "copy only from `fb71f82`". Never vendor the repo into ours.

### Phase 1 — Word timestamps (StepCut) (1–2 days)

* `apps/stepcut-api/src/openai.ts`: send `timestamp_granularities[]=word` and `[]=segment` with `verbose_json`. Map word times through the same chunk-offset merge the segments use.
* Migration `0015_transcript_words` + RLS `0016`.
* The worker stores words alongside segments. Run the existing silence guard and hallucination filter over words too, so a dropped phrase drops its words.
* Backfill: existing videos have no words. The Re-transcribe button (already built, `force: true`) fills them. No automatic re-billing.
* **Privacy:** no change. Same audio goes to the same endpoint. Confirm against `coursecut-privacy-invariants` anyway.

### Phase 2 — Text editing in the Steps editor (3–5 days)

* Copy the pure core (§6 architecture) into `apps/stepcut/src/lib/`.
* In `StepsEditorView`, show each step's words as selectable inline text. Select and press ⌫ (or a floating Cut button) to mark them deleted; select a deleted run to restore it. Undo/redo snapshots the deleted set.
* `StepClipPlayer`: add the cut-skipping playback loop (requestAnimationFrame plus `currentTime` jump). Show edited duration.
* API: `PATCH /videos/:id/words` with a batch of `{ id, deleted }` / `{ id, text }`, debounced from the client.
* The selection hook works like Rescript's (paint during drag, commit on mouse-up), adapted from v1.0.9 `hooks/useTranscriptSelection.ts`.

### Phase 3 — Render with cuts + one-click cleanup (2–3 days)

* `apps/stepcut-worker/src/tasks/render.ts`: for each step, intersect `[step.start, step.end]` with the video's keep ranges, then trim+concat inside the existing effects filtergraph. Zoom/speed regions already keyed to source time keep working. A zoom that spans a cut simply loses the cut part.
* Step boundaries that land inside a cut snap to the cut edge.
* **Remove fillers** and **Remove silences** buttons: they only mark words deleted or add silence ranges, so they're instantly undoable.
* Markdown/HTML step docs use the edited text (deleted words dropped, corrections applied).
* Test on ffmpeg 7.1 like the effects work: duration checks, no audio pops at joins (short `afade` at each join if needed).

### Phase 4 — Accuracy and extras (later, pick à la carte)

* **VAD onset anchoring** for word starts (adapt the MIT v1.0.9 `lib/align.ts`), run in the worker after transcription. Needs VAD frame flags: use ffmpeg `silencedetect` or a small Silero ONNX run in Node.
* **Correct word** popover.
* **SRT/VTT export** on the edited timeline, plus optional burned-in captions (a natural add-on to StepCut templates).
* **Waveform timeline** with draggable cut edges (adapted from v1.0.9 `components/Timeline.tsx` concepts; our UI must match the existing shadcn design).
* **Desktop + Web port:** copy the core and selection UI into `src/` and `apps/web/src/`, and add the words table to SQLite and Postgres. On desktop the transcript stage becomes word-level. This is also where **on-device ASR** (whisper.cpp or transformers.js) fits best, because it strengthens the desktop privacy invariant (audio would stop leaving the device too).

### Explicitly not taking

* ffmpeg.wasm, Next.js, Electron, zustand, IndexedDB persistence: our stacks already cover these.
* Any PNC-era file: forced alignment, disfluency placeholders, windowed diarization, speaker tools, NLE/DAW export, DOCX/PDF transcripts, i18n catalogs. Rebuild later only if needed, clean-room.
* Telemetry/Sentry wiring.

---

## 7. Risks and open questions

| Risk | Mitigation |
|---|---|
| `whisper-1` word timestamps drift late (same issue Rescript fights) | Phase 1 ships with a small fixed lead pad (around 80 ms before each cut). Phase 4 adds VAD anchoring. Judge on real recordings before tuning. |
| Words that straddle a step boundary | Assign a word to the step containing its midpoint. Boundaries snap to word edges. |
| Cost: re-transcribing old videos for words | Opt-in through Re-transcribe. No automatic backfill. |
| An edit model in three apps drifts apart | One pure module, copied verbatim with a version comment, plus unit tests copied with it. |
| A license misstep | §2 rules. Reviewer checks every adapted file header against `fb71f82`. |

**Decisions needed from you:**

1. Confirm **StepCut first**, or start with the desktop app?
2. Is a **commercial license** from the author worth asking about? It would unlock forced alignment and NLE export without clean-room work.
3. Should Phase 4's **on-device ASR** for desktop merge with the whisper.cpp idea from the earlier session?
