//! Pure, dependency-free WebVTT (`.vtt`) parsing — used by
//! `db::import_vtt_transcript` to let a user import a real transcript
//! exported from Zoom/Teams (with accurate, per-cue speaker names) as a
//! video's transcript, completely bypassing Whisper for that video.
//!
//! This module never touches the filesystem or the network itself — it
//! only turns an already-read `&str` of file content into `VttCue`s. It has
//! no `coursecut-privacy-invariants` surface of its own; the caller
//! (`db::import_vtt_transcript`) does a single local file read and nothing
//! else, so importing a transcript this way is strictly local and reduces
//! network exposure relative to the existing Whisper path (no upload at
//! all).

/// One parsed WebVTT cue — a caption/subtitle block with a time range and
/// text. `start`/`end` are in seconds (fractional), matching the units
/// `TranscriptSegment` (openai.rs) and `transcript_segments.start`/`end`
/// (the SQLite schema) already use. Speaker-name prefixes some recording
/// platforms embed per cue (e.g. `Alex Rivera: Hi, Jamie. Good morning.`)
/// are literal cue text — this module never tries to split them out into a
/// separate field.
#[derive(Debug, Clone, PartialEq)]
pub struct VttCue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Parses WebVTT cue text (the `WEBVTT` header, optional `NOTE`/`STYLE`
/// blocks, and numbered or unnumbered cue blocks) into `VttCue`s, in file
/// order.
///
/// Format tolerances (validated against a real Zoom/Teams `.vtt` export —
/// see the `real_sample_excerpt` test below):
/// - The first non-empty line must be `WEBVTT`, optionally followed by more
///   text on the same line separated by a space or tab (e.g. `WEBVTT - Some
///   Title`), per the WebVTT spec. Anything else is a fatal parse error.
/// - Cue blocks are separated by one or more blank lines.
/// - A cue block may optionally start with an identifier line (any line not
///   containing `-->`, e.g. a bare integer like `1`, `2`, ...) before its
///   timestamp line — identifier lines are skipped, not treated as cue text.
/// - The timestamp line has the form `HH:MM:SS.mmm --> HH:MM:SS.mmm`
///   (WebVTT always uses a period before milliseconds, unlike SRT's comma).
///   It may have trailing cue settings after the end timestamp (e.g.
///   `align:start position:0%`) — anything after the end timestamp on that
///   line is ignored.
/// - Everything after the timestamp line, up to the next blank line (or
///   EOF), is the cue's text; multiple text lines are joined with a single
///   space (not a newline) into one `text` string, trimmed.
/// - `NOTE` and `STYLE` blocks (a line starting with `NOTE`/`STYLE`, through
///   the next blank line) are skipped entirely, never treated as a cue.
///
/// Individual malformed entries are dropped rather than failing the whole
/// parse (mirrors `openai.rs`'s `parse_lesson_suggestions`/
/// `parse_segment_array`, which drop bad individual entries rather than
/// failing a whole batch): a cue block with no parseable timestamp line, a
/// cue whose `text` is empty after trimming, and a cue whose parsed `end <=
/// start` are all silently skipped. This function only returns `Err` for
/// truly fatal problems: a missing/wrong `WEBVTT` header, or ending up with
/// zero cues at all from a non-empty file (a strong signal the input isn't
/// actually a WebVTT file).
pub fn parse_vtt(content: &str) -> Result<Vec<VttCue>, String> {
    let lines: Vec<&str> = content.lines().collect();

    let header_index = lines
        .iter()
        .position(|line| !line.trim().is_empty())
        .ok_or_else(|| "not a valid WebVTT file: missing WEBVTT header".to_string())?;

    // A leading BOM (common in files exported by Windows tools) sits before
    // the "WEBVTT" text itself.
    let header_line = lines[header_index].trim_start_matches('\u{feff}').trim();
    if header_line != "WEBVTT"
        && !header_line.starts_with("WEBVTT ")
        && !header_line.starts_with("WEBVTT\t")
    {
        return Err("not a valid WebVTT file: missing WEBVTT header".to_string());
    }

    let mut cues = Vec::new();
    let mut i = header_index + 1;
    while i < lines.len() {
        while i < lines.len() && lines[i].trim().is_empty() {
            i += 1;
        }
        if i >= lines.len() {
            break;
        }

        let block_start = i;
        while i < lines.len() && !lines[i].trim().is_empty() {
            i += 1;
        }
        let block = &lines[block_start..i];

        let first_trimmed = block[0].trim();
        if first_trimmed.starts_with("NOTE") || first_trimmed.starts_with("STYLE") {
            continue;
        }

        let Some(timing_index) = block.iter().position(|line| line.contains("-->")) else {
            // No timestamp line in this block at all — not a cue we can use.
            continue;
        };
        let Some((start, end)) = parse_cue_timing(block[timing_index]) else {
            // Malformed timestamp line — skip just this cue, keep going.
            continue;
        };
        if end <= start {
            continue;
        }

        let text: String = block[timing_index + 1..]
            .iter()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if text.is_empty() {
            continue;
        }

        cues.push(VttCue { start, end, text });
    }

    if cues.is_empty() {
        return Err("not a valid WebVTT file: no usable cues found".to_string());
    }

    Ok(cues)
}

/// Parses a cue's timestamp line (`HH:MM:SS.mmm --> HH:MM:SS.mmm`, with
/// optional trailing cue settings after the end timestamp) into
/// `(start, end)` seconds. Returns `None` for anything that doesn't match
/// that shape, rather than erroring — the caller treats that as "skip this
/// cue block".
fn parse_cue_timing(line: &str) -> Option<(f64, f64)> {
    let arrow_pos = line.find("-->")?;
    let start_str = line[..arrow_pos].trim();
    let after_arrow = line[arrow_pos + 3..].trim();
    // Trailing cue settings (e.g. "align:start position:0%") follow the end
    // timestamp separated by whitespace — only the first token is the
    // timestamp itself.
    let end_str = after_arrow.split_whitespace().next()?;

    let start = parse_timestamp(start_str)?;
    let end = parse_timestamp(end_str)?;
    Some((start, end))
}

/// Parses a single `HH:MM:SS.mmm` WebVTT timestamp into fractional seconds.
/// Returns `None` for anything that isn't exactly three `:`-separated
/// components with a numeric seconds-plus-milliseconds part.
fn parse_timestamp(text: &str) -> Option<f64> {
    let parts: Vec<&str> = text.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let hours: f64 = parts[0].parse().ok()?;
    let minutes: f64 = parts[1].parse().ok()?;
    let seconds: f64 = parts[2].parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_basic_doc_comment_example() {
        let content = "WEBVTT\n\n\
            1\n\
            00:00:01.000 --> 00:00:04.500\n\
            Hello there.\n\
            \n\
            2\n\
            00:00:05.000 --> 00:00:06.250\n\
            General Kenobi.\n";

        let cues = parse_vtt(content).expect("should parse");

        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0], VttCue { start: 1.0, end: 4.5, text: "Hello there.".to_string() });
        assert_eq!(
            cues[1],
            VttCue { start: 5.0, end: 6.25, text: "General Kenobi.".to_string() }
        );
    }

    #[test]
    fn header_may_have_trailing_title_text() {
        let content = "WEBVTT - My Recording\n\n\
            00:00:00.000 --> 00:00:01.000\n\
            Text.\n";

        let cues = parse_vtt(content).expect("should parse");
        assert_eq!(cues.len(), 1);
    }

    #[test]
    fn handles_a_note_block_without_treating_it_as_a_cue() {
        let content = "WEBVTT\n\n\
            NOTE This is a comment about the following cue.\n\
            Still part of the note.\n\
            \n\
            1\n\
            00:00:01.000 --> 00:00:02.000\n\
            Real cue text.\n";

        let cues = parse_vtt(content).expect("should parse");

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Real cue text.");
    }

    #[test]
    fn handles_a_style_block_without_treating_it_as_a_cue() {
        let content = "WEBVTT\n\n\
            STYLE\n\
            ::cue { color: yellow; }\n\
            \n\
            00:00:01.000 --> 00:00:02.000\n\
            Real cue text.\n";

        let cues = parse_vtt(content).expect("should parse");

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Real cue text.");
    }

    #[test]
    fn cue_identifier_lines_are_skipped_not_treated_as_text() {
        let content = "WEBVTT\n\n\
            42\n\
            00:00:01.000 --> 00:00:02.000\n\
            Cue text only.\n";

        let cues = parse_vtt(content).expect("should parse");

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Cue text only.");
    }

    #[test]
    fn multi_line_cue_text_is_joined_with_a_single_space() {
        let content = "WEBVTT\n\n\
            00:00:01.000 --> 00:00:04.000\n\
            Line one\n\
            Line two\n";

        let cues = parse_vtt(content).expect("should parse");

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Line one Line two");
    }

    #[test]
    fn timestamp_line_may_have_trailing_cue_settings() {
        let content = "WEBVTT\n\n\
            00:00:01.000 --> 00:00:02.000 align:start position:0%\n\
            Text with settings.\n";

        let cues = parse_vtt(content).expect("should parse");

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].start, 1.0);
        assert_eq!(cues[0].end, 2.0);
    }

    #[test]
    fn a_malformed_timestamp_line_skips_only_that_cue() {
        let content = "WEBVTT\n\n\
            1\n\
            not a real timestamp\n\
            This cue is broken.\n\
            \n\
            2\n\
            00:00:05.000 --> 00:00:06.000\n\
            This cue is fine.\n";

        let cues = parse_vtt(content).expect("should parse, dropping only the bad cue");

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "This cue is fine.");
    }

    #[test]
    fn a_cue_with_end_before_or_equal_to_start_is_skipped() {
        let content = "WEBVTT\n\n\
            00:00:05.000 --> 00:00:05.000\n\
            Zero-length cue.\n\
            \n\
            00:00:06.000 --> 00:00:04.000\n\
            Inverted cue.\n\
            \n\
            00:00:07.000 --> 00:00:08.000\n\
            Good cue.\n";

        let cues = parse_vtt(content).expect("should parse, dropping the two bad cues");

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Good cue.");
    }

    #[test]
    fn a_cue_with_no_text_lines_after_its_timestamp_is_skipped() {
        // A timestamp line with nothing after it before the next blank line
        // — a valid time range but no cue content at all.
        let content = "WEBVTT\n\n\
            1\n\
            00:00:01.000 --> 00:00:02.000\n\
            \n\
            00:00:03.000 --> 00:00:04.000\n\
            Real text.\n";

        let cues = parse_vtt(content).expect("should parse");

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Real text.");
    }

    #[test]
    fn rejects_a_file_with_no_webvtt_header() {
        let content = "1\n00:00:01.000 --> 00:00:02.000\nNot a VTT file.\n";
        assert!(parse_vtt(content).is_err());
    }

    #[test]
    fn rejects_an_empty_file() {
        assert!(parse_vtt("").is_err());
    }

    #[test]
    fn a_file_with_a_header_but_no_usable_cues_is_an_error() {
        let content = "WEBVTT\n\nNOTE just a comment, no cues at all\n";
        assert!(parse_vtt(content).is_err());
    }

    /// A 15-cue excerpt matching the exact shape of a real Zoom-exported
    /// `.vtt` file this parser was built against (numbered cue identifiers,
    /// speaker-name-prefixed text including a lowercase name, millisecond
    /// precision, an ellipsis mid-sentence, a trailed-off phrase) — names
    /// and dialogue here are invented, not from the real recording;
    /// timestamps/structure/quirks are preserved so this still catches
    /// anything the synthetic tests above miss against the real format.
    #[test]
    fn real_sample_excerpt() {
        let content = "WEBVTT\n\n\
1\n\
00:03:07.280 --> 00:03:09.040\n\
Alex Rivera: Hi, Jamie. Good morning.\n\
\n\
2\n\
00:03:12.600 --> 00:03:13.600\n\
jamie chen: Good morning.\n\
\n\
3\n\
00:03:13.760 --> 00:03:14.860\n\
jamie chen: How are you, Lee?\n\
\n\
4\n\
00:03:15.930 --> 00:03:17.799\n\
Alex Rivera: I am doing good now.\n\
\n\
5\n\
00:03:19.830 --> 00:03:20.750\n\
Alex Rivera: How about you?\n\
\n\
6\n\
00:03:21.570 --> 00:03:22.700\n\
jamie chen: Yeah, good.\n\
\n\
7\n\
00:05:18.960 --> 00:05:23.920\n\
Alex Rivera: Okay, so we have… We'll start in 5 more minutes.\n\
\n\
8\n\
00:05:25.370 --> 00:05:29.210\n\
Alex Rivera: We'll see if anyone else is joining, and then we'll start.\n\
\n\
9\n\
00:07:08.880 --> 00:07:09.710\n\
Alex Rivera: Okay.\n\
\n\
10\n\
00:07:11.600 --> 00:07:16.130\n\
Alex Rivera: We have, I think, everyone, I'll share my screen.\n\
\n\
11\n\
00:07:16.310 --> 00:07:20.510\n\
Alex Rivera: I li… Let's start the session, let's see.\n\
\n\
12\n\
00:07:24.580 --> 00:07:25.260\n\
Alex Rivera: Oh.\n\
\n\
13\n\
00:07:27.080 --> 00:07:28.280\n\
Alex Rivera: There's the agenda.\n\
\n\
14\n\
00:07:48.510 --> 00:07:49.240\n\
Alex Rivera: annual.\n\
\n\
15\n\
00:09:01.500 --> 00:09:02.360\n\
Alex Rivera: Okay.\n";

        let cues = parse_vtt(content).expect("should parse a real Zoom VTT excerpt");

        assert_eq!(cues.len(), 15);
        assert_eq!(cues[0].start, 187.28);
        assert_eq!(cues[0].end, 189.04);
        assert_eq!(cues[0].text, "Alex Rivera: Hi, Jamie. Good morning.");
        assert_eq!(cues[1].text, "jamie chen: Good morning.");
        // Speaker-name prefixes are kept as literal cue text, never split out.
        assert!(cues[2].text.starts_with("jamie chen: "));
        assert_eq!(
            cues[6].text,
            "Alex Rivera: Okay, so we have… We'll start in 5 more minutes."
        );
        assert_eq!(cues[14].text, "Alex Rivera: Okay.");
        assert_eq!(cues[14].start, 541.5);
        assert_eq!(cues[14].end, 542.36);
    }
}
