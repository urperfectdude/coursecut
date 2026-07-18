#!/usr/bin/env bash
set -euo pipefail

# Manage git worktrees for parallel work on coursecut, so two people (or two
# agents) on different branches never collide in the same working directory.
#
# Worktrees live as siblings of this repo, under ../coursecut-worktrees/<name>,
# each on its own branch. All worktrees share one Cargo build cache (via a
# per-worktree, gitignored src-tauri/.cargo/config.toml) so Rust builds
# aren't duplicated per worktree. Node deps are NOT shared — run `npm install`
# in each worktree after creating it.

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREES_DIR="$(dirname "$REPO_ROOT")/coursecut-worktrees"
SHARED_CARGO_TARGET="$(dirname "$REPO_ROOT")/coursecut-shared-cargo-target"

usage() {
  cat <<EOF
Usage:
  scripts/worktree.sh new <name> [base-branch]   Create a worktree + branch <name> (default base: main)
  scripts/worktree.sh list                       List active worktrees
  scripts/worktree.sh rm <name>                   Remove a worktree (branch is left intact)
EOF
}

cmd_new() {
  local name="${1:?worktree name required}"
  local base="${2:-main}"
  local path="$WORKTREES_DIR/$name"

  mkdir -p "$WORKTREES_DIR"
  git -C "$REPO_ROOT" worktree add -b "$name" "$path" "$base"

  mkdir -p "$path/src-tauri/.cargo"
  cat > "$path/src-tauri/.cargo/config.toml" <<CARGO
[build]
target-dir = "$SHARED_CARGO_TARGET"
CARGO

  echo ""
  echo "Worktree ready at $path"
  echo "Next: cd $path && npm install"
}

cmd_list() {
  git -C "$REPO_ROOT" worktree list
}

cmd_rm() {
  local name="${1:?worktree name required}"
  local path="$WORKTREES_DIR/$name"
  git -C "$REPO_ROOT" worktree remove "$path"
  echo "Removed worktree $path (branch '$name' left intact — delete with 'git branch -d $name' if you're done with it)"
}

case "${1:-}" in
  new) shift; cmd_new "$@" ;;
  list) cmd_list ;;
  rm) shift; cmd_rm "$@" ;;
  *) usage; exit 1 ;;
esac
