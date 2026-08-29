// ffmpeg and ffprobe — the `probeDuration`/`extractAudio` half of
// apps/worker/src/ffmpeg.ts (`src-tauri/src/ffmpeg.rs`, by way of that port).
// `cutSegment`/`concatVideos` are export/render-only and belong to Phase 5,
// not here.
//
// `child_process.spawn` on the system binary (pinned in the worker image for
// production, `FFMPEG_PATH`/`FFPROBE_PATH` to override). This module only
// ever reads a local file the worker downloaded to scratch and writes a new
// local file. It makes no network call and touches no database; the source
// object in storage is never modified.

import { spawn, type ChildProcess } from "node:child_process";
import { env } from "../../stepcut-api/src/env.js";

/** ffmpeg logs its banner and warnings to stderr even when it succeeds. Keep
 * a bounded tail so a real failure's message is useful without holding a
 * whole long encode's log in memory. */
const MAX_STDERR_TAIL = 4000;

class FfmpegError extends Error {}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(env.ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderrTail = "";
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
      reject(new FfmpegError(`ffmpeg exited with code ${code} (signal ${signal}): ${stderrTail.trim()}`));
    });
  });
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
  ]);
}
