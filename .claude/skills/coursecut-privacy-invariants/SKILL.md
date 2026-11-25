---
name: coursecut-privacy-invariants
description: The hard privacy rule coursecut is built on -- video never leaves the device, only extracted audio and transcript text may reach OpenAI. Read (and use as a review checklist) before or after touching anything that calls an external API, uploads a file, or adds telemetry/logging.
metadata:
  type: invariant
---

This is PRD principle 1 (Local First) and the core value proposition, not a soft preference — treat any violation as a blocking bug, not a style note.

## The rule

* Raw video files are **never** uploaded, streamed, or transmitted anywhere, for any feature (not previews, not crash reports, not analytics).
* Only these may be sent to OpenAI, and only for their stated purpose:
  1. **Extracted audio** → Whisper, for transcription.
  2. **Transcript text** → GPT-5.5, for lesson analysis.
  3. **Lesson script text** (the corrected words of one lesson, a line at a time), plus the chosen voice name and the user's optional speaking-style text → the speech endpoint (`/v1/audio/speech`, `gpt-4o-mini-tts`), for the AI voice. **Only while the user has turned AI voice on** (`ai_voice_enabled` in `app_settings`, off by default). `voice.rs::generate_lesson_voice` checks the flag itself on every call, not just the UI. Added 2026-11-24 (HCM feature 4). The AI voice tab's per-line **Improve** (`voice.rs::improve_voice_line`) is part of this purpose and behind the same flag: it sends one line's text plus its two neighbouring lines' text to GPT-5.5 chat completions and returns a suggestion; nothing is saved unless the user accepts it. **Improve all lines** (added 2026-11-25) makes the same per-line call for every line of the lesson, four at a time — the same data, just all of the lesson's lines — plus the editable system prompt and optional instructions from its popup (user-written text, no media).
* No other network destination should ever see project media or transcript content unless the user explicitly configures one in the future (out of scope for MVP — PRD §16 excludes cloud storage/collaboration).

## What this means in practice

* Any new Rust `#[tauri::command]` that touches the network needs to justify, in review, exactly what bytes leave the process and why.
* Crash reporting / logging must not embed transcript text or file contents — paths and error codes only.
* Export (PRD §10) writes files to a user-chosen local folder; it never uploads.
* If a future feature seems to require sending video (e.g., cloud transcoding), that's a scope violation — flag it rather than implementing it.

## Use as a review gate

`independent-reviewer` checks every diff touching network calls, export, or logging against this list before approving. If you're implementing such a change yourself, self-check against it before calling the work done.
