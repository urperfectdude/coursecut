# CourseCut

Local-first AI desktop app that turns long lecture recordings into structured lesson videos. Full spec: `docs/PRD.md` — treat it as the source of truth for scope; this file is just the orientation layer.

## Stack

Tauri v2 (Rust) + React + TypeScript + Vite, frontend-only dev server on port 1420. SQLite via `tauri-plugin-sql`, migrations in `src-tauri/migrations/`. AI: OpenAI Whisper (transcription) + GPT-5.5 (lesson analysis) — see the `coursecut-privacy-invariants` skill before touching anything that calls out to OpenAI or exports a file.

## Layout

* `src/` — React frontend
* `src-tauri/` — Rust backend, IPC commands, SQLite migrations
* `docs/PRD.md` — product spec
* `scripts/worktree.sh` — parallel-work helper, see `.claude/skills/parallel-worktrees`
* `.claude/skills/` — project knowledge: `coursecut-architecture`, `coursecut-data-model`, `coursecut-privacy-invariants`, `parallel-worktrees`
* `.claude/agents/` — `feature-implementer`, `independent-reviewer`, `repo-triage`

## Commands

```sh
npm install
npm run dev        # frontend only
npm run tauri dev  # full desktop app (needs Rust toolchain)
npm run typecheck
npm run lint
npm run build
```

## Working conventions

* This is a scaffold — most feature code described in the PRD doesn't exist yet. Don't assume an implementation exists; check.
* For a scoped implementation task, prefer the `feature-implementer` → `independent-reviewer` sub-agent pair over doing both in one pass — see those agents' descriptions.
* Running a second stream of work at the same time? Read `.claude/skills/parallel-worktrees` first.
* Before writing code that touches the OpenAI calls, the export pipeline, or anything that could send data off-device, read `.claude/skills/coursecut-privacy-invariants`.
