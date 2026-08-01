// The parsing and trimming rules, ported from the Rust unit tests in
// `src-tauri/src/openai.rs` and `src-tauri/src/wav.rs`.
//
// These are the parts of the model integration with no network in them, and
// they carry the behaviour that is easiest to lose in a port: which malformed
// suggestion is dropped rather than fatal, which timestamp format means
// centiseconds, where a chunk boundary lands. Every case below has a
// counterpart in the desktop tests, so the two can be diffed as the ports they
// are — the same reason `domain/lessons.ts` was ported case for case.
//
// No key and no HTTP: nothing here calls OpenAI.

import { describe, expect, it } from "vitest";
import {
  extractTimestampsSeconds,
  mergeChunkSegments,
  parseEditSegments,
  parseLessonSuggestions,
  silenceGaps,
  trimSegmentAgainstGaps,
  trimSilenceFromSuggestions,
  type LessonSuggestion,
} from "../src/openai.js";
import { buildWav, parse, pickBoundary, splitIntoChunks } from "../src/wav.js";

// The transcript span every analysis case below is validated against.
const START = 0;
const END = 100;

const json = (value: unknown) => JSON.stringify(value);

describe("parseLessonSuggestions", () => {
  it("keeps valid suggestions and clamps confidence", () => {
    const suggestions = parseLessonSuggestions(
      json({
        lessons: [
          { segments: [{ start: 0, end: 10 }], title: "Intro", summary: "Welcome", kind: "lesson", confidence: 0.9 },
          { segments: [{ start: 10, end: 20 }], title: "Q&A", summary: "", kind: "qna", confidence: 5 },
          { segments: [{ start: 20, end: 30 }], title: "Silence", summary: "", kind: "silence", confidence: -1 },
          // Numeric strings are accepted rather than discarding an otherwise
          // usable suggestion over a formatting slip.
          { segments: [{ start: "30.0", end: "40.0" }], title: "Strings", summary: "", kind: "break", confidence: 0.4 },
        ],
      }),
      START,
      END,
    );

    expect(suggestions).toHaveLength(4);
    expect(suggestions[1]!.confidence).toBe(1);
    expect(suggestions[2]!.confidence).toBe(0);
    expect(suggestions[3]!.segments).toEqual([[30, 40]]);
  });

  it("falls back to the lesson kind for an unrecognized or missing one", () => {
    const suggestions = parseLessonSuggestions(
      json({
        lessons: [
          { segments: [{ start: 0, end: 10 }], kind: "made_up_category" },
          { segments: [{ start: 10, end: 20 }] },
        ],
      }),
      START,
      END,
    );

    expect(suggestions.map((s) => s.kind)).toEqual(["lesson", "lesson"]);
    expect(suggestions[1]!.title).toBe("Untitled lesson");
  });

  it("drops malformed or out-of-range suggestions without failing the batch", () => {
    const suggestions = parseLessonSuggestions(
      json({
        lessons: [
          { segments: [{ start: 0, end: 10 }], title: "Valid" },
          { segments: [{ start: 20, end: 15 }], title: "Backwards" },
          { segments: [{ start: "not-a-number", end: 30 }], title: "Bad start" },
          { segments: [{ start: 500, end: 600 }], title: "Out of range" },
          { title: "No segments" },
        ],
      }),
      START,
      END,
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.title).toBe("Valid");
  });

  it("keeps a partially valid lesson's valid segments", () => {
    const suggestions = parseLessonSuggestions(
      json({
        lessons: [
          {
            segments: [
              { start: 0, end: 10 },
              { start: 20, end: 15 },
              { start: 500, end: 600 },
              { start: 50, end: 60 },
            ],
            title: "Partially valid",
          },
        ],
      }),
      START,
      END,
    );

    expect(suggestions[0]!.segments).toEqual([
      [0, 10],
      [50, 60],
    ]);
  });

  it("treats a missing lessons array as an error, but an empty one as no lessons", () => {
    expect(() => parseLessonSuggestions(json({ not_lessons: [] }), START, END)).toThrow();
    expect(() => parseLessonSuggestions("this is not json", START, END)).toThrow();
    expect(parseLessonSuggestions(json({ lessons: [] }), START, END)).toEqual([]);
  });
});

describe("parseEditSegments", () => {
  it("parses valid segments and drops the rest", () => {
    expect(
      parseEditSegments(
        json({ segments: [{ start: 10, end: 20 }, { start: 20, end: 15 }, { start: 500, end: 600 }] }),
        0,
        100,
      ),
    ).toEqual([[10, 20]]);
  });

  it("accepts an empty proposal but not a missing key", () => {
    // "delete this whole lesson" is a valid thing to propose; nothing is
    // written until the user accepts it.
    expect(parseEditSegments(json({ segments: [] }), 0, 100)).toEqual([]);
    expect(() => parseEditSegments(json({ not_segments: [] }), 0, 100)).toThrow();
    expect(() => parseEditSegments("not json", 0, 100)).toThrow();
  });
});

describe("extractTimestampsSeconds", () => {
  it("reads every shape a user might type", () => {
    expect(extractTimestampsSeconds("split at 12:30")).toEqual([750]);
    expect(extractTimestampsSeconds("cut everything after 1:02:03")).toEqual([3723]);
    expect(extractTimestampsSeconds("trim to 00:01:02:500")).toEqual([62.5]);
    // Two digits is centiseconds, three is milliseconds — so `50` and `500`
    // mean the same half-second, and `078` does not mean `78`.
    expect(extractTimestampsSeconds("trim to 00:01:02:50")).toEqual([62.5]);
    expect(extractTimestampsSeconds("cut from 2:15 to 3:40")).toEqual([135, 220]);
    expect(extractTimestampsSeconds("cut the part about pricing")).toEqual([]);
  });
});

