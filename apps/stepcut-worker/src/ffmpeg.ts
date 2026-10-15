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
import {
  atempoChain,
  outputDuration,
  pieceVideoChain,
  roundedMaskExpr,
  speedPieces,
  zoomExpressions,
  type FrameStyle,
  type Layout,
  type SpeedRegion,
  type ZoomRegion,
} from "./effects.js";

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
 * The audio's peak level in dBFS, via ffmpeg's `volumedetect` filter.
 *
 * Guards the one failure mode a transcript cannot recover from on its own:
 * Whisper does not return "nothing" for silent audio, it fills the silence
 * with a short stock phrase ("you", "Thank you for watching.") once per
 * internal window, and reports it as an ordinary transcript. A screen
 * recording captured with the wrong input device — or with the microphone
 * muted — produces exactly that, and every stage downstream then treats the
 * hallucination as narration.
 *
 * **Peak, not mean.** A real recording of someone working through a task is
 * mostly pauses; its *mean* level sits low enough that a mean-based threshold
 * would reject narrated recordings. The peak only falls this low when nothing
 * was ever captured.
 *
 * Returns `-Infinity` for a track of pure digital zeroes, which ffmpeg prints
 * as `-inf`. A source with no audio stream at all makes `volumedetect` print
 * nothing, which is the same answer as far as transcription is concerned.
 */
