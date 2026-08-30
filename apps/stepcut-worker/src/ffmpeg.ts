// ffmpeg and ffprobe.
//
// `probeDuration`/`extractAudio` are Phase 2's; `cutSegment`/`concatVideos`/
// `renderTitleCard` are Phase 5 ("Templates & render")'s, ported from
// `apps/worker/src/ffmpeg.ts` (`src-tauri/src/ffmpeg.rs`, by way of that
// port) with one required change: this project's `concatVideos` stream-copies
// (`-c copy`), which needs every input file — cut segments *and* title
// cards — to share identical video parameters. coursecut's single-resolution
// export never had anything to match, so its `cutSegment` never scaled; this
// one does, against the render's template `target_width`/`target_height`/
// `target_fps`. `renderTitleCard` has no coursecut original at all — a
// template's intro/outro/logo/title-card compositing is new to this phase.
//
// `child_process.spawn` on the system binary (pinned in the worker image for
// production, `FFMPEG_PATH`/`FFPROBE_PATH` to override). This module only
// ever reads local files the worker downloaded to scratch and writes new
// local files. It makes no network call and touches no database; the source
// object in storage is never modified.

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../../stepcut-api/src/env.js";

/** ffmpeg logs its banner and warnings to stderr even when it succeeds. Keep
 * a bounded tail so a real failure's message is useful without holding a
 * whole long encode's log in memory. */
const MAX_STDERR_TAIL = 4000;

/**
 * A running ffmpeg process, with the handle a caller needs to stop it.
 *
 * Cancellation for a render arrives through the `renders` row, in a
 * *different* process than the one running ffmpeg (the API marks the row),
 * so `tasks/render.ts` polls the row and calls `kill()` itself — the same
 * indirection `apps/worker`'s copy of this file documents for exports.
 */
export interface FfmpegRun {
  done: Promise<void>;
  kill: () => void;
}

class FfmpegError extends Error {}

function runFfmpeg(args: string[], onStdoutLine?: (line: string) => void): FfmpegRun {
  let child: ChildProcess | undefined;
  let killed = false;

  const done = new Promise<void>((resolve, reject) => {
    child = spawn(env.ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderrTail = "";
    let stdoutBuffer = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!onStdoutLine) return;
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      // The last piece may be a partial line; hold it for the next chunk.
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) onStdoutLine(line);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail += chunk.toString();
      if (stderrTail.length > MAX_STDERR_TAIL) {
        stderrTail = stderrTail.slice(stderrTail.length - MAX_STDERR_TAIL);
      }
    });

    child.on("error", (err) => reject(new FfmpegError(`could not spawn ffmpeg: ${err.message}`)));

    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new FfmpegError(
          killed
            ? "ffmpeg was stopped"
            : `ffmpeg exited with code ${code} (signal ${signal}): ${stderrTail.trim()}`,
        ),
      );
    });
  });

  return {
    done,
    kill: () => {
      killed = true;
      child?.kill("SIGKILL");
    },
  };
}

/** A video's duration in seconds, via ffprobe. Local-only: the path is a CLI
 * argument and nothing is uploaded. */
export function probeDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      env.ffprobePath(),
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => reject(new Error(`ffprobe failed to run: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with an error: ${stderr.trim()}`));
        return;
      }
      const duration = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(duration)) {
        reject(new Error(`could not parse ffprobe duration output ${JSON.stringify(stdout)}`));
        return;
      }
      resolve(duration);
    });
  });
}

/** Whether `videoPath` has an audio stream at all. `cutSegment` needs this: a
 * source with no audio (a silent intro/outro bumper, most plausibly) would
 * otherwise produce a video-only cut, and `concatVideos`'s `-c copy` demuxer
 * locks its stream mapping to whichever input it sees first — mixing a
 * video-only file into that sequence silently drops the *entire render's*
 * audio, or desyncs it, with no error anywhere in the pipeline. */
function probeHasAudio(videoPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      env.ffprobePath(),
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", videoPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => reject(new Error(`ffprobe failed to run: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with an error: ${stderr.trim()}`));
        return;
      }
      resolve(stdout.trim().length > 0);
    });
  });
}

/**
 * Extracts mono 16 kHz audio, Opus-encoded in an Ogg container — a format
 * Whisper accepts. Reads the source video and writes only the new audio
 * file; the source is never modified.
 *
 * Whisper caps an upload at 25 MB for every model; Opus at 24 kbps is
 * ~3 KB/s — over two hours in one request — and Whisper resamples to 16 kHz
 * mono internally anyway, so what compression drops is what the model
 * discards.
 */
export async function extractAudio(videoPath: string, outputPath: string): Promise<void> {
  await runFfmpeg([
    "-i", videoPath,
    "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "libopus", "-b:a", "24k",
    "-y", outputPath,
  ]).done;
}

