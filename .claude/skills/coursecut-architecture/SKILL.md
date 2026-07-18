---
name: coursecut-architecture
description: How coursecut's pieces fit together — Tauri IPC conventions, where FFmpeg vs. MediaBunny is used, how Whisper/GPT calls are structured, and the transcript caching rule. Read before implementing import, transcription, AI analysis, editing, or export features.
metadata:
  type: architecture
---

Source of truth for scope and requirements is `docs/PRD.md`. This skill covers implementation conventions the PRD doesn't spell out.

## Process boundary

* **Rust (`src-tauri/`)** owns: filesystem access, FFmpeg invocation, SQLite (via `tauri-plugin-sql`), and any OpenAI network calls (so API keys never touch the renderer's JS context). Expose functionality to the frontend as `#[tauri::command]` functions, invoked from React via `@tauri-apps/api/core`'s `invoke()`.
* **React (`src/`)** owns: UI, transcript editing state, and lightweight in-browser video preview/probing via **MediaBunny** — used for scrubbing/waveform/preview without a round-trip through FFmpeg. MediaBunny never touches the source file on disk directly for anything destructive; it's a preview layer only.

## FFmpeg

FFmpeg does the two operations that must produce real files on disk: **audio extraction** (PRD §7.3, local-only, run once per imported video) and **export encoding** (PRD §10, MP4 + burned/soft SRT per lesson). Invoke it from Rust as a subprocess (sidecar or system binary — not yet wired up in the scaffold). Never invoke FFmpeg from the frontend.

Videos are never modified or deleted in place (PRD principle 6, non-destructive) — FFmpeg only ever reads the source and writes new output files (extracted audio, exported lesson clips).

## Transcription & AI analysis

* Whisper and GPT-5.5 calls happen from Rust, over the network, sending **only**: extracted audio (Whisper) or transcript text (GPT). Never raw video. See `coursecut-privacy-invariants`.
* Transcript caching (PRD §7.4): key the cache by a content hash of the source video file, not the file path (paths can change; content shouldn't be retranscribed). Before calling Whisper, check for an existing transcript keyed by that hash and skip the call if present.
* AI analysis (lesson boundaries, Q&A/discussion/silence detection) attaches a confidence score to every suggestion (PRD §7.5) — surfaced in the review UI, never auto-applied without the user seeing it (PRD principle 4, AI-assisted not AI-decided).

## Editing modes

Transcript Mode (PRD §8.1) is the primary editing surface and should stay the default; Timestamp Mode (PRD §8.2) is a fallback precision editor, not a second full editor — don't duplicate transcript-editing logic there. Both operate on the same `lessons` / `transcript_segments` rows.
