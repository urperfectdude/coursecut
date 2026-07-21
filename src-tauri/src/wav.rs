//! Pure, dependency-free WAV parsing/rebuilding/splitting for chunked
//! Whisper uploads (see `docs/whisper-chunking-plan.md`).
//!
//! Only ever operates on already-extracted local audio bytes already in
//! memory (produced by `ffmpeg::extract_audio` — mono, 16kHz, 16-bit PCM);
//! nothing here touches the filesystem or the network, so it has no
//! `coursecut-privacy-invariants` surface of its own. `openai.rs` is the
//! only caller, and only for splitting audio that's already been read off
//! disk, before uploading each piece to Whisper.

/// The handful of `fmt ` chunk fields the rest of this module needs.
/// Mono is assumed everywhere else in this module (matching
/// `extract_audio`'s fixed `-ac 1` output) — `parse` rejects anything else
/// rather than silently mis-splitting a multi-channel file.
#[derive(Debug, Clone, PartialEq)]
pub struct WavFormat {
    pub channels: u16,
    pub sample_rate: u32,
    pub bits_per_sample: u16,
}

/// A parsed WAV file: its format plus the `data` chunk decoded into signed
/// 16-bit samples. Owned (not a zero-copy borrow of the original bytes) —
/// safe Rust can't reinterpret an arbitrary, unaligned `&[u8]` sub-slice as
/// `&[i16]` without either `unsafe` or a byte-order-aware crate, and this
/// module is required to stay dependency-free, so decoding into an owned
/// `Vec<i16>` is the straightforward safe option. Callers needing `&[i16]`
/// use `samples.as_slice()` / the `Vec`'s `Deref<Target = [i16]>`.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedWav {
    pub format: WavFormat,
    pub samples: Vec<i16>,
}

/// Walks a WAV byte buffer's RIFF chunks (not assuming a fixed 44-byte
/// header — tolerates extra chunks like `LIST`/`INFO` before or after
/// `fmt `/`data`) to find the format and sample data, and decodes the
/// sample data into `i16`s.
pub fn parse(bytes: &[u8]) -> Result<ParsedWav, String> {
    if bytes.len() < 12 {
        return Err("WAV data is too short to contain a RIFF header".to_string());
    }
    if &bytes[0..4] != b"RIFF" {
        return Err("not a RIFF file (missing 'RIFF' tag)".to_string());
    }
    if &bytes[8..12] != b"WAVE" {
        return Err("not a WAVE file (missing 'WAVE' tag)".to_string());
    }

    let mut format: Option<WavFormat> = None;
    let mut data_range: Option<(usize, usize)> = None;

    let mut pos = 12usize;
    while pos + 8 <= bytes.len() {
        let chunk_id = &bytes[pos..pos + 4];
        let chunk_size =
            u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body_start = pos + 8;
        let body_end = body_start
            .checked_add(chunk_size)
            .filter(|&end| end <= bytes.len())
            .ok_or_else(|| "WAV chunk size exceeds the file's length".to_string())?;

        match chunk_id {
            b"fmt " => {
                if chunk_size < 16 {
                    return Err("'fmt ' chunk is smaller than the minimum 16 bytes".to_string());
                }
                let fmt_bytes = &bytes[body_start..body_end];
                format = Some(WavFormat {
                    channels: u16::from_le_bytes(fmt_bytes[2..4].try_into().unwrap()),
                    sample_rate: u32::from_le_bytes(fmt_bytes[4..8].try_into().unwrap()),
                    bits_per_sample: u16::from_le_bytes(fmt_bytes[14..16].try_into().unwrap()),
                });
            }
            b"data" => {
                data_range = Some((body_start, chunk_size));
            }
            _ => {}
        }

        // RIFF chunks are word-aligned: an odd-sized chunk body is followed
        // by one pad byte that isn't part of the chunk's declared size.
        pos = body_end + (chunk_size % 2);
    }

    let format = format.ok_or_else(|| "WAV file has no 'fmt ' chunk".to_string())?;
    if format.channels != 1 {
        return Err(format!(
            "only mono WAV is supported (extract_audio always produces mono), got {} channels",
            format.channels
        ));
    }
    if format.bits_per_sample != 16 {
        return Err(format!(
            "only 16-bit PCM WAV is supported (extract_audio always produces 16-bit), got {}-bit",
            format.bits_per_sample
        ));
    }

    let (data_start, data_len) =
        data_range.ok_or_else(|| "WAV file has no 'data' chunk".to_string())?;
    let data_bytes = &bytes[data_start..data_start + data_len];

    let samples: Vec<i16> = data_bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();

    Ok(ParsedWav { format, samples })
}

