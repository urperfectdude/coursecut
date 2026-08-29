// WAV parsing, rebuilding and splitting for chunked Whisper uploads —
// `src-tauri/src/wav.rs` ported, algorithm and constants unchanged.
//
// Pure and dependency-free: it only ever operates on already-extracted audio
// bytes already in memory (mono, 16 kHz, 16-bit PCM, as the worker's
// `extractAudio` produces). No filesystem, no network, no database. Its one
// caller is `openai.ts`'s `transcribeAudio`, and only for splitting audio that
// is already on its way to Whisper.
//
// It lives beside its caller rather than in `apps/worker` for that reason —
// nothing here needs a subprocess or a scratch disk, which is the line this
// package's split with the worker follows.

/** The `fmt ` fields anything below needs. Mono is assumed throughout
 * (matching `-ac 1`); `parse` rejects anything else rather than silently
 * mis-splitting a multi-channel file. */
export interface WavFormat {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

export interface ParsedWav {
  format: WavFormat;
  samples: Int16Array;
}

/** One sub-cap chunk, with where its first sample sits in the full recording. */
// `Uint8Array<ArrayBuffer>` rather than a plain `Uint8Array`, whose default
// type parameter also admits a `SharedArrayBuffer`-backed view: `Blob` (which
// is where these bytes go) will not take one, and nothing here ever makes one.
export interface WavChunk {
  bytes: Uint8Array<ArrayBuffer>;
  startOffsetSecs: number;
}

/**
 * Walks a WAV buffer's RIFF chunks — not assuming a fixed 44-byte header, so
 * an encoder's `LIST`/`INFO` chunk before or after `fmt `/`data` is tolerated —
 * and decodes the sample data.
 */
export function parse(bytes: Uint8Array): ParsedWav {
  if (bytes.byteLength < 12) throw new Error("WAV data is too short to contain a RIFF header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(bytes, 0) !== "RIFF") throw new Error("not a RIFF file (missing 'RIFF' tag)");
  if (tag(bytes, 8) !== "WAVE") throw new Error("not a WAVE file (missing 'WAVE' tag)");

  let format: WavFormat | undefined;
  let dataRange: { start: number; length: number } | undefined;

  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const chunkId = tag(bytes, pos);
    const chunkSize = view.getUint32(pos + 4, true);
    const bodyStart = pos + 8;
    const bodyEnd = bodyStart + chunkSize;
    if (bodyEnd > bytes.byteLength) throw new Error("WAV chunk size exceeds the file's length");

    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw new Error("'fmt ' chunk is smaller than the minimum 16 bytes");
      format = {
        channels: view.getUint16(bodyStart + 2, true),
        sampleRate: view.getUint32(bodyStart + 4, true),
        bitsPerSample: view.getUint16(bodyStart + 14, true),
      };
    } else if (chunkId === "data") {
      dataRange = { start: bodyStart, length: chunkSize };
    }

    // RIFF chunks are word-aligned: an odd-sized body is followed by one pad
    // byte that is not part of the declared size.
    pos = bodyEnd + (chunkSize % 2);
  }

  if (!format) throw new Error("WAV file has no 'fmt ' chunk");
  if (format.channels !== 1) {
    throw new Error(
      `only mono WAV is supported (extractAudio always produces mono), got ${format.channels} channels`,
    );
  }
  if (format.bitsPerSample !== 16) {
    throw new Error(
      `only 16-bit PCM WAV is supported (extractAudio always produces 16-bit), got ${format.bitsPerSample}-bit`,
    );
  }
  if (!dataRange) throw new Error("WAV file has no 'data' chunk");

  const sampleCount = Math.floor(dataRange.length / 2);
  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    // Read through the DataView rather than aliasing an Int16Array onto the
    // buffer: `data` may start at an odd byte offset, which a typed-array view
    // cannot address.
    samples[index] = view.getInt16(dataRange.start + index * 2, true);
  }

  return { format, samples };
}

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

/** Rebuilds a minimal, valid WAV (RIFF/`fmt `/`data`, correct sizes) from a
 * sample range — how each chunk is emitted. */
