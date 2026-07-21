# Release process — how the Mac/Windows builds get made

This documents what shipping v1.0.0 actually required, beyond just "add a
GitHub Actions workflow." Keep it updated if the release pipeline changes.

## Current automation (as of v1.0.0)

- **`.github/workflows/ci.yml`** — runs on every push/PR to `main`: typecheck,
  lint, frontend build. Verification only, no artifacts.
- **`.github/workflows/pages.yml`** — runs on push to `main`, but only if
  `site/**` changed. Deploys the landing page to GitHub Pages.
- **`.github/workflows/release.yml`** — runs only when a tag matching
  `v*.*.*` is pushed (or via manual `workflow_dispatch`). Builds a universal
  (Apple Silicon + Intel) `.dmg` and a Windows `x64` `.exe` installer and
  publishes both to a GitHub Release under that tag.

**Plain pushes to `main` do not build the app or cut a release.** Cutting a
release is a separate, deliberate step:

```sh
git tag v1.0.1
git push origin v1.0.1
```

**The landing page needs no redeploy when a new version ships.** The download
buttons call the GitHub Releases API (`/repos/.../releases/latest`) client-side
on page load and resolve to whatever the newest published release's assets
are. Only redeploy `site/` if the page's own content/design changes.

> Open item: fully automating "release on every push to `main` that touches
> app code" (skipping the manual tag step) was requested but not yet
> implemented — it needs a decision on whether each qualifying push gets its
> own permanent release/tag, or a single rolling release gets overwritten
> each time. Revisit before building it.

## Key discoveries that shaped the design

### 1. The vendored ffmpeg binary was already broken

`src-tauri/binaries/ffmpeg-aarch64-apple-darwin` existed before this work
(committed, but still `??` untracked in git) and looked plausible — a real
arm64 Mach-O executable, ~420KB. Running it and checking `otool -L` showed
it was dynamically linked against the developer's own Homebrew install:

```
/opt/homebrew/Cellar/ffmpeg/8.1.2_1/lib/libavcodec.62.dylib
/opt/homebrew/opt/x264/lib/libx264.165.dylib
...
```

It would only have run on that one machine. A `.dmg` built with this
"working" binary would have shipped an app whose export feature crashed for
every actual user. **Lesson: always check `otool -L` / `ldd` on a sidecar
binary someone hands you before trusting it's portable — small file size for
"ffmpeg" is itself a smell, since a real static build is 60–150MB.**

### 2. GitHub has a hard 100MB-per-file push limit

The Windows static ffmpeg build alone is ~144MB (`ffmpeg.exe`). Vendoring
static ffmpeg/ffprobe binaries for all three targets (aarch64-apple-darwin,
x86_64-apple-darwin, x86_64-pc-windows-msvc) directly into git would have
either hard-failed the push (regular git, >100MB) or required Git LFS and
~450MB of repo bloat for files that change rarely and are freely
re-downloadable.

**Decision: don't commit them.** `src-tauri/binaries/*` is gitignored.
Instead, `scripts/fetch-ffmpeg.sh` downloads the right static build for a
given target triple, used both for local dev setup and inside CI immediately
before `tauri build`.

### 3. Where the static binaries actually come from

