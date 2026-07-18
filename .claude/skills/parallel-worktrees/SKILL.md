---
name: parallel-worktrees
description: How to run two agents or two sessions on coursecut in parallel without them stepping on each other's working directory. Use when starting a second concurrent stream of work (a sub-agent alongside ongoing work, or a second manual Claude Code session on a different feature).
metadata:
  type: workflow
---

Two independent changes should never share a working directory — uncommitted edits, `dist/`, and Rust build state from one will bleed into the other.

## Sub-agents (via the `Agent` tool)

Pass `isolation: "worktree"` when spawning the agent. The harness creates an isolated git worktree automatically, runs the agent's changes there, and reports back the worktree path/branch — no manual setup needed. Use this whenever spawning a `feature-implementer` alongside other in-flight work, or running two implementers on unrelated tasks at once.

## Manual parallel sessions (you, in two terminals)

Use `scripts/worktree.sh`:

```sh
scripts/worktree.sh new <branch-name> [base-branch]   # default base: main
cd ../coursecut-worktrees/<branch-name>
npm install                                            # Node deps are per-worktree, not shared
scripts/worktree.sh list
scripts/worktree.sh rm <branch-name>                   # when done; branch itself is left intact
```

Worktrees land as siblings of this repo (`../coursecut-worktrees/<name>`), each on its own branch. Rust build output (`CARGO_TARGET_DIR`) is shared across all worktrees via a gitignored `src-tauri/.cargo/config.toml` the script writes per worktree, so you don't pay for a full Tauri/Rust rebuild every time you spin one up. `node_modules` is not shared — each worktree needs its own `npm install`.

## Rule of thumb

If two changes touch overlapping files or the same data model migration, don't parallelize them — sequence them instead. Worktrees solve *working-directory* collisions, not *merge* conflicts.