/**
 * Trims `[start, end)` into a frame-accurate re-encode, scaled/padded/reframed
 * to the render's template dimensions and framerate.
 *
 * `-ss <start>` **before** `-i` for fast input seeking, then `-t <end-start>`
 * (a duration, not `-to`) **after** `-i` for the output length — coursecut's
 * invocation, unchanged: the unambiguous way to say "encode exactly this many
 * seconds from the seek point", with no dependence on how a given ffmpeg
 * build reads `-to` after an input seek.
 *
 * `libx264`/`aac` rather than `-c copy`: stream-copy can only cut on keyframe
 * boundaries, which would silently ignore the step's exact start/end.
 *
 * The `-vf scale…,pad…,fps…` chain is this project's addition (see this
 * file's header): `scale` fits the source frame inside the template's box
 * without distorting it, `pad` letterboxes/pillarboxes whatever gap that
 * leaves, and `fps` normalizes the frame rate — the three things that have to
 * match across every input for `concatVideos`'s `-c copy` to work at all,
 * since a render mixes footage from one source video with title cards
 * generated at a fixed resolution.
 *
 * Progress comes from ffmpeg's own `-progress pipe:1` (`out_time_ms=` is
 * microseconds despite the name) divided by the known duration, reported as a
 * fraction in [0, 1]. Only forward movement of at least 0.5% is reported, so a
 * fast encode does not spam the caller — and, transitively, Postgres — with
 * dozens of near-identical writes a second.
 *
 * The returned handle is what cancellation uses: a killed process surfaces as
 * a rejected `done`, which the caller tells apart from a genuine failure by
 * checking whether the render row was already `cancelled`.
 *
 * Async only because of `probeHasAudio`: a source with no audio stream (most
 * plausibly a silent intro/outro bumper — see that function's comment) gets a
 * synthetic silent track mixed in, so this cut always emits exactly one video
 * and one audio stream, matching every other input `concatVideos` joins.
 */
export async function cutSegment(
  videoPath: string,
  start: number,
  end: number,
  outputPath: string,
  targetWidth: number,
  targetHeight: number,
  targetFps: number,
  onProgress: (fraction: number) => void,
): Promise<FfmpegRun> {
  const duration = Math.max(0, end - start);
  let lastReported = -1;
  const scaleFilter =
    `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,` +
    `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,fps=${targetFps}`;
  const hasAudio = await probeHasAudio(videoPath);

  const run = runFfmpeg(
    [
      "-y",
      "-ss",
      String(start),
      "-i",
      videoPath,
      ...(hasAudio ? [] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
      "-map",
      "0:v:0",
      "-map",
      hasAudio ? "0:a:0" : "1:a",
      "-t",
      String(duration),
      "-vf",
      scaleFilter,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-progress",
      "pipe:1",
      "-nostats",
      outputPath,
    ],
    (line) => {
      const value = line.trim().startsWith("out_time_ms=") ? line.trim().slice(12) : undefined;
      if (value === undefined || duration <= 0) return;
      const micros = Number.parseFloat(value);
      if (!Number.isFinite(micros)) return;
      const fraction = Math.min(1, Math.max(0, micros / 1_000_000 / duration));
      if (fraction > lastReported + 0.005) {
        lastReported = fraction;
        onProgress(fraction);
      }
    },
  );

  return {
    kill: run.kill,
    done: run.done.then(() => onProgress(1)),
  };
}

/**
 * Joins `inputPaths` in order via the concat demuxer with stream copy — safe
 * here specifically because every input (cut segments and title cards alike)
 * was just produced with the same libx264/yuv420p/aac settings at the same
 * resolution and frame rate, so no re-encode is needed. Re-encoding a
 * concatenation nobody asked for would be strictly worse: slower, and a
 * second lossy pass over already-encoded frames.
 *
 * Ported verbatim from `apps/worker/src/ffmpeg.ts` — no changes needed, since
 * every input this worker produces already shares one resolution/fps/codec by
 * construction (see `cutSegment`/`renderTitleCard`).
 *
 * The demuxer reads its list from a file rather than argv, so one is written
 * next to the inputs and removed again whatever the outcome.
 */
export function concatVideos(inputPaths: string[], outputPath: string, scratchDir: string): FfmpegRun {
  const listPath = join(scratchDir, "concat.txt");
  // Each `file` line is a single-quoted string to the demuxer; escape any
  // literal quote per its documented convention (close, escaped quote, reopen).
  const listContents = inputPaths.map((path) => `file '${path.replace(/'/g, "'\\''")}'\n`).join("");

  let kill = () => {};
  const done = (async () => {
    await writeFile(listPath, listContents);
    try {
      const run = runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath]);
      kill = run.kill;
      await run.done;
    } finally {
      await rm(listPath, { force: true });
    }
  })();

  return { done, kill: () => kill() };
}