export function buildWav(format: WavFormat, samples: Int16Array): Uint8Array<ArrayBuffer> {
  const bytesPerSample = format.bitsPerSample / 8;
  const blockAlign = format.channels * bytesPerSample;
  const byteRate = format.sampleRate * blockAlign;
  const dataLength = samples.length * 2;

  const out = new Uint8Array(44 + dataLength);
  const view = new DataView(out.buffer);
  writeTag(out, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeTag(out, 8, "WAVE");

  writeTag(out, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // format tag: PCM
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, format.bitsPerSample, true);

  writeTag(out, 36, "data");
  view.setUint32(40, dataLength, true);
  for (const [index, sample] of samples.entries()) {
    view.setInt16(44 + index * 2, sample, true);
  }
  return out;
}

function writeTag(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

// ---------------------------------------------------------------------------
// Silence-seeking chunk-boundary selection
// ---------------------------------------------------------------------------

/** Frame length for energy scanning: ~20 ms. */
const FRAME_MS = 20;
/** How far either side of a target boundary to look for a natural pause. */
const SEARCH_WINDOW_SECS = 25;
/** A frame counts as a pause only if its mean amplitude is at most this
 * fraction of the search window's own baseline. */
const BASELINE_DIP_RATIO = 0.35;

/**
 * Picks a cut point near `target` (a sample index), preferring a real pause in
 * speech within the window, falling back to `target` itself when no frame dips
 * meaningfully below the window's own baseline amplitude.
 *
 * Frame and window sizes are parameters rather than derived inline so the
 * algorithm can be tested against small synthetic buffers; `findBoundary`
 * supplies the production values.
 */
export function pickBoundary(
  samples: Int16Array,
  chunkStart: number,
  target: number,
  total: number,
  frameLen: number,
  windowSamples: number,
): number {
  const windowStart = Math.max(target - windowSamples, chunkStart, 0);
  const windowEnd = Math.min(target + windowSamples, total);
  if (windowEnd < windowStart + frameLen) return target;

  const frames: Array<[number, number]> = [];
  for (let pos = windowStart; pos + frameLen <= windowEnd; pos += frameLen) {
    let sum = 0;
    for (let index = pos; index < pos + frameLen; index += 1) sum += Math.abs(samples[index]!);
    frames.push([pos, sum / frameLen]);
  }
  if (frames.length === 0) return target;

  // The baseline is this window's own average frame amplitude — judged
  // per-window rather than against a fixed constant, so an elevated noise
  // floor (HVAC hum) does not hide a real relative dip.
  const baseline = frames.reduce((sum, [, amplitude]) => sum + amplitude, 0) / frames.length;

  let bestPos = target;
  let bestAmplitude = Number.POSITIVE_INFINITY;
  for (const [pos, amplitude] of frames) {
    if (amplitude < bestAmplitude) {
      bestPos = pos;
      bestAmplitude = amplitude;
    }
  }

  // No meaningful pause (continuous speech, or a uniformly loud recording) —
  // hard-cut at the target rather than searching further.
  return baseline > 0 && bestAmplitude <= baseline * BASELINE_DIP_RATIO ? bestPos : target;
}

/** `pickBoundary` with the production frame/window sizes for `sampleRate`. */
function findBoundary(
  samples: Int16Array,
  chunkStart: number,
  target: number,
  total: number,
  sampleRate: number,
): number {
  const rate = Math.max(1, sampleRate);
  const frameLen = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
  const windowSamples = Math.max(frameLen, Math.round(rate * SEARCH_WINDOW_SECS));
  return pickBoundary(samples, chunkStart, target, total, frameLen, windowSamples);
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/**
 * Splits a whole WAV into sub-`maxChunkBytes` WAVs, each paired with the start
 * offset in seconds its samples begin at. Boundaries come from `findBoundary`
 * (silence-seeking, hard-cut fallback) except the last, which runs to the end.
 *
 * Audio already at or under the cap comes back as a single chunk at offset 0.
 * `transcribeAudio` special-cases that before calling, so it is not the live
 * path — but it keeps this function correct standalone.
 */
export function splitIntoChunks(bytes: Uint8Array, maxChunkBytes: number): WavChunk[] {
  const { format, samples } = parse(bytes);

  const bytesPerSample = format.bitsPerSample / 8;
  if (bytesPerSample === 0) throw new Error("invalid WAV format: 0 bits per sample");
  // Mono, so one sample is one frame — no channel multiplier.
  const chunkSamples = Math.max(1, Math.floor(maxChunkBytes / bytesPerSample));

  const total = samples.length;
  const chunks: WavChunk[] = [];
  let start = 0;

  while (start < total) {
    const remaining = total - start;
    let end: number;
    if (remaining <= chunkSamples) {
      end = total;
    } else {
      end = findBoundary(samples, start, start + chunkSamples, total, format.sampleRate);
    }
    // Guard against a degenerate zero-length chunk so the loop cannot spin.
    end = Math.min(total, Math.max(end, start + 1));

    chunks.push({
      bytes: buildWav(format, samples.subarray(start, end)),
      startOffsetSecs: start / Math.max(1, format.sampleRate),
    });
    start = end;
  }

  return chunks;
}