describe("silence trimming", () => {
  const line = (start: number, end: number) => ({ start, end, text: "text" });
  const suggestion = (segments: Array<[number, number]>): LessonSuggestion => ({
    segments,
    title: "Lesson",
    summary: "",
    kind: "lesson",
    confidence: 0.5,
  });

  it("reports only gaps above the threshold", () => {
    expect(silenceGaps([line(0, 10), line(11, 20)], 2)).toEqual([]);
    expect(silenceGaps([line(0, 10), line(15, 20)], 2)).toEqual([[10, 15]]);
    expect(silenceGaps([line(0, 10), line(15, 20), line(21, 30), line(40, 50)], 2)).toEqual([
      [10, 15],
      [30, 40],
    ]);
    expect(silenceGaps([line(0, 10)], 2)).toEqual([]);
  });

  it("trims edges but never splits a segment", () => {
    expect(trimSegmentAgainstGaps([5, 20], [[3, 8]])).toEqual([8, 20]);
    expect(trimSegmentAgainstGaps([5, 20], [[15, 25]])).toEqual([5, 15]);
    expect(trimSegmentAgainstGaps([5, 20], [[100, 110]])).toEqual([5, 20]);
    // A gap wholly inside the segment is left alone.
    expect(trimSegmentAgainstGaps([0, 100], [[40, 50]])).toEqual([0, 100]);
    expect(trimSegmentAgainstGaps([10, 15], [[5, 20]])).toBeUndefined();
    // Two adjacent gaps together swallow a segment neither covers alone.
    expect(trimSegmentAgainstGaps([10, 20], [[5, 15], [15, 25]])).toBeUndefined();
  });

  it("is order-independent across gaps", () => {
    expect(trimSegmentAgainstGaps([0, 100], [[-5, 10], [90, 105]])).toEqual([10, 90]);
    expect(trimSegmentAgainstGaps([0, 100], [[90, 105], [-5, 10]])).toEqual([10, 90]);
  });

  it("drops a suggestion only when every segment is consumed", () => {
    expect(
      trimSilenceFromSuggestions([suggestion([[10, 15], [50, 60]])], [[5, 20]])[0]!.segments,
    ).toEqual([[50, 60]]);
    expect(
      trimSilenceFromSuggestions([suggestion([[10, 15], [52, 58]])], [[5, 20], [50, 60]]),
    ).toEqual([]);
  });
});

describe("mergeChunkSegments", () => {
  it("offsets each chunk onto the full recording's timeline", () => {
    const merged = mergeChunkSegments([
      [[{ start: 0, end: 5, text: "hello" }, { start: 5, end: 9.5, text: "world" }], 0],
      [[{ start: 0, end: 3, text: "second" }], 600],
      [[], 900],
      [[{ start: 0, end: 2, text: "third" }], 1180],
    ]);

    expect(merged).toEqual([
      { start: 0, end: 5, text: "hello" },
      { start: 5, end: 9.5, text: "world" },
      { start: 600, end: 603, text: "second" },
      { start: 1180, end: 1182, text: "third" },
    ]);
    expect(mergeChunkSegments([])).toEqual([]);
  });
});

describe("wav", () => {
  const format = { channels: 1, sampleRate: 16000, bitsPerSample: 16 };

  it("round-trips through build and parse", () => {
    const samples = Int16Array.from({ length: 500 }, (_, i) => ((i * 37) % 2000) - 1000);
    const parsed = parse(buildWav(format, samples));
    expect(parsed.format).toEqual(format);
    expect(Array.from(parsed.samples)).toEqual(Array.from(samples));
  });

  it("rejects anything that is not the mono 16-bit audio extractAudio makes", () => {
    expect(() => parse(new Uint8Array(4))).toThrow(/too short/);
    expect(() => parse(buildWav({ ...format, channels: 2 }, new Int16Array(10)))).toThrow(/mono/);
  });

  it("splits into sub-cap chunks whose offsets reconstruct the timeline", () => {
    // 4 seconds of audio, cut into ~1-second chunks (32,000 bytes at 16 kHz
    // 16-bit mono).
    const samples = Int16Array.from({ length: 16000 * 4 }, () => 5000);
    const chunks = splitIntoChunks(buildWav(format, samples), 32_000);

    expect(chunks).toHaveLength(4);
    expect(chunks.map((chunk) => chunk.startOffsetSecs)).toEqual([0, 1, 2, 3]);
    for (const chunk of chunks) {
      expect(chunk.bytes.byteLength).toBeLessThanOrEqual(32_000 + 44);
      expect(parse(chunk.bytes).format).toEqual(format);
    }
    // Every sample survives exactly once, in order.
    const total = chunks.reduce((sum, chunk) => sum + parse(chunk.bytes).samples.length, 0);
    expect(total).toBe(samples.length);
  });

  it("returns one chunk when the whole file is already under the cap", () => {
    const chunks = splitIntoChunks(buildWav(format, new Int16Array(100)), 1_000_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startOffsetSecs).toBe(0);
  });

  it("prefers a real pause over the exact target, and hard-cuts without one", () => {
    // Loud everywhere except a quiet stretch just before the target: the
    // boundary should move back to the quiet frame.
    const loud = Int16Array.from({ length: 1000 }, () => 10_000);
    for (let index = 400; index < 420; index += 1) loud[index] = 0;
    expect(pickBoundary(loud, 0, 500, loud.length, 10, 200)).toBe(400);

    // Uniformly loud: no frame dips below the window's own baseline, so the
    // target stands.
    const uniform = Int16Array.from({ length: 1000 }, () => 10_000);
    expect(pickBoundary(uniform, 0, 500, uniform.length, 10, 200)).toBe(500);
  });
});
