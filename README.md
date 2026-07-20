# CourseCut — AI Course Builder

Local-first desktop app (Tauri v2 + React + TypeScript) that turns long lecture recordings into structured, export-ready lesson videos. Full product spec: [`docs/PRD.md`](docs/PRD.md).

Videos never leave your computer. Only extracted audio (for Whisper transcription) and transcript text (for GPT analysis) are ever sent to OpenAI.

## Status

Scaffold stage — the app boots but the transcription/AI/export pipeline isn't implemented yet. See `docs/PRD.md` §18 for the MVP definition this is building toward.

## Prerequisites

* Node.js 20+
* Rust toolchain (`rustup`) — required for the Tauri/desktop shell, not for frontend-only work
* Platform build deps per the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)

## Setup

```sh
npm install
```

Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.

Before the first real build, generate app icons once (needed by `tauri build`, referenced in `src-tauri/tauri.conf.json`):

```sh
npm run tauri icon path/to/source-logo.png
```

Fetch the ffmpeg/ffprobe sidecars once (not committed to git — see `scripts/fetch-ffmpeg.sh`):

```sh
scripts/fetch-ffmpeg.sh
```

## Development

```sh
npm run dev        # frontend only, in a browser
npm run tauri dev  # full desktop app
```

## Checks

```sh
npm run typecheck
npm run lint
npm run build
```

## Project layout

* `src/` — React/TypeScript frontend
* `src-tauri/` — Rust backend, SQLite migrations (`src-tauri/migrations/`)
* `docs/PRD.md` — product spec, source of truth for scope and data model
* `.claude/skills/` — project knowledge (architecture, data model, privacy invariants) for Claude Code
* `.claude/agents/` — task-specific sub-agents (implementer, reviewer, repo triage)
* `scripts/worktree.sh` — helper for working on multiple branches in parallel without collisions

## Working in parallel

See [`.claude/skills/parallel-worktrees/SKILL.md`](.claude/skills/parallel-worktrees/SKILL.md).
