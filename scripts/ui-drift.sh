#!/usr/bin/env bash
# Reports desktop UI changes that haven't been ported into apps/web.
#
# The web app carries its own copy of the desktop UI rather than sharing a
# package (docs/web-app-plan.md §1.1). That copy can silently rot, and the
# app's founding constraint is that both targets look and behave the same —
# so this is the substitute for the compile error a shared package would
# have given us.
#
# How it works: every copied file starts with
#
#     // PORTED FROM: src/views/HomeView.tsx @ 16d83e5
#
# where the SHA is the desktop commit the copy was last synced with. For each
# such header this asks git whether the upstream file has changed since, and
# fails if any has.
#
# Fixing a report: port the upstream change into the web copy (or decide it
# doesn't apply — a §4 forced deviation, say), then update that file's SHA to
# the current desktop HEAD. `--fix` does the SHA update for you, but only run
# it once you have actually looked at each listed commit.
#
# Usage:
#   scripts/ui-drift.sh          # report drift, exit 1 if any
#   scripts/ui-drift.sh --fix    # stamp every header with the current HEAD
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

WEB_SRC="apps/web/src"
HEAD_SHA="$(git rev-parse --short HEAD)"
FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

if [ ! -d "$WEB_SRC" ]; then
  echo "No $WEB_SRC — nothing to check."
  exit 0
fi

drifted=0
broken=0
checked=0

# Walk the tree rather than a hand-maintained file list, so a newly copied
# file is covered the moment it lands.
while IFS= read -r web_file; do
  header="$(grep -m1 "PORTED FROM:" "$web_file" || true)"
  [ -n "$header" ] || continue

  upstream="$(printf '%s' "$header" | sed -E 's|.*PORTED FROM: (.+) @ [0-9a-f]+.*|\1|')"
  synced_at="$(printf '%s' "$header" | sed -E 's|.*PORTED FROM: .+ @ ([0-9a-f]+).*|\1|')"
  checked=$((checked + 1))

  if [ ! -f "$upstream" ]; then
    echo "DELETED UPSTREAM: $upstream"
    echo "  Still copied at $web_file. Delete the copy, or fix its header."
    echo
    broken=$((broken + 1))
    continue
  fi

  if ! git cat-file -e "${synced_at}^{commit}" 2>/dev/null; then
    echo "BAD SHA: $web_file records @ $synced_at, which is not a commit here."
    echo
    broken=$((broken + 1))
    continue
  fi

  commits="$(git log --oneline "${synced_at}..HEAD" -- "$upstream")"
  if [ -n "$commits" ]; then
    if [ "$FIX" -eq 1 ]; then
      # Rewrite just this file's recorded SHA, leaving the rest untouched.
      sed -i.bak -E "s|(PORTED FROM: ${upstream//\//\\/} @ )[0-9a-f]+|\1${HEAD_SHA}|" "$web_file"
      rm -f "${web_file}.bak"
      echo "STAMPED: $web_file → $HEAD_SHA"
    else
      echo "DRIFT: $upstream → $web_file"
      echo "  Changed upstream since $synced_at:"
      printf '%s\n' "$commits" | sed 's/^/    /'
      echo
    fi
    drifted=$((drifted + 1))
  fi
done < <(find "$WEB_SRC" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) | sort)

if [ "$FIX" -eq 1 ]; then
  echo "Stamped $drifted file(s) at $HEAD_SHA ($checked checked)."
  exit 0
fi

if [ "$drifted" -eq 0 ] && [ "$broken" -eq 0 ]; then
  echo "No UI drift: $checked ported file(s) are current with desktop HEAD ($HEAD_SHA)."
  exit 0
fi

echo "$drifted file(s) have drifted, $broken have broken headers ($checked checked)."
echo
echo "Port each upstream change into the web copy, then re-stamp it:"
echo "  scripts/ui-drift.sh --fix"
exit 1
