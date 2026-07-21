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
    Darwin)
      case "$(uname -m)" in
        arm64) echo "aarch64-apple-darwin" ;;
        x86_64) echo "x86_64-apple-darwin" ;;
        *) echo "Unsupported macOS arch for local ffmpeg fetch: $(uname -m)" >&2; exit 1 ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*) echo "x86_64-pc-windows-msvc" ;;
    *) echo "Unsupported host OS for local ffmpeg fetch: $(uname -s)" >&2; exit 1 ;;
  esac
}

TARGET="${1:-$(detect_host_triple)}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$TARGET" in
  aarch64-apple-darwin|x86_64-apple-darwin|universal-apple-darwin)
    # evermeet.cx (the previous source here) only ships x86_64 and
    # explicitly states it won't build for Apple Silicon — its README
    # expects Rosetta 2 to translate the x86_64 binary at runtime. That's a
    # runtime dependency this app shouldn't assume its users have installed
    # (Rosetta isn't preinstalled/auto-installed on every Apple Silicon Mac,
    # and its absence surfaces to users as an opaque
    # "could not spawn ffmpeg: Bad CPU type in executable" error). Fetch
    # genuine native builds per architecture from martin-riedl.de instead —
    # these are real arm64/x86_64 Mach-O binaries, no translation needed.
    #
    # A `cargo tauri build --target universal-apple-darwin` builds each arch
    # slice separately before merging, and looks up the sidecar under all
    # three names along the way (see the two prior fix commits in this
    # file's history), so fetch both natives and write all three names:
    # the two arch-specific ones as-is, and a real `lipo`-merged universal
    # binary (not a copy of either single-arch build) under the third.
    fetch_macos_native() {
      local site_arch="$1" out_arch="$2" # e.g. "arm64" "aarch64"
      curl -sL -A "Mozilla/5.0" -o "$TMP/ffmpeg-$out_arch.zip" \
        "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$site_arch/snapshot/ffmpeg.zip"
      curl -sL -A "Mozilla/5.0" -o "$TMP/ffprobe-$out_arch.zip" \
        "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$site_arch/snapshot/ffprobe.zip"
      unzip -o -q "$TMP/ffmpeg-$out_arch.zip" -d "$TMP" && mv "$TMP/ffmpeg" "$TMP/ffmpeg-$out_arch"
      unzip -o -q "$TMP/ffprobe-$out_arch.zip" -d "$TMP" && mv "$TMP/ffprobe" "$TMP/ffprobe-$out_arch"
      chmod +x "$TMP/ffmpeg-$out_arch" "$TMP/ffprobe-$out_arch"
    }
    fetch_macos_native arm64 aarch64
    fetch_macos_native amd64 x86_64

    cp "$TMP/ffmpeg-aarch64" "$OUT/ffmpeg-aarch64-apple-darwin"
    cp "$TMP/ffprobe-aarch64" "$OUT/ffprobe-aarch64-apple-darwin"
    cp "$TMP/ffmpeg-x86_64" "$OUT/ffmpeg-x86_64-apple-darwin"
    cp "$TMP/ffprobe-x86_64" "$OUT/ffprobe-x86_64-apple-darwin"
    lipo -create "$TMP/ffmpeg-aarch64" "$TMP/ffmpeg-x86_64" -output "$OUT/ffmpeg-universal-apple-darwin"
    lipo -create "$TMP/ffprobe-aarch64" "$TMP/ffprobe-x86_64" -output "$OUT/ffprobe-universal-apple-darwin"
    chmod +x "$OUT/ffmpeg-universal-apple-darwin" "$OUT/ffprobe-universal-apple-darwin"
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
