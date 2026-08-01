import { formatTimestamp } from "./timestamp";

/** A segment's source-video bounds — structurally what `LessonSegmentRange`
 * (and `LessonSegment`) already provide, kept local so this module doesn't
 * depend on the IPC layer. */
interface Range {
  start: number;
  end: number;
}

/** Cumulative *final-video* duration before each segment — the same
 * stitched-together-timeline math `LessonPreviewPlayer` and the segment
 * list's read-only "Final video start/end" columns already use. Index `i`
 * is where segment `i` begins once the lesson is exported. */
export function segmentOffsets(segments: readonly Range[]): number[] {
  let acc = 0;
  return segments.map((segment) => {
    const offset = acc;
    acc += segment.end - segment.start;
    return offset;
  });
}

/** Final-video seconds → source-video seconds.
 *
 * Segments are laid end to end on the final timeline, so a position in the
 * exported lesson maps back into whichever source segment covers it.
 *
 * Two rules worth stating, since both are arbitrary but must stay stable:
 * * Offsets are treated as half-open `[offset, offset + duration)`, so a
 *   time landing exactly on a boundary belongs to the **following** segment
 *   — the end of segment *i* and the start of segment *i+1* are the same
 *   instant on the final timeline, and something has to break the tie.
 * * Anything past the end of the final video clamps to the last segment's
 *   `end`, so "trim everything after 25:00" on a 20-minute lesson means
 *   "nothing to trim" rather than an out-of-range boundary.
 *
 * With no segments there is no final timeline at all; the input is returned
 * unchanged, which keeps callers from having to special-case an empty
 * lesson.
 */
export function finalToSource(segments: readonly Range[], finalSeconds: number): number {
  if (segments.length === 0) return finalSeconds;

  // Offsets are a running sum of float durations, so a boundary the user
  // reads off the segment list as an exact value (`00:02:52:900` → 172.9)
  // is rarely bit-identical to the accumulated one (172.90000000000003).
  // Without this tolerance the comparison below decides boundary hits by
  // accumulated rounding error, which sends "cut from <segment N's start>"
  // to the *end of segment N-1* — a different part of the video entirely.
  const EPSILON = 1e-6;

  let acc = 0;
  for (const segment of segments) {
    const duration = segment.end - segment.start;
    if (finalSeconds < acc + duration - EPSILON) {
      // `max(0, …)` catches a negative input, pinning it to the very start.
      return segment.start + Math.max(0, finalSeconds - acc);
    }
    acc += duration;
  }

  return segments[segments.length - 1].end;
}

/** Literal timestamps in free text: 2 to 4 colon-separated groups of 1-3
 * digits (`mm:ss`, `h:mm:ss`, `hh:mm:ss:ff`/`hh:mm:ss:fff`), bounded by
 * word breaks so a longer digit run isn't matched mid-string.
 *
 * Deliberately the same pattern as `extract_timestamps_seconds` in
 * `src-tauri/src/openai.rs` — that function sizes the transcript context
 * window from the timestamps it finds in the instruction, so if this matched
 * a different set, the window and the rewritten times below could disagree.
 * It is looser than `parseTimestamp`/`parseTimestampMs` in `./timestamp`,
 * because someone typing into a prompt box won't reliably zero-pad. */
const TIMESTAMP_PATTERN = /\b\d{1,3}(?::\d{1,3}){1,3}\b/g;

/** Parses one `TIMESTAMP_PATTERN` match into seconds, mirroring the Rust
 * side's arithmetic — including that a trailing fractional group is scaled
 * by however many digits were actually typed (`78` is 0.78s, `078` is
 * 0.078s), so the same string never reads as two different values across
 * the IPC boundary. */
function matchToSeconds(raw: string): number | null {
  const parts = raw.split(":");
  const values = parts.map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;

  if (values.length === 2) return values[0] * 60 + values[1];
  if (values.length === 3) return values[0] * 3600 + values[1] * 60 + values[2];
  if (values.length === 4) {
    const divisor = 10 ** parts[3].length;
    return values[0] * 3600 + values[1] * 60 + values[2] + values[3] / divisor;
  }
  return null;
}

/** Rewrites every literal timestamp in `instruction` from the lesson's
 * final-video timeline onto the source video's, leaving all other text
 * exactly as typed.
 *
 * This is what the floating prompt's Original/Final toggle actually does.
 * The AI edit path — the system prompt, the transcript context it sends, and
 * every range it returns — speaks only the source timeline, so rather than
 * teaching the model a second one, "Final" mode converts the user's
 * timestamps up front and the backend stays unchanged. An instruction with
 * no timestamps in it ("cut the tangent about pricing") comes back
 * untouched, which is correct: there is nothing timeline-dependent in it.
 *
 * Rewritten values are emitted as `hh:mm:ss` — deliberately *not* the
 * millisecond-precision `hh:mm:ss:fff`. The model is the thing that actually
 * has to read these back, and `LESSON_EDIT_SYSTEM_PROMPT` only ever
 * describes `m:ss`/`h:mm:ss` timestamps (as does the review popup's own hint
 * to the user). A four-group `00:02:45:580` is outside that contract and
 * reads just as naturally as hours:minutes:seconds:frames, so a model that
 * can't resolve it falls back to transcript wording — which looks exactly
 * like the toggle having done nothing. Whole seconds cost sub-second
 * precision the surrounding UX never offered here anyway. */
export function rewriteFinalTimestampsToSource(
  instruction: string,
  segments: readonly Range[],
): string {
  if (segments.length === 0) return instruction;

  return instruction.replace(TIMESTAMP_PATTERN, (matched) => {
    const finalSeconds = matchToSeconds(matched);
    if (finalSeconds === null) return matched;
    return formatTimestamp(finalToSource(segments, finalSeconds));
  });
}
