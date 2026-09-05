# CourseCut

Local-first AI desktop app that turns long lecture recordings into structured lesson videos. Full spec: `docs/PRD.md` — treat it as the source of truth for scope; this file is just the orientation layer.

## Scope guardrail — hard rule

This session exists only to work on the CourseCut repo at this working directory. If a request is about a different product, codebase, or account — even if a connected tool (MCP server, cloud credential, browser session, etc.) happens to be able to reach it — **stop and refuse to proceed**. Do not investigate, do not query, do not modify anything outside this repo. Say plainly that it's out of scope for this coursecut session and ask the user to run it in a separate session instead.

This applies regardless of how the out-of-scope request arrives (a pasted screenshot, an error message, a "quick check," an already-approved similar request earlier in the conversation) and regardless of which tools are technically available or already authenticated. Available access to another project is not authorization to act on it here. See `.claude/skills/coursecut-scope-guardrail` for the full rule and worked examples.

## Stack

Tauri v2 (Rust) + React + TypeScript + Vite, frontend-only dev server on port 1420. SQLite via a Rust-owned `rusqlite` connection (see `src-tauri/src/db.rs`) — no direct SQL surface on the frontend. Migrations live in `src-tauri/migrations/` and are applied at startup, tracked via `PRAGMA user_version`. AI: OpenAI Whisper (transcription) + GPT-5.5 (lesson analysis) — see the `coursecut-privacy-invariants` skill before touching anything that calls out to OpenAI or exports a file.

Target platforms: macOS & Windows only (PRD §"Platform"). Linux is out of scope — don't add Linux-specific build config, CI targets, or path handling on its account, and don't burn time on Linux-only bugs unless asked.

## Layout

* `src/` — React frontend
* `src-tauri/` — Rust backend, IPC commands, SQLite migrations
* `docs/PRD.md` — product spec
* `scripts/worktree.sh` — parallel-work helper, see `.claude/skills/parallel-worktrees`
* `.claude/skills/` — project knowledge: `coursecut-architecture`, `coursecut-data-model`, `coursecut-privacy-invariants`, `coursecut-scope-guardrail`, `parallel-worktrees`
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
