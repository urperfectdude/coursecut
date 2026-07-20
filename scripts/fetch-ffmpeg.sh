#!/usr/bin/env bash
# Downloads static ffmpeg/ffprobe sidecars into src-tauri/binaries/, named per
# Tauri's externalBin convention (<name>-<target-triple>[.exe]).
#
# Not committed to git (144MB+ per binary would blow past GitHub's 100MB
# file limit) — run this once locally before `tauri dev`/`tauri build`, and
# it also runs in CI before packaging a release.
#
# Usage: scripts/fetch-ffmpeg.sh [target-triple]
#   With no argument, detects the host triple (for local dev).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
OUT=src-tauri/binaries
mkdir -p "$OUT"

detect_host_triple() {
  case "$(uname -s)" in
    Darwin) echo "aarch64-apple-darwin" ;; # Rosetta 2 covers Intel via the same sidecar below
    MINGW*|MSYS*|CYGWIN*) echo "x86_64-pc-windows-msvc" ;;
    *) echo "Unsupported host OS for local ffmpeg fetch: $(uname -s)" >&2; exit 1 ;;
  esac
}

TARGET="${1:-$(detect_host_triple)}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$TARGET" in
  aarch64-apple-darwin|x86_64-apple-darwin|universal-apple-darwin)
    # evermeet.cx ships a static x86_64 build (libx264/libx265/aac baked in,
    # no dylib deps beyond system frameworks); it runs on Apple Silicon
    # under Rosetta 2, so the same pair covers aarch64, x86_64, and the
    # universal-apple-darwin sidecar name `cargo tauri build --target
    # universal-apple-darwin` looks for.
    curl -sL -o "$TMP/ffmpeg.zip" https://evermeet.cx/ffmpeg/ffmpeg-8.1.2.zip
    curl -sL -o "$TMP/ffprobe.zip" https://evermeet.cx/ffmpeg/ffprobe-8.1.2.zip
    unzip -o -q "$TMP/ffmpeg.zip" -d "$TMP"
    unzip -o -q "$TMP/ffprobe.zip" -d "$TMP"
    cp "$TMP/ffmpeg" "$OUT/ffmpeg-$TARGET"
    cp "$TMP/ffprobe" "$OUT/ffprobe-$TARGET"
    chmod +x "$OUT/ffmpeg-$TARGET" "$OUT/ffprobe-$TARGET"
    ;;
  x86_64-pc-windows-msvc)
    curl -sL -o "$TMP/win.zip" https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip
    LISTING="$(unzip -Z1 "$TMP/win.zip")"
    ROOT="$(echo "$LISTING" | head -1 | cut -d/ -f1)"
    unzip -o -q "$TMP/win.zip" "$ROOT/bin/ffmpeg.exe" "$ROOT/bin/ffprobe.exe" -d "$TMP"
    cp "$TMP/$ROOT/bin/ffmpeg.exe" "$OUT/ffmpeg-$TARGET.exe"
    cp "$TMP/$ROOT/bin/ffprobe.exe" "$OUT/ffprobe-$TARGET.exe"
    ;;
  *)
    echo "Unknown target triple: $TARGET" >&2
    exit 1
    ;;
esac

echo "Fetched ffmpeg/ffprobe for $TARGET into $OUT/"