// ---------------------------------------------------------------------------
// Title cards
// ---------------------------------------------------------------------------

/**
 * Escapes a string for safe interpolation into a `drawtext` filter *option
 * value*, embedded inside a larger `-vf`/`-filter_complex` filter description
 * — used below only for the operator-configured `fontfile` path, never for a
 * step's title text (see `renderTitleCard`'s header for why title text takes
 * a different, simpler route entirely).
 *
 * This is a correctness concern only, not a shell-injection one: these
 * arguments go through `spawn`'s argv array, never a shell string.
 *
 * ffmpeg's own filtergraph escaping is genuinely two levels — a value's own
 * specials (`\`, `'`, and `:`, the key=value separator) escaped once, then
 * the *result* escaped again because it sits inside a larger filter
 * description with its own specials (`\`/`'` again, plus the delimiters `,`
 * `;` `[` `]`). This two-level scheme is provably lossy for a literal
 * backslash — `C:\Users\x` round-trips through it with both backslashes
 * silently dropped, confirmed against a real ffmpeg build — which is exactly
 * why arbitrary user text (a step title can plausibly contain a Windows path)
 * is never routed through this function.
 */
export function escapeDrawtext(text: string): string {
  const level1 = text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:");
  return level1
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/[,;[\]]/g, "\\$&");
}

/**
 * Renders `durationSeconds` of a solid-color card reading `text`, with the
 * template's logo composited in a bottom-right corner if `logoPath` is given.
 * Encoded at the render's target dimensions/frame rate with the same codec
 * settings `cutSegment` uses, so `concatVideos`'s stream-copy works across the
 * whole sequence.
 *
 * The video comes from ffmpeg's `color` lavfi source; a silent `anullsrc`
 * audio track rides alongside it so every concat input has a matching audio
 * stream — `concatVideos`'s `-c copy` would otherwise choke on a stream-count
 * mismatch between a title card and a real cut segment. `-shortest` caps the
 * (otherwise unbounded) `anullsrc` stream to the `color` source's own fixed
 * duration rather than giving both an explicit, and therefore
 * doubly-authoritative, duration.
 *
 * Deliberately not over-designed: one centered `drawtext` line and, if a logo
 * exists, one small `overlay` in a corner — a title card, not a design
 * system.
 *
 * `text` — a step's title, arbitrary user content — is written to its own
 * file next to `outputPath` and read back via `drawtext`'s `textfile` option
 * rather than interpolated into the filter description at all. This sidesteps
 * ffmpeg's two-level filtergraph escaping entirely for the one value here that
 * is not worker-controlled: a file's contents are read verbatim, with none of
 * `escapeDrawtext`'s lossy backslash-doubling to get wrong (see that
 * function's header). `expansion=none` additionally stops `drawtext` from
 * interpreting a literal `%{...}` in the title as one of its own expansion
 * sequences. Only the *path* to that file — worker-generated, alongside
 * `outputPath`, never containing a filtergraph special character — still goes
 * through the filter description, unescaped, because there is nothing in it
 * that needs escaping.
 */
export function renderTitleCard(
  text: string,
  brandHex: string,
  logoPath: string | undefined,
  targetWidth: number,
  targetHeight: number,
  targetFps: number,
  durationSeconds: number,
  outputPath: string,
): FfmpegRun {
  const duration = Math.max(0.1, durationSeconds);
  const textPath = `${outputPath}.title.txt`;
  writeFileSync(textPath, text, "utf8");
  const drawtext =
    `drawtext=textfile=${textPath}:expansion=none:fontcolor=white:fontsize=${Math.round(targetHeight / 15)}` +
    `:x=(w-text_w)/2:y=(h-text_h)/2` +
    (env.titleCardFontPath() ? `:fontfile=${escapeDrawtext(env.titleCardFontPath())}` : "");

  const inputs = [
    "-f", "lavfi", "-i", `color=c=${brandHex}:s=${targetWidth}x${targetHeight}:d=${duration}:r=${targetFps}`,
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    ...(logoPath ? ["-i", logoPath] : []),
  ];

  // Logo scaled to ~15% of the frame height, tucked in the bottom-right
  // corner with a small margin — small and out of the way of the centered
  // text, not a placement worth over-engineering.
  const logoHeight = Math.round(targetHeight * 0.15);
  const filterComplex = logoPath
    ? `[2:v]scale=-2:${logoHeight}[logo];[0:v][logo]overlay=W-w-20:H-h-20[bg];[bg]${drawtext}[vout]`
    : `[0:v]${drawtext}[vout]`;

  const run = runFfmpeg([
    "-y",
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[vout]",
    "-map",
    "1:a",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-r",
    String(targetFps),
    outputPath,
  ]);

  return run;
}
