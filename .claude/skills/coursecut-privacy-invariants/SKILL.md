---
name: coursecut-privacy-invariants
description: The hard privacy rule coursecut is built on -- video never leaves the device, only extracted audio and transcript text may reach OpenAI. Read (and use as a review checklist) before or after touching anything that calls an external API, uploads a file, or adds telemetry/logging.
metadata:
  type: invariant
---

This is PRD principle 1 (Local First) and the core value proposition, not a soft preference — treat any violation as a blocking bug, not a style note.

## The rule

* Raw video files are **never** uploaded, streamed, or transmitted anywhere, for any feature (not previews, not crash reports, not analytics).
* Only two things may be sent to OpenAI, and only for their stated purpose:
  1. **Extracted audio** → Whisper, for transcription.
  2. **Transcript text** → GPT-5.5, for lesson analysis.
* No other network destination should ever see project media or transcript content unless the user explicitly configures one in the future (out of scope for MVP — PRD §16 excludes cloud storage/collaboration).

## What this means in practice

* Any new Rust `#[tauri::command]` that touches the network needs to justify, in review, exactly what bytes leave the process and why.
* Crash reporting / logging must not embed transcript text or file contents — paths and error codes only.
* Export (PRD §10) writes files to a user-chosen local folder; it never uploads.
* If a future feature seems to require sending video (e.g., cloud transcoding), that's a scope violation — flag it rather than implementing it.

## Use as a review gate

`independent-reviewer` checks every diff touching network calls, export, or logging against this list before approving. If you're implementing such a change yourself, self-check against it before calling the work done.