/// Rebuilds a minimal, valid WAV (RIFF/`fmt `/`data` only, correct sizes)
/// from a sample sub-range — used to emit each chunk.
pub fn build_wav(format: &WavFormat, samples: &[i16]) -> Vec<u8> {
    let bytes_per_sample = (format.bits_per_sample / 8) as u32;
    let block_align = format.channels as u32 * bytes_per_sample;
    let byte_rate = format.sample_rate * block_align;
    let data_len = (samples.len() * 2) as u32;

    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size (PCM)
    out.extend_from_slice(&1u16.to_le_bytes()); // format tag: PCM
    out.extend_from_slice(&format.channels.to_le_bytes());
    out.extend_from_slice(&format.sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&(block_align as u16).to_le_bytes());
    out.extend_from_slice(&format.bits_per_sample.to_le_bytes());

    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }

    out
}

// ---------------------------------------------------------------------
// Silence-seeking chunk-boundary selection
// ---------------------------------------------------------------------

/// Frame length for energy scanning: ~20ms.
const FRAME_MS: f64 = 20.0;
/// How far on either side of a target boundary to search for a natural
/// pause: ~25s (within the plan's suggested ±20-30s range).
const SEARCH_WINDOW_SECS: f64 = 25.0;
/// A frame only counts as a real pause if its mean amplitude is at most
/// this fraction of the search window's own baseline (mid-point of the
/// plan's suggested ~30-40% range).
const BASELINE_DIP_RATIO: f64 = 0.35;

/// Picks a cut point near `target` (a sample index), preferring a real
/// pause in speech within `frame_len`/`window_samples` of it, falling back
/// to `target` itself if no frame in the window dips meaningfully below
/// the window's own baseline amplitude. Parameterized by `frame_len` /
/// `window_samples` (rather than deriving them from a sample rate inline)
/// so the algorithm itself can be unit-tested against small, readable
/// synthetic buffers independent of real-world timing constants; the
/// production values come from `FRAME_MS/SEARCH_WINDOW_SECS` via
/// `find_boundary`, below.
fn pick_boundary(
    samples: &[i16],
    chunk_start: usize,
    target: usize,
    total: usize,
    frame_len: usize,
    window_samples: usize,
) -> usize {
    let window_start = target.saturating_sub(window_samples).max(chunk_start);
    let window_end = (target + window_samples).min(total);

    if window_end < window_start + frame_len {
        return target;
    }

    let mut frames: Vec<(usize, f64)> = Vec::new();
    let mut pos = window_start;
    while pos + frame_len <= window_end {
        let frame = &samples[pos..pos + frame_len];
        let amplitude =
            frame.iter().map(|&sample| (sample as f64).abs()).sum::<f64>() / frame_len as f64;
        frames.push((pos, amplitude));
        pos += frame_len;
    }

    if frames.is_empty() {
        return target;
    }

    // Baseline is this window's own average frame amplitude — judged
    // per-window (not against a fixed global constant) so an elevated
    // background noise floor (e.g. HVAC hum) doesn't prevent detecting a
    // real relative dip.
    let baseline: f64 = frames.iter().map(|&(_, amplitude)| amplitude).sum::<f64>()
        / frames.len() as f64;

    let (best_pos, best_amplitude) = frames.into_iter().fold(
        (target, f64::INFINITY),
        |best, (pos, amplitude)| if amplitude < best.1 { (pos, amplitude) } else { best },
    );

    if baseline > 0.0 && best_amplitude <= baseline * BASELINE_DIP_RATIO {
        best_pos
    } else {
        // No meaningful pause found (continuous speech/music through the
        // window, or a uniformly loud/noisy recording) — hard-cut at the
        // exact target rather than searching further.
        target
    }
}

