# Plan: chunked Whisper transcription for long recordings

## Problem

`extract_audio` (`src-tauri/src/ffmpeg.rs:95`) always produces mono 16kHz
16-bit PCM WAV — ~32 KB/s. `transcribe_audio` (`src-tauri/src/openai.rs:53`)
reads the whole file into memory and uploads it in a single multipart
request. A comment there claims "Whisper itself caps uploads at 25MB, so
this stays bounded" — nothing enforces that. 25MB / 32 KB/s ≈ 13 minutes, so
any recording longer than that (i.e. most real lectures — an 85-minute
video produces ~155MB) gets rejected by Whisper, surfacing as a
500/502-ish error rather than a clean, actionable message.

## Goals

1. Transcribe recordings of any length by splitting audio into
   sub-25MB chunks before upload.
2. Split at natural pauses in speech where possible, instead of always
   hard-cutting at a fixed time and risking a cut mid-word/mid-sentence.
3. No change to what leaves the device — still only ever extracted audio,
   per `coursecut-privacy-invariants`; just uploaded in pieces instead of
   one blob.
4. No regression for the common case: recordings already under the
   threshold transcribe exactly as they do today (single request).

## Design

### 1. WAV parsing (new: `src-tauri/src/wav.rs`)

A pure, dependency-free module operating on an in-memory WAV byte buffer:

* Parse the `fmt ` chunk (channels, sample rate, bits per sample → byte
  rate) and locate the `data` chunk's offset/length. Don't hardcode a
  44-byte header — walk chunks properly so this doesn't break if ffmpeg's
  wav muxer ever emits extra chunks (e.g. `LIST`/`INFO`).
* Expose the parsed sample buffer as `&[i16]` (mono, matches
  `extract_audio`'s fixed `-ac 1` output) for the silence-seeking step
  below.
* Rebuild a valid minimal WAV (RIFF/fmt/data headers with correct sizes)
  from an arbitrary sample sub-range, for emitting each chunk.

### 2. Chunk-boundary selection (silence-seeking)

Goal: avoid always hard-cutting mid-sentence.

For each target boundary (fixed interval, e.g. every ~10 minutes — chosen
so a chunk's raw PCM size stays comfortably under 25MB with margin: at
16kHz/mono/16-bit, 10 min ≈ 18.3MB):

1. Define a search window around the target time, e.g. ±20–30s.
2. Slide a short frame (~20ms) across that window; for each frame compute
   mean absolute amplitude (`sum(|sample|) / frame_len` — no sqrt needed,
   just a relative comparison).
3. Compute the window's own average frame amplitude as a local baseline
   (handles background noise: a room with HVAC hum has a higher "silence"
   floor than a quiet room, so the baseline must be judged per-window, not
   against a fixed global constant).
4. Pick the frame with the lowest amplitude, but only accept it as a real
   pause if it's a meaningful relative dip below that window's own
   baseline (e.g. under ~30–40% of it) — this is what distinguishes an
   actual pause between sentences from a merely-quieter phoneme in
   continuous noisy speech.
5. **Fallback**: if no frame in the window dips meaningfully below the
   local baseline (continuous speech/music straight through the window,
   or a uniformly loud/noisy recording with no real gap), hard-cut at the
   exact target time. Keeps the algorithm bounded — no unbounded search
   for silence that isn't there.
6. Convert the chosen frame's sample index to a byte offset into the
   `data` chunk (mono, so `sample_index * bytes_per_sample`, no channel
   multiplier) — that's the cut point.

This is plain frame-energy scanning, not a general VAD — sufficient
because we're only looking for lecture-style pauses between sentences,
not classifying speech vs. non-speech in general audio.

### 3. Splitting into chunk WAVs

Walk the full sample buffer, choosing each successive boundary via the
above until the remaining audio is short enough to be the last chunk.
Emit `Vec<(wav_bytes: Vec<u8>, start_offset_secs: f64)>` — the offset is
needed to re-align each chunk's Whisper-returned timestamps back to the
full recording's timeline.

### 4. `transcribe_audio` / `run_transcription` (`openai.rs`)

* If the audio file is at/under the safe size threshold: unchanged,
  single request (today's behavior, today's code path).
* If over threshold: split via the above, call Whisper once per chunk
  **sequentially** (simplest correct option for MVP — avoids added
  rate-limit/concurrency complexity), and offset every returned
  segment's `start`/`end` by that chunk's `start_offset_secs` before
  appending to the merged segment list, in chunk order.
* Any single chunk's request failing fails the whole transcription — the
  existing `mark_error` path in `run_transcription` already handles this;
  no partial/ambiguous transcripts get written.

### 5. Testing

* `wav.rs`: unit tests against synthetic PCM buffers (no ffmpeg, no
  network) — round-trip parse/rebuild, exact-multiple-of-chunk-size
  input, remainder chunk, and a buffer with a known quiet stretch to
  assert the silence-seeking picks a cut inside it rather than at the
  hard-coded fallback point. Also a case with an elevated noise floor
  throughout (to exercise the relative-baseline logic) and a case with no
  real pause anywhere in the window (to exercise the hard-cut fallback).
* `openai.rs`: extend existing test style (see
  `parse_lesson_suggestions_tests`) with a pure test of the
  segment-timestamp-offsetting/merge logic, independent of the network
  call.

## Known tradeoffs (accepted for this pass)

* Silence-seeking is a heuristic, not a guarantee — a recording with no
  real pauses near a boundary still gets a hard cut there.
* Sequential per-chunk requests mean total transcription time for a very
  long recording scales roughly linearly with length (e.g. ~9 chunks for
  an 85-minute lecture at 10 min/chunk) — acceptable since this already
  runs as a background job, not blocking the UI.
* No overlap/stitch-based reconciliation between chunks — rejected in
  favor of silence-seeking because it avoids adding text-alignment/dedup
  logic that could itself introduce dropped/duplicated words at a seam.

## Sequencing

1. `wav.rs`: parsing, silence-seeking boundary picker, chunk splitter —
   with unit tests.
2. `openai.rs`: threshold check, chunked call path, timestamp offsetting,
   merge into the existing insert/transaction logic in
   `run_transcription`.
3. `independent-reviewer` pass before merging (per CLAUDE.md convention),
   checking specifically against `coursecut-privacy-invariants` (only
   extracted audio bytes leave the process, in either code path).
