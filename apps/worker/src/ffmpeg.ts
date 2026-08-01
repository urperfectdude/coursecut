// ffmpeg and ffprobe — `src-tauri/src/ffmpeg.rs` ported, invocations
// unchanged.
//
// Desktop shells out to bundled sidecars through `tauri-plugin-shell`; here it
// is `child_process.spawn` on the system binary (pinned in the worker image
// for production, `FFMPEG_PATH`/`FFPROBE_PATH` to override). Everything else —
// the argument lists, the seek strategy, the progress parsing, the bounded
// stderr tail — is the desktop behaviour, because an export produced by the
// web app and the same export produced by the desktop app have to be the same
// file.
//
// This module only ever reads a local file the worker downloaded to scratch
// and writes new local files. It makes no network call and touches no
// database; the source object in storage is never modified.

import { spawn, type ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../../api/src/env.js";

/** ffmpeg logs its banner and warnings to stderr even when it succeeds. Keep a
 * bounded tail so a real failure's message is useful without holding a whole
 * long encode's log in memory. */
const MAX_STDERR_TAIL = 4000;

/**
 * A running ffmpeg process, with the handle a caller needs to stop it.
 *
 * Desktop registers the child with `ExportRunning` so `cancel_export` — running
 * in the same process — can kill it. Here the cancel arrives in a *different*
 * process (the API marks the row), so the worker polls the row and calls
 * `kill()` itself. Same outcome, one indirection more.
 */
export interface FfmpegRun {
  done: Promise<void>;
  kill: () => void;
}

class FfmpegError extends Error {}

function runFfmpeg(
  args: string[],
  onStdoutLine?: (line: string) => void,
): FfmpegRun {
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

/**
 * Extracts mono 16 kHz audio, Opus-encoded in an Ogg container — a format
 * Whisper accepts (PRD §7.3/§9). Reads the source video and writes only the
 * new audio file; the source is never modified.
 *
 * Desktop's invocation, verbatim, and its reasoning holds here unchanged:
 * Whisper caps an upload at 25 MB for every model, and the raw PCM WAV this
 * used to emit runs at 32 KB/s, so the cap landed at ~13 minutes and a real
 * lecture became a dozen sequential requests. Opus at 24 kbps is ~3 KB/s —
 * over two hours in one request — and Whisper resamples to 16 kHz mono
 * internally anyway, so what compression drops is what the model discards.
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
 * Trims `[start, end)` into a frame-accurate re-encoded MP4 (PRD §10).
 * Desktop's invocation, verbatim, and its reasoning holds here unchanged:
 *
 * `-ss <start>` **before** `-i` for fast input seeking, then `-t <end-start>`
 * (a duration, not `-to`) **after** `-i` for the output length — the
 * unambiguous way to say "encode exactly this many seconds from the seek
 * point", with no dependence on how a given ffmpeg build reads `-to` after an
 * input seek.
 *
 * `libx264`/`aac` rather than `-c copy`: stream-copy can only cut on keyframe
 * boundaries, which would silently ignore the user's exact trim points. The
 * app promises frame-accurate trimming, so the file has to reflect it.
 *
 * Progress comes from ffmpeg's own `-progress pipe:1` (`out_time_ms=` is
 * microseconds despite the name) divided by the known duration, reported as a
 * fraction in [0, 1]. Only forward movement of at least 0.5% is reported, so a
 * fast encode does not spam the caller — and, transitively, Postgres — with
 * dozens of near-identical writes a second.
 *
 * The returned handle is what cancellation uses: a killed process surfaces as
 * a rejected `done`, which the caller tells apart from a genuine failure by
 * checking whether the export row was already `cancelled`.
 */
export function cutSegment(
  videoPath: string,
  start: number,
  end: number,
  outputPath: string,
  onProgress: (fraction: number) => void,
): FfmpegRun {
  const duration = Math.max(0, end - start);
  let lastReported = -1;

  const run = runFfmpeg(
    [
      "-y",
      "-ss",
      String(start),
      "-i",
      videoPath,
      "-t",
      String(duration),
      "-c:v",
      "libx264",
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
 * here specifically because every input was just produced by `cutSegment` with
 * the same libx264/aac settings, so no re-encode is needed. Re-encoding a
 * concatenation nobody asked for would be strictly worse: slower, and a second
 * lossy pass over already-encoded frames.
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