export function peakLevelDb(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      env.ffmpegPath(),
      ["-hide_banner", "-i", audioPath, "-af", "volumedetect", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => reject(new FfmpegError(`could not spawn ffmpeg: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new FfmpegError(`ffmpeg exited with code ${code}: ${stderr.trim().slice(-MAX_STDERR_TAIL)}`));
        return;
      }
      const match = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
      if (!match) {
        resolve(Number.NEGATIVE_INFINITY);
        return;
      }
      resolve(match[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1]));
    });
  });
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
  effects?: CutEffects,
): Promise<FfmpegRun> {
  const duration = Math.max(0, end - start);
  const hasAudio = await probeHasAudio(videoPath);
  if (effects && needsEffectsPass(effects, start, duration)) {
    return cutSegmentWithEffects(videoPath, start, duration, outputPath, targetFps, hasAudio, effects, onProgress);
  }

  const scaleFilter =
    `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,` +
    `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,fps=${targetFps}`;

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
      // 48 kHz stereo, matching title cards and effect cuts: `concatVideos`
      // stream-copies, and a part whose audio format differs from the first
      // part's gets decoded with the wrong parameters (audio drifts out of
      // sync with video).
      "-ar",
      "48000",
      "-ac",
      "2",
      "-progress",
      "pipe:1",
      "-nostats",
      outputPath,
    ],
    progressParser(duration, onProgress),
  );

  return {
    kill: run.kill,
    done: run.done.then(() => onProgress(1)),
  };
}

/** Parses `-progress pipe:1` lines into a [0, 1] fraction of `duration`.
 * `out_time_ms=` is microseconds despite the name. Only forward movement of at
 * least 0.5% is reported (see `cutSegment`'s header). */
function progressParser(duration: number, onProgress: (fraction: number) => void): (line: string) => void {
  let lastReported = -1;
  return (line) => {
    const value = line.trim().startsWith("out_time_ms=") ? line.trim().slice(12) : undefined;
    if (value === undefined || duration <= 0) return;
    const micros = Number.parseFloat(value);
    if (!Number.isFinite(micros)) return;
    const fraction = Math.min(1, Math.max(0, micros / 1_000_000 / duration));
    if (fraction > lastReported + 0.005) {
      lastReported = fraction;
      onProgress(fraction);
    }
  };
}

// ---------------------------------------------------------------------------
// Effects: zoom regions, speed regions, styled frame
// ---------------------------------------------------------------------------

/** Everything `cutSegment` needs to apply a render's effects to one cut. */
export interface CutEffects {
  zooms: readonly ZoomRegion[];
  speeds: readonly SpeedRegion[];
  layout: Layout;
  /** Present only for a styled frame (`effects.ts`'s `isStyled`). */
  frame?: PreparedFrame;
}

/** The stills `prepareFrameAssets` renders once per render. */
export interface PreparedFrame {
  /** Background (plus shadow) at the full target size. */
  backgroundPath: string;
  /** The same background with no shadow — what title cards sit on, since a
   * shadow with no recording above it reads as a smudge. */
  plainBackgroundPath: string;
  /** Rounded-corner alpha mask at the layout's box size, when radius > 0. */
  maskPath?: string;
}

/** Whether `effects` changes anything about a cut of `[start, start+duration)`
 * — if not, `cutSegment` keeps its original single-filter invocation. */
function needsEffectsPass(effects: CutEffects, start: number, duration: number): boolean {
  if (effects.frame) return true;
  const end = start + duration;
  if (effects.zooms.some((z) => z.end > start && z.start < end)) return true;
  return speedPieces(start, duration, effects.speeds).some((piece) => piece.rate !== 1);
}

/**
 * `cutSegment` with effects: one input per speed piece (each its own
 * `-ss`/`-t` seek, so the concat below pulls them strictly in order and
 * never buffers a later piece's frames in memory — a `split`/`trim` fan-out
 * over one input would), zoomed per `effects.ts`'s `pieceVideoChain`,
 * retimed, joined, then either composited onto the styled frame or padded to
 * the target exactly as the plain path does.
 *
 * Audio is normalized to 48 kHz stereo — the same format `renderTitleCard`'s
 * silent track uses — so every file `concatVideos` stream-copies agrees.
 */
function cutSegmentWithEffects(
  videoPath: string,
  start: number,
  duration: number,
  outputPath: string,
  targetFps: number,
  hasAudio: boolean,
  effects: CutEffects,
  onProgress: (fraction: number) => void,
): FfmpegRun {
  const { layout } = effects;
  const pieces = speedPieces(start, duration, effects.speeds);
  const inputs: string[] = [];
  const graph: string[] = [];

  for (const [index, piece] of pieces.entries()) {
    inputs.push("-ss", String(start + piece.start), "-t", String(piece.end - piece.start), "-i", videoPath);
    const zoom = zoomExpressions(effects.zooms, start, piece);
    graph.push(`[${index}:v:0]${pieceVideoChain(layout, zoom, piece, targetFps)}[v${index}]`);
    const audioFormat = "aformat=sample_rates=48000:channel_layouts=stereo";
    graph.push(
      hasAudio
        ? `[${index}:a:0]asetpts=PTS-STARTPTS,${atempoChain(piece.rate)},${audioFormat}[a${index}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${(piece.end - piece.start) / piece.rate},${audioFormat}[a${index}]`,
    );
  }

  const joined = pieces.map((_, index) => `[v${index}][a${index}]`).join("");
  graph.push(`${joined}concat=n=${pieces.length}:v=1:a=1[vc][aout]`);

  if (effects.frame) {
    const bgIndex = pieces.length;
    inputs.push("-loop", "1", "-framerate", String(targetFps), "-i", effects.frame.backgroundPath);
    let content = "[vc]";
    if (effects.frame.maskPath) {
      const maskIndex = pieces.length + 1;
      inputs.push("-loop", "1", "-framerate", String(targetFps), "-i", effects.frame.maskPath);
      graph.push(`[vc]format=yuva420p[vca]`);
      graph.push(`[${maskIndex}:v]format=gray,scale=${layout.boxWidth}:${layout.boxHeight}[mask]`);
      graph.push(`[vca][mask]alphamerge=shortest=1[vr]`);
      content = "[vr]";
    }
    graph.push(
      `[${bgIndex}:v]format=yuv420p[bg]`,
      `[bg]${content}overlay=x=${layout.boxX}:y=${layout.boxY}:shortest=1,fps=${targetFps},format=yuv420p[vout]`,
    );
  } else {
    graph.push(
      `[vc]pad=${layout.width}:${layout.height}:${layout.boxX}:${layout.boxY}:black,fps=${targetFps},format=yuv420p[vout]`,
    );
  }

  // The graph goes in a file, not argv: each zoom region adds ~1 KB of
  // expressions, and Linux caps a single argument at 128 KiB, so a long step
  // with many regions would otherwise fail to spawn (E2BIG). `-/filter_complex`
  // reads an option's value from a file (ffmpeg 7.0+).
  const graphPath = `${outputPath}.filtergraph.txt`;
  writeFileSync(graphPath, graph.join(";\n"), "utf8");

  const total = outputDuration(pieces);
  const run = runFfmpeg(
    [
      "-y",
      ...inputs,
      "-/filter_complex",
      graphPath,
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-r",
      String(targetFps),
      "-progress",
      "pipe:1",
      "-nostats",
      outputPath,
    ],
    progressParser(total, onProgress),
  );

  return {
    kill: run.kill,
    done: run.done.then(() => onProgress(1)),
  };
}

/**
 * A video's *displayed* dimensions, via ffprobe — what `layoutFor` fits into
 * the template's frame. Not the raw coded size: ffmpeg auto-rotates decoded
 * frames per the stream's rotation side data and `pieceVideoChain` squares
 * the pixels, so a phone recording tagged 90° or an anamorphic source has to
 * be measured the way it will actually arrive, or the box gets the wrong
 * aspect ratio and the recording is stretched into it.
 */
export function probeVideoSize(videoPath: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      env.ffprobePath(),
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,sample_aspect_ratio:stream_side_data=rotation",
        "-of", "json",
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
      let stream:
        | { width?: number; height?: number; sample_aspect_ratio?: string; side_data_list?: Array<{ rotation?: number }> }
        | undefined;
      try {
        stream = (JSON.parse(stdout) as { streams?: Array<typeof stream> }).streams?.[0];
      } catch {
        stream = undefined;
      }
      const codedWidth = stream?.width ?? 0;
      const codedHeight = stream?.height ?? 0;
      if (!(codedWidth > 0) || !(codedHeight > 0)) {
        reject(new Error(`could not parse ffprobe size output ${JSON.stringify(stdout)}`));
        return;
      }
      const [sarNum, sarDen] = (stream?.sample_aspect_ratio ?? "1:1").split(":").map(Number);
      const sar = sarNum > 0 && sarDen > 0 ? sarNum / sarDen : 1;
      const width = Math.round(codedWidth * sar);
      const rotation = Math.abs(stream?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) % 180;
      resolve(rotation === 90 ? { width: codedHeight, height: width } : { width, height: codedHeight });
    });
  });
}

/** `#rrggbb` → ffmpeg's `0xrrggbb`, which (unlike `#`) no filtergraph level
 * treats specially. */
function ffColor(hex: string): string {
  return `0x${hex.replace(/^#/, "")}`;
}

/**
 * Renders a styled frame's two stills into `dir`: the rounded-corner mask (if
 * any) and the full-size background with the drop shadow already baked in.
 * Both are static for the whole render, so doing them once here keeps the
 * per-frame work in `cutSegmentWithEffects` down to one `alphamerge` and one
 * `overlay`.
 */
export async function prepareFrameAssets(style: FrameStyle, layout: Layout, dir: string): Promise<PreparedFrame> {
  const { width, height, boxWidth, boxHeight, boxX, boxY } = layout;

  const needsMask = style.radiusPx > 0 || style.shadow > 0;
  const maskPath = join(dir, "frame-mask.png");
  if (needsMask) {
    const radius = Math.min(style.radiusPx, Math.floor(Math.min(boxWidth, boxHeight) / 2));
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", `color=c=white:s=${boxWidth}x${boxHeight}:d=1`,
      // Radius 0 is a plain opaque rectangle — the anti-aliased corner
      // expression would put every pixel at half coverage.
      "-vf", radius > 0 ? `format=gray,geq=lum='${roundedMaskExpr(radius)}'` : "format=gray",
      "-frames:v", "1",
      maskPath,
    ]).done;
  }

  const inputs: string[] = [];
  let background: string;
  if (style.backgroundKind === "image" && style.backgroundImagePath) {
    inputs.push("-i", style.backgroundImagePath);
    background = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=rgba[bg0]`;
  } else if (style.backgroundKind === "gradient") {
    const c1 = style.backgroundColor2 ?? style.backgroundColor;
    inputs.push(
      "-f", "lavfi", "-i",
      `gradients=s=${width}x${height}:c0=${ffColor(style.backgroundColor)}:c1=${ffColor(c1)}` +
        `:x0=0:y0=0:x1=${width}:y1=${height}:nb_colors=2:speed=0:d=1`,
    );
    background = `[0:v]format=rgba[bg0]`;
  } else {
    const color = style.backgroundKind === "color" ? ffColor(style.backgroundColor) : "black";
    inputs.push("-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height}:d=1`);
    background = `[0:v]format=rgba[bg0]`;
  }

  const graph = [background, `[bg0]split[plain][bgBase]`];
  let last = "[bgBase]";
  if (style.shadow > 0) {
    inputs.push("-i", maskPath);
    const blur = Math.max(6, Math.round(boxHeight * 0.025));
    const offsetY = Math.round(boxHeight * 0.015);
    graph.push(
      `[1:v]format=gray,pad=${width}:${height}:${boxX}:${boxY + offsetY}:black,gblur=sigma=${blur}[shadowAlpha]`,
      `color=c=black:s=${width}x${height}:d=1,format=rgba[shadowBase]`,
      `[shadowBase][shadowAlpha]alphamerge,colorchannelmixer=aa=${Math.min(1, Math.max(0, style.shadow)).toFixed(3)}[shadow]`,
      `${last}[shadow]overlay=0:0:format=auto[bg1]`,
    );
    last = "[bg1]";
  }

  const backgroundPath = join(dir, "frame-background.png");
  const plainBackgroundPath = join(dir, "frame-background-plain.png");
  await runFfmpeg([
    "-y",
    ...inputs,
    "-filter_complex", `${graph.join(";")};${last}format=rgb24[out];[plain]format=rgb24[plainOut]`,
    "-map", "[out]", "-frames:v", "1", backgroundPath,
    "-map", "[plainOut]", "-frames:v", "1", plainBackgroundPath,
  ]).done;

  return { backgroundPath, plainBackgroundPath, maskPath: style.radiusPx > 0 ? maskPath : undefined };
}

// ---------------------------------------------------------------------------
// Zoom suggestions
// ---------------------------------------------------------------------------

/**
 * Decodes `videoPath` to small grayscale frames at `fps`, yielding each as a
 * `width × height` byte array — the input `zoom-suggest.ts` scans for
 * localized on-screen change. Streams straight off ffmpeg's stdout, so a long
 * recording is never held in memory as a whole.
 */
export async function* decodeGrayFrames(
  videoPath: string,
  width: number,
  height: number,
  fps: number,
): AsyncGenerator<Uint8Array> {
  const frameSize = width * height;
  const child = spawn(
    env.ffmpegPath(),
    [
      "-v", "error",
      "-i", videoPath,
      "-an",
      "-vf", `fps=${fps},scale=${width}:${height}:flags=area,format=gray`,
      "-f", "rawvideo",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-MAX_STDERR_TAIL);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", (err) => reject(new FfmpegError(`could not spawn ffmpeg: ${err.message}`)));
    child.on("close", (code) => resolve(code));
  });

  let pending: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= frameSize) {
        yield new Uint8Array(pending.subarray(0, frameSize));
        pending = pending.subarray(frameSize);
      }
    }
  } finally {
    // A consumer that stops early (or throws) must not leave ffmpeg running.
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  const code = await exited;
  if (code !== 0 && code !== null) {
    throw new FfmpegError(`ffmpeg exited with code ${code}: ${stderrTail.trim()}`);
  }
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
  backgroundPath?: string,
): FfmpegRun {
  const duration = Math.max(0.1, durationSeconds);
  const textPath = `${outputPath}.title.txt`;
  writeFileSync(textPath, text, "utf8");
  const drawtext =
    `drawtext=textfile=${textPath}:expansion=none:fontcolor=white:fontsize=${Math.round(targetHeight / 15)}` +
    `:x=(w-text_w)/2:y=(h-text_h)/2` +
    (env.titleCardFontPath() ? `:fontfile=${escapeDrawtext(env.titleCardFontPath())}` : "");

  const inputs = [
    // A styled template's frame background (`prepareFrameAssets`), when the
    // caller passes one, in place of the flat brand color — so the cards
    // match the steps they introduce.
    ...(backgroundPath
      ? ["-loop", "1", "-framerate", String(targetFps), "-t", String(duration), "-i", backgroundPath]
      : ["-f", "lavfi", "-i", `color=c=${brandHex}:s=${targetWidth}x${targetHeight}:d=${duration}:r=${targetFps}`]),
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