/// `pick_boundary` with the production frame/window sizes derived from
/// `sample_rate`.
fn find_boundary(samples: &[i16], chunk_start: usize, target: usize, total: usize, sample_rate: u32) -> usize {
    let sample_rate = (sample_rate.max(1)) as f64;
    let frame_len = ((sample_rate * FRAME_MS / 1000.0).round() as usize).max(1);
    let window_samples = ((sample_rate * SEARCH_WINDOW_SECS).round() as usize).max(frame_len);
    pick_boundary(samples, chunk_start, target, total, frame_len, window_samples)
}

// ---------------------------------------------------------------------
// Splitting into chunk WAVs
// ---------------------------------------------------------------------

/// Splits `bytes` (a full WAV file) into a sequence of sub-`max_chunk_bytes`
/// WAV chunks, each paired with the start offset (in seconds, into the
/// original recording) its samples begin at. Boundaries are chosen via
/// `find_boundary` (silence-seeking with a hard-cut fallback) except for
/// the final chunk, which simply runs to the end of the audio.
///
/// If the whole file is already at or under `max_chunk_bytes`, this
/// returns a single chunk covering the whole recording at offset `0.0` —
/// callers that already special-case "under threshold, don't bother
/// chunking" (see `openai.rs`) won't hit this path in practice, but it
/// keeps this function correct standalone.
pub fn split_into_chunks(
    bytes: &[u8],
    max_chunk_bytes: usize,
) -> Result<Vec<(Vec<u8>, f64)>, String> {
    let parsed = parse(bytes)?;
    let format = parsed.format;
    let samples = parsed.samples;

    let bytes_per_sample = (format.bits_per_sample / 8) as usize;
    if bytes_per_sample == 0 {
        return Err("invalid WAV format: 0 bits per sample".to_string());
    }
    // Mono, so 1 sample == 1 frame — no channel multiplier (enforced by
    // `parse` rejecting non-mono input above).
    let chunk_samples = (max_chunk_bytes / bytes_per_sample).max(1);

    let total = samples.len();
    let mut chunks = Vec::new();
    let mut start = 0usize;

    while start < total {
        let remaining = total - start;
        let end = if remaining <= chunk_samples {
            total
        } else {
            let target = start + chunk_samples;
            find_boundary(&samples, start, target, total, format.sample_rate)
        };
        // Guard against a degenerate zero-length chunk (shouldn't happen:
        // `target > start` whenever this branch runs, and `pick_boundary`
        // never returns below `chunk_start`) so the loop can't spin
        // forever.
        let end = end.max(start + 1).min(total);

        let wav_bytes = build_wav(&format, &samples[start..end]);
        let start_offset_secs = start as f64 / format.sample_rate.max(1) as f64;
        chunks.push((wav_bytes, start_offset_secs));

        start = end;
    }

    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_format(sample_rate: u32) -> WavFormat {
        WavFormat {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
        }
    }

    // ---- round-trip parse/build ----

    #[test]
    fn round_trips_through_build_and_parse() {
        let format = make_format(16000);
        let samples: Vec<i16> = (0..500).map(|i| ((i * 37) % 2000 - 1000) as i16).collect();
        let bytes = build_wav(&format, &samples);

        let parsed = parse(&bytes).expect("should parse a freshly built WAV");

        assert_eq!(parsed.format, format);
        assert_eq!(parsed.samples, samples);
    }

    #[test]
    fn parse_rejects_non_mono() {
        let format = WavFormat {
            channels: 2,
            sample_rate: 16000,
            bits_per_sample: 16,
        };
        let bytes = build_wav(&format, &[0, 1, 2, 3]);
        assert!(parse(&bytes).is_err());
    }

    #[test]
    fn parse_rejects_missing_riff_tag() {
        let mut bytes = build_wav(&make_format(16000), &[1, 2, 3]);
        bytes[0] = b'X';
        assert!(parse(&bytes).is_err());
    }

    #[test]
    fn parse_tolerates_extra_chunks_before_data() {
        // Build a WAV, then splice in a fake "LIST" chunk right after `fmt `
        // (before `data`) to simulate a muxer that emits extra chunks —
        // the parser should walk past it rather than assuming a fixed
        // 44-byte header.
        let format = make_format(8000);
        let samples: Vec<i16> = vec![10, -10, 20, -20, 30];
        let plain = build_wav(&format, &samples);

        // `plain` layout: RIFF(12) + fmt(8+16) + data(8+len). Splice a LIST
        // chunk with 4 bytes of body right after the fmt chunk (offset 36).
        let fmt_chunk_end = 12 + 8 + 16;
        let mut spliced = Vec::new();
        spliced.extend_from_slice(&plain[..fmt_chunk_end]);
        spliced.extend_from_slice(b"LIST");
        spliced.extend_from_slice(&4u32.to_le_bytes());
        spliced.extend_from_slice(&[0, 0, 0, 0]);
        spliced.extend_from_slice(&plain[fmt_chunk_end..]);

        // Fix up the RIFF size to account for the spliced bytes.
        let extra = spliced.len() - plain.len();
        let riff_size = u32::from_le_bytes(spliced[4..8].try_into().unwrap()) + extra as u32;
        spliced[4..8].copy_from_slice(&riff_size.to_le_bytes());

        let parsed = parse(&spliced).expect("parser should walk past the LIST chunk");
        assert_eq!(parsed.format, format);
        assert_eq!(parsed.samples, samples);
    }

    // ---- chunk-boundary picking (pick_boundary directly, small readable
    // synthetic constants rather than real-world 16kHz/20ms/25s sizes) ----

    /// Builds a buffer of `len` samples, loud (amplitude `loud`) everywhere,
    /// except `quiet_range` which is set to amplitude `quiet` (alternating
    /// sign so it isn't just literal zeros unless `quiet == 0`).
    fn buffer_with_quiet_stretch(
        len: usize,
        loud: i16,
        quiet: i16,
        quiet_range: std::ops::Range<usize>,
    ) -> Vec<i16> {
        (0..len)
            .map(|i| {
                let sign = if i % 2 == 0 { 1 } else { -1 };
                let amplitude = if quiet_range.contains(&i) { quiet } else { loud };
                sign * amplitude
            })
            .collect()
    }

    #[test]
    fn picks_a_cut_inside_a_known_quiet_stretch() {
        let total = 200;
        let quiet_range = 80..120;
        let samples = buffer_with_quiet_stretch(total, 1000, 5, quiet_range.clone());

        let boundary = pick_boundary(&samples, 0, /* target */ 100, total, /* frame_len */ 4, /* window_samples */ 40);

        assert!(
            quiet_range.contains(&boundary),
            "expected a cut inside the quiet stretch {quiet_range:?}, got {boundary}"
        );
    }

    #[test]
    fn elevated_noise_floor_still_finds_the_relative_dip() {
        // Baseline amplitude throughout is 500 (not silence) — only the dip
        // to 100 (20% of baseline, comfortably under the 35% threshold) is
        // a "real" pause.
        let total = 200;
        let quiet_range = 80..120;
        let samples = buffer_with_quiet_stretch(total, 500, 100, quiet_range.clone());

        let boundary = pick_boundary(&samples, 0, 100, total, 4, 40);

        assert!(
            quiet_range.contains(&boundary),
            "expected the relative dip to be detected against an elevated baseline, got {boundary}"
        );
    }

    #[test]
    fn falls_back_to_hard_cut_when_no_real_pause_exists() {
        // Uniform loud amplitude throughout the whole search window (a
        // little jitter so it isn't a perfectly flat line, but never a
        // meaningful dip below baseline) — no frame should qualify as a
        // pause, so the exact target should be returned.
        let total = 200;
        let samples: Vec<i16> = (0..total)
            .map(|i| {
                let sign = if i % 2 == 0 { 1 } else { -1 };
                sign * (900 + (i % 7) as i16 * 10)
            })
            .collect();

        let boundary = pick_boundary(&samples, 0, 100, total, 4, 40);

        assert_eq!(boundary, 100, "expected the hard-cut fallback at the exact target");
    }

    #[test]
    fn quiet_stretch_outside_the_search_window_is_ignored() {
        // The quiet stretch exists, but far outside the ±window around the
        // target — should not be found, so this should also hard-cut.
        let total = 400;
        let samples = buffer_with_quiet_stretch(total, 1000, 5, 300..340);

        let boundary = pick_boundary(&samples, 0, 100, total, 4, 40);

        assert_eq!(boundary, 100);
    }

    // ---- full splitter ----

    #[test]
    fn splits_exact_multiple_into_equal_chunks_with_no_real_pause() {
        let format = make_format(100); // 100 Hz -> easy offset-in-seconds math
        // Uniform loud, alternating sign, slight jitter so it's not a
        // perfectly flat line — never a meaningful relative dip anywhere.
        let samples: Vec<i16> = (0..300)
            .map(|i| {
                let sign = if i % 2 == 0 { 1 } else { -1 };
                sign * (900 + (i % 7) as i16 * 10)
            })
            .collect();
        let bytes = build_wav(&format, &samples);

        // bytes_per_sample = 2, so max_chunk_bytes=200 -> chunk_samples=100.
        let chunks = split_into_chunks(&bytes, 200).expect("should split cleanly");

        assert_eq!(chunks.len(), 3);
        for (chunk_bytes, _) in &chunks {
            let parsed = parse(chunk_bytes).unwrap();
            assert_eq!(parsed.samples.len(), 100);
        }
        assert_eq!(chunks[0].1, 0.0);
        assert_eq!(chunks[1].1, 1.0, "chunk 2 should start at sample 100 / 100Hz = 1.0s");
        assert_eq!(chunks[2].1, 2.0);
    }

    #[test]
    fn splits_remainder_into_a_shorter_final_chunk() {
        let format = make_format(100);
        let samples: Vec<i16> = (0..240)
            .map(|i| {
                let sign = if i % 2 == 0 { 1 } else { -1 };
                sign * (900 + (i % 7) as i16 * 10)
            })
            .collect();
        let bytes = build_wav(&format, &samples);

        let chunks = split_into_chunks(&bytes, 200).expect("should split cleanly");

        assert_eq!(chunks.len(), 3);
        let lengths: Vec<usize> = chunks
            .iter()
            .map(|(bytes, _)| parse(bytes).unwrap().samples.len())
            .collect();
        assert_eq!(lengths, vec![100, 100, 40]);
        assert_eq!(chunks[2].1, 2.0);
    }

    #[test]
    fn file_already_under_the_limit_produces_a_single_chunk_at_offset_zero() {
        let format = make_format(100);
        let samples: Vec<i16> = vec![1, 2, 3, 4, 5];
        let bytes = build_wav(&format, &samples);

        let chunks = split_into_chunks(&bytes, 1_000_000).expect("should split cleanly");

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].1, 0.0);
        assert_eq!(parse(&chunks[0].0).unwrap().samples, samples);
    }
}