- **macOS** — [evermeet.cx](https://evermeet.cx/ffmpeg/) ships a static
  x86_64 build with `--enable-gpl --enable-libx264`, no dylib dependencies
  beyond system frameworks (verified via `otool -L` and `strings | grep
  configuration:`). No native arm64 static build is available from them.
  The same x86_64 binary is used for `aarch64-apple-darwin`,
  `x86_64-apple-darwin`, *and* `universal-apple-darwin` sidecar names — it
  runs on Apple Silicon under Rosetta 2, which avoids depending on flakier
  arm64-native sources.
  - Tried [osxexperts.net](https://www.osxexperts.net/), which does host a
    native arm64 static build, but downloads were unreliably slow/throttled
    (a 21MB file took 10+ minutes and repeatedly arrived truncated). Dropped
    in favor of the working evermeet.cx source rather than fight it.
- **Windows** — [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
  GitHub Releases, the `ffmpeg-master-latest-win64-gpl.zip` asset (static,
  GPL, includes libx264). This is the same trusted community source
  `ffmpeg.org`'s own download page points to.

**Why GPL builds specifically, not LGPL:** `src-tauri/src/ffmpeg.rs` shells
out with `-c:v libx264` for export encodes (see its doc comment — deliberate,
not a stream-copy, for compatibility). `libx264` is GPL-licensed and is not
included in LGPL-flavored static ffmpeg builds. This isn't a new licensing
decision introduced here — the pre-existing `ffmpeg.rs` code already assumed
GPL ffmpeg — just something to be aware of if CourseCut becomes closed-source
commercial later (GPL ffmpeg in the binary has redistribution implications).

### 4. Tauri's `externalBin` sidecar naming is stricter than it looks

`tauri.conf.json` declares `"externalBin": ["binaries/ffmpeg",
"binaries/ffprobe"]`. Tauri resolves the actual filename by appending the
**Rust target triple** the binary is being built for, e.g.
`binaries/ffmpeg-aarch64-apple-darwin`.

For a plain single-arch build this is one name. For
`cargo tauri build --target universal-apple-darwin`, Tauri actually:

1. Builds the `aarch64-apple-darwin` slice first — and needs
   `binaries/ffmpeg-aarch64-apple-darwin` to exist for *that* step.
2. Builds the `x86_64-apple-darwin` slice — needs
   `binaries/ffmpeg-x86_64-apple-darwin`.
3. Merges (`lipo`) them into the universal app bundle — and needs
   `binaries/ffmpeg-universal-apple-darwin` for this final bundling step.

Missing any one of the three fails the build with `resource path
'binaries/ffmpeg-<name>' doesn't exist` — the error only names whichever
step it got to, so it looks like a single missing file when it's really
"you're missing one of three names depending on how far the build got."
**Fix: `fetch-ffmpeg.sh` writes all three names from a single download** when
targeting any of the mac triples, since they're all the same binary anyway.

### 5. `pipefail` differences between local shell and CI

`scripts/fetch-ffmpeg.sh` originally did:

```sh
ROOT="$(unzip -Z1 "$TMP/win.zip" | head -1 | cut -d/ -f1)"
```

This worked fine locally (macOS `zsh`/`bash` without `pipefail`), but GitHub
Actions' Windows runner executes `bash` steps with
`--noprofile --norc -e -o pipefail`. Under `pipefail`, if `head -1` closes
the pipe after reading one line while `unzip -Z1` is still writing more
(a large zip has many entries), `unzip` gets `SIGPIPE` and the whole
pipeline reports a failing exit code (`141`), which `set -e` then turns into
a hard script failure — even though the actual value (`ROOT`) was captured
correctly.

**Fix:** capture the full command's output into a variable first
(`LISTING="$(unzip -Z1 "$TMP/win.zip")"`), then pipe *that* through `head`/
`cut`. Command substitution isn't a live pipe to a reader that can hang up
early, so there's no SIGPIPE. **General lesson: any `producer | head -N`
where the producer can outlive `head`'s interest is a latent CI-only bug if
the shell enables `pipefail` — locally it silently "just works."**

## Other decisions made along the way

- **Unsigned builds for now.** No Apple Developer ID/notarization or Windows
  code-signing cert exists yet. The landing page has an explicit note
  telling users how to bypass Gatekeeper (right-click → Open) and
  SmartScreen (More info → Run anyway). Revisit once/if paid distribution
  needs real signing.
- **Version bumped 0.1.0 → 1.0.0** (`package.json`, `Cargo.toml`,
  `tauri.conf.json`) to match the landing page's pre-existing "Version 1.0"
  marketing copy, rather than changing the copy to match the scaffold-stage
  version number.
- **`tauri.conf.json` bundle targets narrowed from `"all"` to
  `["dmg", "nsis"]`** — otherwise Windows would also produce an `.msi`
  alongside the `.exe`, and the landing page would have two Windows assets
  to disambiguate between for no benefit.
- **A privacy-invariant review ran before pushing**, since the diff touched
  `openai.rs`/`export.rs`/`ffmpeg.rs` (see
  `.claude/skills/coursecut-privacy-invariants`). Came back clean: every
  network call only reaches `api.openai.com`, only with extracted audio or
  transcript text; export and ffmpeg code have zero network calls; no
  telemetry/crash-reporting SDK was added.
