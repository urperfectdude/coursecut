//! Local audio extraction and duration probing via the bundled FFmpeg /
//! ffprobe sidecars (`tauri-plugin-shell`, see `tauri.conf.json`'s
//! `bundle.externalBin` and `capabilities/default.json`).
//!
//! Per `coursecut-privacy-invariants`: this module only ever reads the
//! source video and writes a new local audio file next to the app's cache
//! dir — nothing here uploads or transmits video content anywhere. No
//! OpenAI/network calls belong in this module (see `settings.rs`/a future
//! `openai.rs` for that).

use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::db::{self, DbConnection, Video};
use crate::progress::{self, Stage};

/// Directory extracted audio is cached in, keyed by content hash:
/// `<app_cache_dir>/audio/<hash>.wav`. Created on first use.
fn audio_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("could not resolve app cache dir: {err}"))?
        .join("audio");
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("could not create audio cache dir: {err}"))?;
    Ok(dir)
}

/// Directory transient segment-playback clips (`extract_playback_clip`) are
/// written to: `<app_cache_dir>/playback/<uuid>.wav`. Deliberately *not*
/// the OS system temp dir (`std::env::temp_dir()`, what this used
/// initially) — the webview's asset protocol only serves paths within its
/// configured `scope` (see `tauri.conf.json`'s `assetProtocol.scope`,
/// `$APPCACHE/**`) plus whatever the user has explicitly picked via the
/// native file dialog; an arbitrary system temp path is neither, so
/// `convertFileSrc` on one throws `NotSupportedError` when the webview
/// tries to load it. The app's own cache dir is a location this app
/// controls and can explicitly grant itself scope over. Created on first
/// use; unlike `audio_cache_dir`, entries here aren't content-hash-keyed —
/// each clip is deleted right after use (see `delete_playback_clip`), not
/// cached long-term.
fn playback_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("could not resolve app cache dir: {err}"))?
        .join("playback");
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("could not create playback cache dir: {err}"))?;
    Ok(dir)
}

/// Runs the bundled `ffprobe` sidecar to read `video_path`'s duration, in
/// seconds. Local-only: the path is passed as a CLI arg, nothing is
/// uploaded.
pub async fn probe_duration(app: &AppHandle, video_path: &str) -> Result<f64, String> {
    let output = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|err| format!("could not resolve ffprobe sidecar: {err}"))?
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            video_path,
        ])
        .output()
        .await
        .map_err(|err| format!("ffprobe failed to run: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe exited with an error: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .trim()
        .parse::<f64>()
        .map_err(|err| format!("could not parse ffprobe duration output {stdout:?}: {err}"))
}

/// Runs the bundled `ffprobe` sidecar to read `path`'s pixel width/height —
/// works on both videos and still images (ffprobe treats a single-frame
/// image as a one-frame video stream), which is what lets `export_lesson`'s
/// overlay path use this for both the main video and each overlay image.
///
/// This exists because the alternative — letting ffmpeg's own
/// `scale2ref`/`overlay` filters resolve dimensions dynamically via
/// expression variables (`main_w`/`main_h`, or the "correct" `rw`/`rh` this
/// ffmpeg build actually uses for `scale2ref`'s reference dims) — turned
/// out to be unreliable: `force_original_aspect_ratio` combined with
/// expression-based `w`/`h` silently produced wrong (non-aspect-preserving)
/// output dimensions in this ffmpeg build, verified via the CLI on a square
/// test image scaled into a non-square target box (expected the box's
/// smaller dimension on both axes; got the box's raw, unaspected
/// dimensions instead — several reformulations of the expression were
/// tried and each failed differently). Probing real pixel dimensions once
/// and building the filter graph with literal numbers sidesteps all of
/// that: no `scale2ref`, no expression-evaluation-order surprises, and the
/// arithmetic lives in Rust where it's actually testable.
pub async fn probe_dimensions(app: &AppHandle, path: &str) -> Result<(u32, u32), String> {
    let output = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|err| format!("could not resolve ffprobe sidecar: {err}"))?
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
            path,
        ])
        .output()
        .await
        .map_err(|err| format!("ffprobe failed to run: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe exited with an error: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let (width, height) = stdout
        .trim()
        .split_once('x')
        .ok_or_else(|| format!("could not parse ffprobe dimensions output {stdout:?}"))?;
    let width: u32 = width
        .parse()
        .map_err(|err| format!("could not parse ffprobe width {width:?}: {err}"))?;
    let height: u32 = height
        .parse()
        .map_err(|err| format!("could not parse ffprobe height {height:?}: {err}"))?;
    Ok((width, height))
}

/// The source's stream parameters that every piece of an export with an
/// inserted intro/outro slide is encoded with, so the stream-copy
/// `concat_videos` can join them: a slide piece (a looped PNG plus generated
/// silence) has none of its own. Probed once per export by
/// `probe_stream_params`.
#[derive(Debug, Clone, PartialEq)]
pub struct StreamParams {
    /// Frame rate as ffprobe reports it, e.g. `"25/1"` or `"30000/1001"`.
    pub fps: String,
    /// `None` when the source has no audio: slide pieces are then
    /// video-only too, and mute windows are dropped.
    pub audio: Option<AudioParams>,
    /// The source's colour tags, each `None` when untagged. They're handled
    /// independently: slide pieces convert with the tagged matrix and carry
    /// exactly the tags the source has, so their H.264 headers match the
    /// lecture pieces' even for a partially tagged source.
    pub color_space: Option<String>,
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
    /// `"tv"` or `"pc"` when the source says.
    pub color_range: Option<String>,
    /// The source's sample aspect ratio as `num/den`, when it sets one.
    /// Slide pieces copy it (`setsar`, `0` when unset): the concat output
    /// keeps only the first piece's H.264 headers, so a slide piece whose
    /// SAR differs would relabel the whole lecture (verified: with the
    /// source's SAR unset, `setsar=1` was the only header difference).
    pub sar: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioParams {
    pub sample_rate: u32,
    pub channels: u32,
    /// Channel-layout name for `anullsrc`'s `cl=`, e.g. `"stereo"`.
    pub layout: String,
}

/// `"25/1"` -> 25.0; `None` for `"0/0"` or anything unparsable.
fn parse_rate(rate: &str) -> Option<f64> {
    let (num, den) = rate.split_once('/').unwrap_or((rate, "1"));
    let num: f64 = num.trim().parse().ok()?;
    let den: f64 = den.trim().parse().ok()?;
    (num > 0.0 && den > 0.0).then_some(num / den)
}

/// Builds `StreamParams` from `ffprobe -of json -show_entries stream=...`
/// output (first video stream, first audio stream). Prefers `r_frame_rate`
/// and falls back to `avg_frame_rate`, then 30, when it's missing or
/// implausible (variable-frame-rate screen recordings can report a
/// timebase-sized `r_frame_rate` such as `90000/1`).
pub(crate) fn parse_stream_params(json: &str) -> Result<StreamParams, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|err| format!("could not parse ffprobe stream output: {err}"))?;
    let streams = value
        .get("streams")
        .and_then(|streams| streams.as_array())
        .ok_or_else(|| "ffprobe reported no streams".to_string())?;
    let field = |stream: &serde_json::Value, key: &str| -> Option<String> {
        match stream.get(key)? {
            serde_json::Value::String(text) if !text.is_empty() && text != "unknown" => Some(text.clone()),
            serde_json::Value::Number(number) => Some(number.to_string()),
            _ => None,
        }
    };
    let of_type =
        |kind: &str| streams.iter().find(|stream| stream.get("codec_type").and_then(|t| t.as_str()) == Some(kind));

    let video = of_type("video").ok_or_else(|| "source has no video stream".to_string())?;
    let plausible = |rate: &Option<String>| {
        rate.as_deref()
            .and_then(parse_rate)
            .is_some_and(|fps| fps <= 120.0)
    };
    let r_frame_rate = field(video, "r_frame_rate");
    let avg_frame_rate = field(video, "avg_frame_rate");
    let fps = if plausible(&r_frame_rate) {
        r_frame_rate.unwrap_or_default()
    } else if plausible(&avg_frame_rate) {
        avg_frame_rate.unwrap_or_default()
    } else {
        "30".to_string()
    };

    let color_space = field(video, "color_space");
    let color_primaries = field(video, "color_primaries");
    let color_transfer = field(video, "color_transfer");
    let color_range = field(video, "color_range").filter(|range| range == "tv" || range == "pc");
    let sar = field(video, "sample_aspect_ratio")
        .and_then(|sar| sar.split_once(':').map(|(num, den)| (num.to_string(), den.to_string())))
        .filter(|(num, den)| {
            num.parse::<u32>().is_ok_and(|num| num > 0) && den.parse::<u32>().is_ok_and(|den| den > 0)
        })
        .map(|(num, den)| format!("{num}/{den}"));

    let audio = match of_type("audio") {
        None => None,
        Some(audio) => {
            let sample_rate: u32 = field(audio, "sample_rate")
                .and_then(|rate| rate.parse().ok())
                .ok_or_else(|| "could not read the source's audio sample rate".to_string())?;
            let channels: u32 = field(audio, "channels")
                .and_then(|count| count.parse().ok())
                .ok_or_else(|| "could not read the source's audio channel count".to_string())?;
            let layout = field(audio, "channel_layout").unwrap_or_else(|| match channels {
                1 => "mono".to_string(),
                2 => "stereo".to_string(),
                other => format!("{other}c"),
            });
            Some(AudioParams {
                sample_rate,
                channels,
                layout,
            })
        }
    };

    Ok(StreamParams {
        fps,
        audio,
        color_space,
        color_primaries,
        color_transfer,
        color_range,
        sar,
    })
}

/// Probes `path`'s `StreamParams`. Local-only, like `probe_dimensions`.
pub async fn probe_stream_params(app: &AppHandle, path: &str) -> Result<StreamParams, String> {
    let output = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|err| format!("could not resolve ffprobe sidecar: {err}"))?
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,r_frame_rate,avg_frame_rate,sample_aspect_ratio,sample_rate,channels,channel_layout,color_space,color_primaries,color_transfer,color_range",
            "-of",
            "json",
            path,
        ])
        .output()
        .await
        .map_err(|err| format!("ffprobe failed to run: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe exited with an error: {}", stderr.trim()));
    }
    parse_stream_params(&String::from_utf8_lossy(&output.stdout))
}

/// SHA-256 hash of `video_path`'s full contents, used as the cache key for
/// extracted audio (PRD §7.4 — "never retranscribe unchanged videos" starts
/// here, at the audio-extraction stage). Reads the file in fixed-size
/// chunks rather than loading it into memory at once, since lecture
/// recordings can be multi-gigabyte.
pub fn content_hash(video_path: &str) -> Result<String, String> {
    let mut file = std::fs::File::open(video_path)
        .map_err(|err| format!("could not open {video_path}: {err}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|err| format!("could not read {video_path}: {err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Extracts mono 16kHz audio from `video_path` into `output_path`, Opus-encoded
/// in an Ogg container — a format Whisper accepts (PRD §7.3/§9). Reads the
/// source video and writes only the new audio file; the source is never
/// modified, copied, or uploaded.
///
/// **Why Opus rather than the raw PCM WAV this used to emit.** Whisper's API
/// caps an upload at 25MB regardless of model, and mono/16kHz/16-bit PCM runs
/// at 32 KB/s — so the cap landed at ~13 minutes of audio and any real lecture
/// had to be split into a dozen separate requests (see `transcribe_audio`).
/// Opus at 24 kbps is ~3 KB/s, which puts over two hours in a single request.
/// Whisper resamples everything to 16kHz mono internally, and Opus at this
/// bitrate is built for exactly this kind of wideband speech, so the bytes
/// dropped are ones the model discards anyway.
pub async fn extract_audio(
    app: &AppHandle,
    video_path: &str,
    output_path: &str,
) -> Result<(), String> {
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|err| format!("could not resolve ffmpeg sidecar: {err}"))?
        .args([
            "-i",
            video_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "libopus",
            "-b:a",
            "24k",
            "-y",
            output_path,
        ])
        .output()
        .await
        .map_err(|err| format!("ffmpeg failed to run: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg exited with an error: {}", stderr.trim()));
    }
    Ok(())
}

/// Sets `transcript_status = 'error'` on a video row after a failed
/// extraction attempt, so the UI can reflect it. Best-effort: if even this
/// update fails, the original error is still what's returned to the caller.
fn mark_error(conn: &DbConnection, video_id: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    guard
        .execute(
            "UPDATE videos SET transcript_status = 'error', updated_at = ?1 WHERE id = ?2",
            params![now, video_id],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

/// Probes a video's real duration and extracts (or reuses cached) mono
/// 16kHz audio for it, updating the row in place.
///
/// Cache behavior (PRD §7.4): if another video row already has this exact
/// `content_hash` with a non-null `audio_path` that still exists on disk,
/// extraction is skipped entirely and that cached duration/audio path are
/// copied onto this row instead — re-importing an unchanged file (even
/// under a different path) doesn't redo the ffmpeg work.
///
/// On any ffprobe/ffmpeg failure, sets `transcript_status = 'error'` on the
/// row and returns `Err` — never panics.
#[tauri::command(async)]
pub async fn extract_audio_for_video(
    app: AppHandle,
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
    attempt: u32,
) -> Result<Video, String> {
    let file_path = {
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        guard
            .query_row(
                "SELECT file_path FROM videos WHERE id = ?1",
                params![video_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => {
                    format!("video {video_id} does not exist")
                }
                other => other.to_string(),
            })?
    };

    match run_extraction(&app, &conn, &video_id, &file_path, attempt).await {
        Ok(video) => Ok(video),
        Err(message) => {
            // Best-effort status update; the extraction error is what the
            // caller sees either way.
            let _ = mark_error(&conn, &video_id);
            Err(message)
        }
    }
}

async fn run_extraction(
    app: &AppHandle,
    conn: &tauri::State<'_, DbConnection>,
    video_id: &str,
    file_path: &str,
    attempt: u32,
) -> Result<Video, String> {
    // Hashing a multi-gigabyte lecture file is I/O-bound and synchronous;
    // run it on a blocking-pool thread so it doesn't stall the async
    // runtime's worker threads while other commands are in flight.
    let file_path_owned = file_path.to_string();
    let hash = tokio::task::spawn_blocking(move || content_hash(&file_path_owned))
        .await
        .map_err(|err| format!("audio hashing task panicked: {err}"))??;

    let cached: Option<(String, Option<f64>)> = {
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        guard
            .query_row(
                "SELECT audio_path, duration FROM videos
                 WHERE content_hash = ?1 AND audio_path IS NOT NULL
                 LIMIT 1",
                params![hash],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<f64>>(1)?)),
            )
            .optional()
            .map_err(|err| err.to_string())?
    };

    let (audio_path, duration) = match cached {
        Some((audio_path, duration)) if Path::new(&audio_path).exists() => (audio_path, duration),
        _ => {
            let duration = probe_duration(app, file_path).await?;
            let dir = audio_cache_dir(app)?;
            // `.ogg` since `extract_audio` now emits Opus. Audio cached by an
            // older build is still `.wav` on disk and is still reused by the
            // lookup above — the transcribe path keys off the file's own bytes,
            // not this extension, so both coexist without a migration.
            let output_path = dir.join(format!("{hash}.ogg"));
            let output_path_str = output_path
                .to_str()
                .ok_or_else(|| "audio cache path is not valid UTF-8".to_string())?
                .to_string();
            // Indeterminate for this milestone — parsing ffmpeg's own
            // `-progress` output into a real fraction here is future work
            // (see `docs/ux-overhaul-plan.md`'s Phase 2).
            progress::emit(app, video_id, Stage::ExtractingAudio, None, None, attempt);
            extract_audio(app, file_path, &output_path_str).await?;
            (output_path_str, Some(duration))
        }
    };

    let now = chrono::Utc::now().to_rfc3339();
    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    guard
        .execute(
            "UPDATE videos
             SET duration = ?1, content_hash = ?2, audio_path = ?3,
                 transcript_status = 'audio_ready', updated_at = ?4
             WHERE id = ?5",
            params![duration, hash, audio_path, now, video_id],
        )
        .map_err(|err| err.to_string())?;

    guard
        .query_row(
            "SELECT id, project_id, file_path, duration, transcript_status, created_at, updated_at, audio_path, transcript_source
             FROM videos WHERE id = ?1",
            params![video_id],
            db::row_to_video,
        )
        .map_err(|err| err.to_string())
}

/// Cuts `[start_secs, start_secs + duration_secs)` from `audio_path` into a
/// single re-encoded Opus/Ogg temp file in the system temp dir, returning
/// its path. Shared by `split_audio_by_time` (called once per chunk when
/// first transcribing a long recording) and single-chunk re-transcription
/// (`openai::retranscribe_chunk`), so both cut audio identically — same
/// accurate-seek-plus-re-encode approach, same settings `extract_audio`
/// itself uses. See `split_audio_by_time`'s doc comment for why this
/// re-encodes rather than a fast `-c copy` stream-copy. Caller owns
/// deleting the returned temp file.
pub async fn cut_audio_range(
    app: &AppHandle,
    audio_path: &str,
    start_secs: f64,
    duration_secs: f64,
) -> Result<PathBuf, String> {
    let chunk_path = std::env::temp_dir().join(format!("coursecut-chunk-{}.ogg", uuid::Uuid::new_v4()));
    let chunk_path_str = chunk_path
        .to_str()
        .ok_or_else(|| "audio chunk path is not valid UTF-8".to_string())?
        .to_string();

    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|err| format!("could not resolve ffmpeg sidecar: {err}"))?
        .args([
            "-i",
            audio_path,
            "-ss",
            &start_secs.to_string(),
            "-t",
            &duration_secs.to_string(),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "libopus",
            "-b:a",
            "24k",
            "-y",
            &chunk_path_str,
        ])
        .output()
        .await
        .map_err(|err| format!("ffmpeg failed to run: {err}"))?;

    if !output.status.success() {
        // ffmpeg can write a partial file before exiting non-zero — clean it
        // up rather than leaking it into the OS temp dir.
        let _ = std::fs::remove_file(&chunk_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg exited with an error: {}", stderr.trim()));
    }

    Ok(chunk_path)
}

/// Cuts `[start_secs, start_secs + duration_secs)` from `source_path` (the
/// original source video, not the extracted Opus/Ogg cache) into a small
/// PCM WAV clip in `playback_cache_dir`, for local playback only — never
/// uploaded anywhere. WAV rather than `cut_audio_range`'s Opus/Ogg because
/// this clip has to play natively in the app's own webview, and some real
/// recordings have a container layout WebKit's demuxer is balky about
/// picking the right track from (or decoding at all) when handed
/// directly — observed cases: the audio track ordered before the video
/// track plus an extra unrecognized data track, and internally
/// inconsistent video color metadata that can make a strict hardware
/// decoder reject the whole file. A short, uncompressed, single-track WAV
/// sidesteps all of that: ffmpeg (which already handles this file fine
/// everywhere else in this app) does the real decoding, and the webview
/// only ever has to play a plain, universally-supported PCM file with
/// nothing else in the container to get confused by. Caller owns deleting
/// the returned clip file once done with it (see `delete_playback_clip`).
pub async fn extract_playback_clip(
    app: &AppHandle,
    source_path: &str,
    start_secs: f64,
    duration_secs: f64,
) -> Result<PathBuf, String> {
    let clip_path = playback_cache_dir(app)?.join(format!("{}.wav", uuid::Uuid::new_v4()));
    let clip_path_str = clip_path
        .to_str()
        .ok_or_else(|| "playback clip path is not valid UTF-8".to_string())?
        .to_string();

    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|err| format!("could not resolve ffmpeg sidecar: {err}"))?
        .args([
            "-i",
            source_path,
            "-ss",
            &start_secs.to_string(),
            "-t",
            &duration_secs.to_string(),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "44100",
            "-c:a",
            "pcm_s16le",
            "-y",
            &clip_path_str,
        ])
        .output()
        .await
        .map_err(|err| format!("ffmpeg failed to run: {err}"))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&clip_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg exited with an error: {}", stderr.trim()));
    }

    Ok(clip_path)
}

/// Reads `video_id`'s `file_path` and cuts `[start, end)` from it into a
/// playback-ready WAV clip via `extract_playback_clip`, returning the temp
/// clip's path as a string for the frontend to hand straight to
/// `convertFileSrc`. One clip per Play click (see `TranscriptStageView`'s
/// `handlePlaySegment`) — the frontend deletes the previous clip (via
/// `delete_playback_clip`) once a new one successfully starts playing, so
/// at most one stray clip can ever be left behind by an interrupted session.
#[tauri::command(async)]
pub async fn prepare_segment_playback_clip(
    app: AppHandle,
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
    start: f64,
    end: f64,
) -> Result<String, String> {
    let file_path = {
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        guard
            .query_row(
                "SELECT file_path FROM videos WHERE id = ?1",
                params![video_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => {
                    format!("video {video_id} does not exist")
                }
                other => other.to_string(),
            })?
    };

    let clip_path = extract_playback_clip(&app, &file_path, start, end - start).await?;
    clip_path
        .to_str()
        .map(|path| path.to_string())
        .ok_or_else(|| "playback clip path is not valid UTF-8".to_string())
}

/// Deletes a temp playback clip previously returned by
/// `prepare_segment_playback_clip`. Scoped to `playback_cache_dir` — refuses
/// to touch anything else, so this can't become a general-purpose
/// arbitrary file-delete primitive even though it's invoked with a
/// caller-supplied path. Best-effort: a missing/already-deleted file is
/// not an error.
#[tauri::command(async)]
pub fn delete_playback_clip(app: AppHandle, path: String) -> Result<(), String> {
    let candidate = Path::new(&path);
    let cache_dir = playback_cache_dir(&app)?;
    let is_own_clip = candidate.parent() == Some(cache_dir.as_path())
        && candidate
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("wav"));
    if !is_own_clip {
        return Err(format!("refusing to delete non-playback-clip path: {path}"));
    }
    match std::fs::remove_file(candidate) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

/// Minimum chunk length worth its own Whisper request. A trailing sliver
/// shorter than this (e.g. `total_duration_secs` landing just past an exact
/// multiple of a chunk length) is folded into silence rather than uploaded
/// as a near-empty final chunk. Shared (not just `split_audio_by_time`-local)
/// so `openai::retranscribe_chunk`'s chunk-existence check agrees exactly
/// with which chunks `split_audio_by_time` actually created — otherwise the
/// two could disagree for a duration landing in the last second before a
/// chunk boundary.
pub const MIN_TRAILING_CHUNK_SECS: f64 = 1.0;

/// Splits `audio_path` into sequential `chunk_secs`-long pieces via ffmpeg,
/// each written to its own Opus/Ogg temp file in the system temp dir (same
/// convention as `concat_videos`'s filelist). Returns each chunk's path
/// paired with its start offset (in seconds) into the original file, in
/// chunk order — the offset is needed by the caller to re-align each
/// chunk's Whisper-returned segment timestamps back onto the full
/// recording's timeline (see `openai.rs::merge_chunk_segments`).
///
/// Seeks with `-ss` *after* `-i` and re-encodes (`-c:a libopus`) rather
/// than a fast pre-`-i` stream-copy: a stream-copy cut can only land on the
/// nearest container page/packet boundary, which for Ogg/Opus can drift
/// the actual cut point by up to roughly a second from the requested
/// boundary — introducing timestamp drift and occasional duplicated words
/// at chunk seams once segments are offset and merged. Audio-only
/// re-encoding is cheap (unlike `export_lesson`'s video re-encode), so
/// trading a little CPU for sample-accurate boundaries is worth it here.
/// Re-encodes with the same settings `extract_audio` uses (mono/16kHz/
/// Opus@24k), so every chunk stays exactly as small/Whisper-compatible as
/// the original regardless of what `audio_path`'s own format is.
///
/// On any failure partway through, every chunk file already written by
/// this call is deleted (best-effort) before returning `Err` — callers
/// only ever receive paths for a fully successful split and never have to
/// reason about a partial one. The caller still owns deleting the
/// returned temp files once done with them.
pub async fn split_audio_by_time(
    app: &AppHandle,
    audio_path: &str,
    total_duration_secs: f64,
    chunk_secs: f64,
) -> Result<Vec<(PathBuf, f64)>, String> {
    let mut chunks: Vec<(PathBuf, f64)> = Vec::new();
    let mut start = 0.0_f64;
    while total_duration_secs - start >= MIN_TRAILING_CHUNK_SECS {
        match cut_audio_range(app, audio_path, start, chunk_secs).await {
            Ok(chunk_path) => chunks.push((chunk_path, start)),
            Err(err) => {
                for (existing_path, _) in &chunks {
                    let _ = std::fs::remove_file(existing_path);
                }
                return Err(err);
            }
        }
        start += chunk_secs;
    }

    Ok(chunks)
}

/// Trims `[start, end)` from `video_path` into a frame-accurate re-encoded
/// MP4 at `output_path` (PRD §10 export). Invocation, and why:
///
/// `-ss <start>` **before** `-i` for fast input seeking, then `-t
/// <end-start>` (a duration, not `-to`) **after** `-i` for the output
/// length. This was verified empirically against this ffmpeg build (not
/// assumed from memory): combining an input `-ss` with an output `-to`
/// does *not* treat `-to` as an absolute source timestamp here — it's
/// measured from the seek point, same as `-t` — so `-t <end-start>` is the
/// unambiguous choice for "encode exactly this many seconds starting at
/// the seek point", with no dependence on how a given ffmpeg build
/// happens to interpret `-to`. A byte-for-byte comparison (`framemd5`
/// checksums) confirmed `-ss <start> -i in -t <dur>` produces
/// frame-identical output to the slow-but-unambiguously-correct `-i in -ss
/// <start> -t <dur>` (post-input, always-accurate seeking) — i.e. the
/// fast-seek path here is not sacrificing frame accuracy.
///
/// Re-encodes with `libx264`/`aac` (broadly compatible, matches this
/// app's own bundled ffmpeg build) rather than `-c copy`: stream-copy can
/// only cut on keyframe boundaries, which would silently ignore the
/// user's exact trim points — this app already promises frame-accurate
/// trimming elsewhere, so the exported file must actually reflect them.
///
/// One still-image overlay to composite onto the segment being cut by
/// `export_lesson`, for `export.rs`'s `overlays_for_segment` to pass in.
/// `start`/`end` are already **segment-relative** seconds (0 = the start of
/// *this* cut, matching the ffmpeg output's own timestamp `t` once
/// `-ss`/`-t` have trimmed it) — not the video-scoped absolute seconds
/// `frame_overlays.start`/`.end` are stored as; translating between the two
/// is the caller's job, not this module's (see `overlays_for_segment`).
/// `scale_percent` is the image's size as a percentage of the main video's
/// own dimensions (100 = fills the frame, matching the original v1
/// behavior; below 100 shrinks the image toward the center, leaving the
/// underlying video visible around it — see `build_filter_complex`).
/// `x_percent`/`y_percent` place the (possibly shrunk) image within the
/// frame: 0 = its left/top edge at the frame's left/top edge, 100 = its
/// right/bottom edge at the frame's right/bottom edge, 50 = centered on
/// that axis — same 0-100 slider convention on both axes.
#[derive(Debug, Clone)]
pub struct SegmentOverlay {
    pub image_path: String,
    pub start: f64,
    pub end: f64,
    pub scale_percent: f64,
    pub x_percent: f64,
    pub y_percent: f64,
}

/// One `SegmentOverlay` with its `scale_percent`/`x_percent`/`y_percent`
/// already resolved into literal pixel values against the main video's and
/// the overlay image's *actual* probed dimensions (see
/// `resolve_segment_overlay` and `probe_dimensions`'s doc comment for why
/// this is done with real probes in Rust rather than ffmpeg filter
/// expressions). `width`/`height` preserve the image's own aspect ratio —
/// scaled down as needed so neither exceeds `scale_percent`% of the main
/// video's corresponding dimension (CSS `object-fit: contain`'s "fit
/// without stretching" behavior, computed here rather than via ffmpeg's
/// `force_original_aspect_ratio`) — and are always even (libx264/yuv420p
/// require even chroma-plane dimensions). `x`/`y` are the overlay's
/// top-left corner in the main frame's own pixel coordinates.
struct ResolvedOverlay {
    width: i64,
    height: i64,
    x: i64,
    y: i64,
    start: f64,
    end: f64,
}

/// Resolves one `SegmentOverlay`'s percentage-based size/position against
/// `main_w`/`main_h` (the segment being cut) and `image_w`/`image_h` (that
/// overlay's own probed pixel dimensions) into literal pixel values.
fn resolve_segment_overlay(
    overlay: &SegmentOverlay,
    main_w: u32,
    main_h: u32,
    image_w: u32,
    image_h: u32,
) -> ResolvedOverlay {
    let box_w = main_w as f64 * overlay.scale_percent / 100.0;
    let box_h = main_h as f64 * overlay.scale_percent / 100.0;
    // "decrease"/"contain": the smaller of the two candidate scale factors,
    // so the image shrinks to fit within the box on whichever axis is more
    // constraining, preserving its own aspect ratio on the other.
    let factor = (box_w / image_w as f64).min(box_h / image_h as f64);

    let round_even = |value: f64| -> i64 {
        let rounded = value.round() as i64;
        let rounded = rounded - (rounded % 2);
        rounded.max(2)
    };
    let width = round_even(image_w as f64 * factor);
    let height = round_even(image_h as f64 * factor);

    let x = ((main_w as f64 - width as f64) * overlay.x_percent / 100.0).round() as i64;
    let y = ((main_h as f64 - height as f64) * overlay.y_percent / 100.0).round() as i64;

    ResolvedOverlay {
        width,
        height,
        x,
        y,
        start: overlay.start,
        end: overlay.end,
    }
}

/// Which `lesson_regions.shape` a shape layer is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegionShape {
    Rect,
    /// Rectangle with corners rounded by `rounded_corner_radius`.
    Rounded,
    Ellipse,
}

/// How a shape layer is filled (`lesson_regions.fill`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegionFill {
    /// Box-blur what's underneath; strength is `SegmentRegion::blur_strength`.
    Blur,
    /// A solid `#rrggbb` colour.
    Solid(String),
}

/// One shape layer to apply to the cut being made, with `start`/`end`
/// already cut-relative (same convention as `SegmentOverlay`, translated by
/// `export.rs::regions_for_segment`). The rect is percent of the output
/// frame, top-left plus size.
#[derive(Debug, Clone)]
pub struct SegmentRegion {
    pub shape: RegionShape,
    pub fill: RegionFill,
    pub start: f64,
    pub end: f64,
    pub x_percent: f64,
    pub y_percent: f64,
    pub w_percent: f64,
    pub h_percent: f64,
    pub blur_strength: i64,
}

/// A `SegmentRegion` resolved to literal, even pixel values against the
/// main video's probed size (see `resolve_region`), plus boxblur radii
/// ffmpeg will accept for that rect (see `blur_radii`).
#[derive(Debug, Clone, PartialEq)]
struct ResolvedRegion {
    shape: RegionShape,
    fill: RegionFill,
    x: i64,
    y: i64,
    width: i64,
    height: i64,
    start: f64,
    end: f64,
    luma_radius: i64,
    chroma_radius: i64,
}

/// Smallest region side in pixels: keeps both boxblur radii >= 0.
const MIN_REGION_PX: i64 = 4;

/// Boxblur radii for a `width`x`height` rect. ffmpeg requires each plane's
/// radius to be at most half that plane's smaller side; the plan's cap of
/// `min(w,h)/2 - 1` covers the luma plane. With yuv420p the chroma planes
/// are half size and boxblur's chroma radius defaults to the luma one, so
/// that cap alone is rejected for big strengths on small rects ("Invalid
/// argument", verified against the bundled ffmpeg with `boxblur=49:2` on a
/// 100x100 rect). Chroma gets its own cap, `min(w,h)/4 - 1`.
fn blur_radii(width: i64, height: i64, strength: i64) -> (i64, i64) {
    let side = width.min(height);
    let luma = strength.min(side / 2 - 1).max(0);
    let chroma = luma.min(side / 4 - 1).max(0);
    (luma, chroma)
}

/// Corner radius of a `Rounded` shape: 20% of its shorter side. The preview
/// uses the same proportion (`RegionLayers.tsx`).
fn rounded_corner_radius(width: i64, height: i64) -> i64 {
    (width.min(height) / 5).max(1)
}

/// `geq` luma expression for a `width`x`height` alpha mask (255 inside the
/// shape, 0 outside), sampled at pixel centres. `None` for a plain rect,
/// which needs no mask. Literal numbers only, like every other value here.
fn shape_mask_expr(shape: RegionShape, width: i64, height: i64) -> Option<String> {
    match shape {
        RegionShape::Rect => None,
        RegionShape::Ellipse => {
            let (rx, ry) = (width as f64 / 2.0, height as f64 / 2.0);
            Some(format!(
                "255*lte(pow((X+0.5-{rx})/{rx},2)+pow((Y+0.5-{ry})/{ry},2),1)"
            ))
        }
        RegionShape::Rounded => {
            let r = rounded_corner_radius(width, height);
            // Distance past the inner (corner-centre) box on each axis; a
            // pixel is inside when that point is within `r` of the corner.
            Some(format!(
                "255*lte(pow(max(max({r}-X-0.5,X+0.5-{}),0),2)+pow(max(max({r}-Y-0.5,Y+0.5-{}),0),2),{})",
                width - r,
                height - r,
                r * r
            ))
        }
    }
}

/// Resolves a region's percentages against the main frame into even pixel
/// values that lie inside it.
fn resolve_region(region: &SegmentRegion, main_w: u32, main_h: u32) -> ResolvedRegion {
    let (main_w, main_h) = (main_w as i64, main_h as i64);
    let even = |value: i64| value & !1;
    let size = |percent: f64, main: i64| even((main as f64 * percent / 100.0).round() as i64).clamp(MIN_REGION_PX, even(main));
    let width = size(region.w_percent, main_w);
    let height = size(region.h_percent, main_h);
    let pos = |percent: f64, main: i64, size: i64| even((main as f64 * percent / 100.0).round() as i64).clamp(0, even(main - size));
    let x = pos(region.x_percent, main_w, width);
    let y = pos(region.y_percent, main_h, height);
    let (luma_radius, chroma_radius) = match region.fill {
        RegionFill::Blur => blur_radii(width, height, region.blur_strength),
        RegionFill::Solid(_) => (0, 0),
    };
    ResolvedRegion {
        shape: region.shape,
        fill: region.fill.clone(),
        x,
        y,
        width,
        height,
        start: region.start,
        end: region.end,
        luma_radius,
        chroma_radius,
    }
}

/// Builds the `-filter_complex` graph for `export_lesson`: **shapes → image
/// overlays**, every size and position a literal pixel value resolved in
/// Rust (see `resolve_region`/`resolve_segment_overlay`). The main video is
/// input `0`; overlay images are inputs `1..=overlays.len()`.
///
/// * blur shape: `[in]split[m][b];[b]crop=w:h:x:y,boxblur=...[bb]` (ffmpeg's
///   `crop` filter cuts out the patch to blur), then for rounded/ellipse
///   `[bb][mask]alphamerge`, then `[m][..]overlay=x:y:enable=...`
/// * solid shape: `color=c=0xRRGGBB:s=wxh` (`format=yuva420p` + alphamerge
///   with the mask for rounded/ellipse), overlaid onto `[in]` with enable.
///
/// The rounded/ellipse mask is a single generated grey frame (`color` →
/// `geq` → `loop=-1:size=1`), so `geq` runs once per export rather than
/// once per frame (about half the CPU of a per-frame `geq` alpha on the
/// same 20 s test, identical output).
///
/// Shapes are enabled on a half-open `[start, end)` window
/// (`gte(t,S)*lt(t,E)`), matching the preview, so a shape ending exactly
/// where a segment (or another shape) starts never covers the boundary
/// frame. With no shapes, the string is byte-identical to the original
/// overlay-only builder.
///
/// Image overlays: once every overlay's size/position has
/// already been resolved to literal pixels (see `ResolvedOverlay`). Each overlay image is its own extra
/// input (`-loop 1 -i <path>`, indices `1..=overlays.len()`, main video is
/// input `0`), scaled with a plain single-input `scale=W:H` (no reference
/// input, no `scale2ref`, no expression evaluation — `W`/`H` are the
/// already-computed literal pixel dimensions) and composited with a plain
/// `overlay=x=X:y=Y:enable='between(t,START,END)'` (again literal `X`/`Y`).
///
/// This is deliberately simpler than an earlier version that used
/// `scale2ref` + expression-based `main_w`/`main_h`/`force_original_aspect_ratio`
/// to resolve sizing dynamically inside the filter graph: that approach
/// turned out to silently produce wrong (non-aspect-preserving) dimensions
/// in this ffmpeg build once verified more rigorously via the CLI (a square
/// test image scaled into a non-square target box came out matching the
/// box's own un-aspected dimensions instead of the expected aspect-
/// preserved square) — several different expression formulations were
/// tried and each failed differently, which is itself a sign the approach
/// was fragile. Resolving everything to literals in Rust first (see
/// `resolve_segment_overlay`) sidesteps all of that, and also means each
/// image's `scale` filter has exactly one output — no reference pass-
/// through to chain or accidentally leave unmapped (the `nullsink`
/// duration bug from the `scale2ref` version doesn't exist here, since
/// there's no second output to consume in the first place).
///
/// Overlay-mode intro/outro slides (`slides`) come last, on top of
/// everything: each image is input `1 + overlays.len() + i`, scaled to fit
/// the frame, padded to it with black, and overlaid at 0:0 on a half-open
/// `[start, end)` window like the shapes. With no slides the string is
/// unchanged.
fn build_filter_complex(
    regions: &[ResolvedRegion],
    overlays: &[ResolvedOverlay],
    slides: &[ResolvedSlide],
) -> String {
    let total_stages = regions.len() + overlays.len() + slides.len();
    let mut stage = 0usize;
    // Output label of the stage about to be emitted: `outv` for the last
    // one, else `{prefix}{index}`.
    let mut next_label = |prefix: &str, index: usize| -> String {
        stage += 1;
        if stage == total_stages {
            "outv".to_string()
        } else {
            format!("{prefix}{index}")
        }
    };
    let mut parts: Vec<String> = Vec::new();
    let mut current = "0:v".to_string();

    for (index, overlay) in overlays.iter().enumerate() {
        let image_input = index + 1;
        parts.push(format!(
            "[{image_input}:v]scale={}:{}[scaled{index}]",
            overlay.width, overlay.height
        ));
    }

    // 1. Shapes, in the order given (start order, see `regions_for_segment`).
    for (index, region) in regions.iter().enumerate() {
        let (w, h) = (region.width, region.height);
        let mask = shape_mask_expr(region.shape, w, h).map(|expr| {
            format!("color=c=black:s={w}x{h}:d=1,format=gray,geq=lum='{expr}',loop=loop=-1:size=1[shk{index}]")
        });
        let out = next_label("sh", index);
        let enable = format!("enable='gte(t,{})*lt(t,{})'", region.start, region.end);
        match &region.fill {
            RegionFill::Blur => {
                parts.push(format!(
                    "[{current}]split[shm{index}][shc{index}];\
                     [shc{index}]crop={w}:{h}:{}:{},boxblur=luma_radius={}:luma_power=2:chroma_radius={}:chroma_power=2[shb{index}]",
                    region.x, region.y, region.luma_radius, region.chroma_radius
                ));
                let top = match &mask {
                    Some(mask) => {
                        parts.push(mask.clone());
                        parts.push(format!("[shb{index}][shk{index}]alphamerge[shf{index}]"));
                        format!("shf{index}")
                    }
                    None => format!("shb{index}"),
                };
                parts.push(format!(
                    "[shm{index}][{top}]overlay={}:{}:{enable}[{out}]",
                    region.x, region.y
                ));
            }
            RegionFill::Solid(color) => {
                let hex = color.trim_start_matches('#');
                let top = match &mask {
                    Some(mask) => {
                        parts.push(format!("color=c=0x{hex}:s={w}x{h},format=yuva420p[shc{index}]"));
                        parts.push(mask.clone());
                        parts.push(format!("[shc{index}][shk{index}]alphamerge[shf{index}]"));
                        format!("shf{index}")
                    }
                    None => {
                        parts.push(format!("color=c=0x{hex}:s={w}x{h}[shf{index}]"));
                        format!("shf{index}")
                    }
                };
                parts.push(format!(
                    "[{current}][{top}]overlay={}:{}:{enable}[{out}]",
                    region.x, region.y
                ));
            }
        }
        current = out;
    }

    // 2. The existing image overlays, on top of every shape.
    for (index, overlay) in overlays.iter().enumerate() {
        let out = next_label("ov", index);
        parts.push(format!(
            "[{current}][scaled{index}]overlay=x={}:y={}:enable='between(t,{},{})'[{out}]",
            overlay.x, overlay.y, overlay.start, overlay.end
        ));
        current = out;
    }

    // 3. Overlay-mode intro/outro slides, full-frame, on top of everything.
    for (index, slide) in slides.iter().enumerate() {
        let image_input = 1 + overlays.len() + index;
        parts.push(format!(
            "[{image_input}:v]scale={}:{},pad={}:{}:{}:{}:color=black,setsar=1[slide{index}]",
            slide.width, slide.height, slide.main_w, slide.main_h, slide.x, slide.y
        ));
        let out = next_label("sl", index);
        parts.push(format!(
            "[{current}][slide{index}]overlay=0:0:enable='gte(t,{})*lt(t,{})'[{out}]",
            slide.start, slide.end
        ));
        current = out;
    }

    parts.join(";")
}

/// An overlay-mode intro/outro slide to show full-frame over part of the
/// cut being made, `start`/`end` cut-relative (see
/// `export.rs::slides_for_segment`).
#[derive(Debug, Clone, PartialEq)]
pub struct SegmentSlide {
    pub image_path: String,
    pub start: f64,
    pub end: f64,
}

/// A `SegmentSlide` with the image's fit inside the `main_w`x`main_h` frame
/// resolved to literal, even pixels (see `fit_full_frame`).
#[derive(Debug, Clone, PartialEq)]
struct ResolvedSlide {
    width: i64,
    height: i64,
    x: i64,
    y: i64,
    main_w: u32,
    main_h: u32,
    start: f64,
    end: f64,
}

/// Size and top-left of an `image_w`x`image_h` image scaled to fit (CSS
/// `contain`) a `main_w`x`main_h` frame, centred. Same arithmetic as a 100%
/// centred image overlay.
pub(crate) fn fit_full_frame(main_w: u32, main_h: u32, image_w: u32, image_h: u32) -> (i64, i64, i64, i64) {
    let full = SegmentOverlay {
        image_path: String::new(),
        start: 0.0,
        end: 0.0,
        scale_percent: 100.0,
        x_percent: 50.0,
        y_percent: 50.0,
    };
    let fit = resolve_segment_overlay(&full, main_w, main_h, image_w, image_h);
    (fit.width, fit.height, fit.x, fit.y)
}

/// What a cut needs beyond overlays and regions, for intro/outro slides.
/// `Default` (all empty) leaves `lesson_cut_args` exactly as it was before
/// slides existed.
#[derive(Debug, Clone, Default)]
pub struct CutExtras {
    /// Overlay-mode slides over this cut.
    pub slides: Vec<SegmentSlide>,
    /// Cut-relative `[start, end)` windows to silence. Only set when the
    /// source has audio.
    pub mute_windows: Vec<(f64, f64)>,
    /// Set only when the export has an inserted slide: the explicit stream
    /// params every concat piece must share.
    pub stream: Option<StreamParams>,
    /// Map only the source's first audio track (`0:a:0?`), so the piece has
    /// at most one. Set for every lecture piece of an export with any slide:
    /// slide pieces carry one silent track, and a muted overlay filters one
    /// track, so all pieces then agree. Unset (all tracks, `0:a?`) otherwise,
    /// as before slides existed.
    pub single_audio: bool,
}

/// `[0:a:0]volume=0:enable=...[outa]` silencing the first audio track inside
/// the half-open `windows`, or `None` when there are none. Several windows
/// are summed into one `enable` expression. Only slides produce mute
/// windows, so the export maps just that track (`CutExtras::single_audio`).
fn mute_filter(windows: &[(f64, f64)]) -> Option<String> {
    if windows.is_empty() {
        return None;
    }
    let enable = windows
        .iter()
        .map(|(start, end)| format!("gte(t,{start})*lt(t,{end})"))
        .collect::<Vec<_>>()
        .join("+");
    Some(format!("[0:a:0]volume=0:enable='{enable}'[outa]"))
}

/// Output flags pinning the stream params every concat piece must share
/// (see `StreamParams`). Goes right after the codec flags.
fn stream_param_args(stream: &StreamParams) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-r".into(),
        stream.fps.clone(),
        "-video_track_timescale".into(),
        "90000".into(),
    ];
    if let Some(audio) = &stream.audio {
        args.extend([
            "-ar".into(),
            audio.sample_rate.to_string(),
            "-ac".into(),
            audio.channels.to_string(),
        ]);
    }
    args
}

/// Full ffmpeg arg list for an inserted intro/outro slide piece: the image
/// looped for `duration` seconds at the source's frame rate, fitted into
/// the `main_dims` frame (`fit` = `fit_full_frame`'s size and top-left) and
/// padded with black, its SAR set to the source's (see `StreamParams::sar`),
/// plus generated silence at the source's sample rate
/// and layout (no audio track when the source has none). Encoded with the
/// same codecs and `stream_param_args` as the lecture pieces it's
/// concatenated with.
pub(crate) fn slide_piece_args(
    image_path: &str,
    duration: f64,
    output_path: &str,
    fit: (i64, i64, i64, i64),
    main_dims: (u32, u32),
    stream: &StreamParams,
) -> Vec<String> {
    let (fit_w, fit_h, fit_x, fit_y) = fit;
    let (main_w, main_h) = main_dims;
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-loop".into(),
        "1".into(),
        "-framerate".into(),
        stream.fps.clone(),
        "-t".into(),
        duration.to_string(),
        "-i".into(),
        image_path.to_string(),
    ];
    if let Some(audio) = &stream.audio {
        args.extend([
            "-f".into(),
            "lavfi".into(),
            "-t".into(),
            duration.to_string(),
            "-i".into(),
            format!("anullsrc=r={}:cl={}", audio.sample_rate, audio.layout),
        ]);
    }
    // The image is RGB: convert with the source's own matrix and range, and
    // tag the frames with the source's colour properties, so libx264 writes
    // the same colour info into this piece's headers as the lecture's.
    // Each tag independently: a source tagged only `bt709` + `tv` must not
    // lose them (or fall back to swscale's BT.601 default matrix) just
    // because its primaries/transfer are unset.
    let mut scale = format!("scale={fit_w}:{fit_h}");
    let mut tags: Vec<String> = Vec::new();
    if let Some(space) = &stream.color_space {
        let matrix = match space.as_str() {
            "bt709" => Some("bt709"),
            "smpte170m" => Some("smpte170m"),
            "bt470bg" => Some("bt470"),
            "smpte240m" => Some("smpte240m"),
            "fcc" => Some("fcc"),
            "bt2020nc" => Some("bt2020"),
            _ => None,
        };
        if let Some(matrix) = matrix {
            scale.push_str(&format!(":out_color_matrix={matrix}"));
        }
        tags.push(format!("colorspace={space}"));
    }
    if let Some(primaries) = &stream.color_primaries {
        tags.push(format!("color_primaries={primaries}"));
    }
    if let Some(transfer) = &stream.color_transfer {
        tags.push(format!("color_trc={transfer}"));
    }
    if let Some(range) = &stream.color_range {
        scale.push_str(&format!(":out_range={range}"));
        tags.push(format!("range={range}"));
    }
    let sar = stream.sar.as_deref().unwrap_or("0");
    let mut chain = format!("{scale},pad={main_w}:{main_h}:{fit_x}:{fit_y}:color=black,setsar={sar},format=yuv420p");
    if !tags.is_empty() {
        chain.push_str(&format!(",setparams={}", tags.join(":")));
    }
    args.extend(["-vf".into(), chain, "-map".into(), "0:v:0".into()]);
    if stream.audio.is_some() {
        args.extend(["-map".into(), "1:a:0".into()]);
    }
    args.extend(["-c:v".into(), "libx264".into()]);
    if stream.audio.is_some() {
        args.extend(["-c:a".into(), "aac".into()]);
    }
    args.extend(stream_param_args(stream));
    args.extend([
        "-t".into(),
        duration.to_string(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.to_string(),
    ]);
    args
}

/// Full ffmpeg arg list for cutting `[start, end)` of `video_path` into
/// `output_path`, once every dimension the filter needs has been probed:
/// `main_dims` is the source video's size and `overlay_dims[i]` is
/// `overlays[i]`'s image size (both unused when there are no overlays and
/// no regions). Pure, so tests and the CLI verification helper produce
/// exactly the args `export_lesson` runs.
///
/// With no overlays and no regions this is exactly the original plain trim
/// invocation (see `export_lesson`'s doc for `-ss`/`-t` placement). With
/// any, it's the `-filter_complex` path; the output `-t` is what ends the
/// encode there, since the looped overlay images and the generated shape
/// colours/masks are infinite streams (verified: without `-t`, an
/// `overlay` with an endless second input never terminates).
///
/// `extras` (intro/outro slides) adds, only when non-empty: overlay-mode
/// slide images as inputs after the overlay images (`slide_dims[i]` is
/// `extras.slides[i]`'s image size) and as the last video stages; an
/// `[0:a:0]volume` mute mapped as `[outa]` instead of `0:a?`; only the first
/// audio track (`single_audio`); and, for an export with an inserted slide,
/// `stream_param_args` after the codecs.
/// With `CutExtras::default()` the args are exactly what they were before.
#[allow(clippy::too_many_arguments)]
pub(crate) fn lesson_cut_args(
    video_path: &str,
    start: f64,
    end: f64,
    output_path: &str,
    overlays: &[SegmentOverlay],
    overlay_dims: &[(u32, u32)],
    regions: &[SegmentRegion],
    main_dims: (u32, u32),
    extras: &CutExtras,
    slide_dims: &[(u32, u32)],
) -> Vec<String> {
    let duration = (end - start).max(0.0);
    let mut args: Vec<String> = vec![
        "-y".to_string(),
        "-ss".to_string(),
        start.to_string(),
        "-i".to_string(),
        video_path.to_string(),
    ];
    let has_video_graph = !overlays.is_empty() || !regions.is_empty() || !extras.slides.is_empty();
    let mute = mute_filter(&extras.mute_windows);
    if has_video_graph || mute.is_some() {
        let (main_w, main_h) = main_dims;
        let resolved: Vec<ResolvedOverlay> = overlays
            .iter()
            .zip(overlay_dims)
            .map(|(overlay, &(image_w, image_h))| resolve_segment_overlay(overlay, main_w, main_h, image_w, image_h))
            .collect();
        let resolved_regions: Vec<ResolvedRegion> = regions
            .iter()
            .map(|region| resolve_region(region, main_w, main_h))
            .collect();
        let resolved_slides: Vec<ResolvedSlide> = extras
            .slides
            .iter()
            .zip(slide_dims)
            .map(|(slide, &(image_w, image_h))| {
                let (width, height, x, y) = fit_full_frame(main_w, main_h, image_w, image_h);
                ResolvedSlide {
                    width,
                    height,
                    x,
                    y,
                    main_w,
                    main_h,
                    start: slide.start,
                    end: slide.end,
                }
            })
            .collect();
        for image_path in overlays
            .iter()
            .map(|overlay| &overlay.image_path)
            .chain(extras.slides.iter().map(|slide| &slide.image_path))
        {
            args.push("-loop".to_string());
            args.push("1".to_string());
            args.push("-i".to_string());
            args.push(image_path.clone());
        }
        let graph = [
            has_video_graph.then(|| build_filter_complex(&resolved_regions, &resolved, &resolved_slides)),
            mute.clone(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(";");
        args.push("-filter_complex".to_string());
        args.push(graph);
        args.push("-t".to_string());
        args.push(duration.to_string());
        args.push("-map".to_string());
        args.push(if has_video_graph { "[outv]" } else { "0:v:0" }.to_string());
        args.push("-map".to_string());
        let audio = match (&mute, extras.single_audio) {
            (Some(_), _) => "[outa]",
            (None, true) => "0:a:0?",
            (None, false) => "0:a?",
        };
        args.push(audio.to_string());
    } else {
        args.push("-t".to_string());
        args.push(duration.to_string());
        if extras.single_audio {
            args.extend(["-map", "0:v:0", "-map", "0:a:0?"].into_iter().map(str::to_string));
        }
    }
    args.extend(["-c:v", "libx264", "-c:a", "aac"].into_iter().map(str::to_string));
    match &extras.stream {
        Some(stream) => args.extend(stream_param_args(stream)),
        // Always 4:2:0. The pieces of one export are joined by stream copy,
        // and a piece that went through a filter (shape, overlay) comes out
        // yuv420p while an unfiltered one would keep a 4:4:4 or 4:2:2
        // source's format: a mixed file that players trusting its header
        // misdecode. 4:2:0 is also what every player supports.
        None => args.extend(["-pix_fmt", "yuv420p"].into_iter().map(str::to_string)),
    }
    args.extend(["-progress", "pipe:1", "-nostats", output_path].into_iter().map(str::to_string));
    args
}

/// Progress is streamed from ffmpeg's own `-progress pipe:1` output
/// (`out_time_ms=<microseconds>` lines — the key name is a long-standing
/// ffmpeg misnomer; verified empirically that the value is microseconds,
/// matching `out_time=HH:MM:SS.ffffff`) divided by the lesson's known
/// duration, reported via `on_progress` as a fraction in `[0, 1]`.
///
/// `register_child` is called exactly once, synchronously, right after
/// the ffmpeg process is spawned. The caller (the export worker in
/// `export.rs`) uses it to record the `CommandChild` handle somewhere
/// `cancel_export` can find and kill it — this function has no opinion on
/// cancellation itself. A killed process surfaces here as a non-zero (or
/// signal-terminated) exit, which the caller distinguishes from a "real"
/// failure by checking whether the export row was already marked
/// `cancelled` before treating this `Err` as a genuine failure.
#[allow(clippy::too_many_arguments)]
pub async fn export_lesson(
    app: &AppHandle,
    video_path: &str,
    start: f64,
    end: f64,
    output_path: &str,
    overlays: &[SegmentOverlay],
    regions: &[SegmentRegion],
    extras: &CutExtras,
    register_child: impl FnMut(CommandChild) + Send,
    on_progress: impl FnMut(f64) + Send,
) -> Result<(), String> {
    let duration = (end - start).max(0.0);

    // Probes only when there's a filter graph to size; the plain path stays
    // probe-free, exactly as before regions existed.
    let mut main_dims = (0, 0);
    let mut overlay_dims: Vec<(u32, u32)> = Vec::with_capacity(overlays.len());
    let mut slide_dims: Vec<(u32, u32)> = Vec::with_capacity(extras.slides.len());
    if !overlays.is_empty() || !regions.is_empty() || !extras.slides.is_empty() {
        main_dims = probe_dimensions(app, video_path).await?;
        for overlay in overlays {
            overlay_dims.push(probe_dimensions(app, &overlay.image_path).await?);
        }
        for slide in &extras.slides {
            slide_dims.push(probe_dimensions(app, &slide.image_path).await?);
        }
    }
    let args = lesson_cut_args(
        video_path,
        start,
        end,
        output_path,
        overlays,
        &overlay_dims,
        regions,
        main_dims,
        extras,
        &slide_dims,
    );
    run_ffmpeg_with_progress(app, args, duration, register_child, on_progress).await
}

/// Encodes an inserted intro/outro slide piece (`slide_piece_args`) to
/// `output_path`, `main_dims` being the lecture's frame size. Same
/// `register_child`/`on_progress` contract as `export_lesson`.
#[allow(clippy::too_many_arguments)]
pub async fn export_slide_piece(
    app: &AppHandle,
    image_path: &str,
    duration: f64,
    output_path: &str,
    main_dims: (u32, u32),
    stream: &StreamParams,
    register_child: impl FnMut(CommandChild) + Send,
    on_progress: impl FnMut(f64) + Send,
) -> Result<(), String> {
    let (image_w, image_h) = probe_dimensions(app, image_path).await?;
    let fit = fit_full_frame(main_dims.0, main_dims.1, image_w, image_h);
    let args = slide_piece_args(image_path, duration, output_path, fit, main_dims, stream);
    run_ffmpeg_with_progress(app, args, duration, register_child, on_progress).await
}

/// The final pass of an export with the AI voice (docs/hcm-improvements-plan.md
/// §4, V2): keeps `video_path`'s picture as is (stream copy) and replaces its
/// sound with `track_path`, the lesson's voice track. The track is on the
/// lesson's own timeline, so it's silenced inside `mute_windows` (muted
/// overlay slides, same timeline) and then delayed by `delay` seconds (an
/// inserted intro), then padded with silence and trimmed to `total` seconds,
/// the length of the whole export.
pub(crate) fn voice_mux_args(
    video_path: &str,
    track_path: &str,
    output_path: &str,
    delay: f64,
    mute_windows: &[(f64, f64)],
    total: f64,
) -> Vec<String> {
    let mut chain: Vec<String> = Vec::new();
    if !mute_windows.is_empty() {
        let enable = mute_windows
            .iter()
            .map(|(start, end)| format!("gte(t,{start})*lt(t,{end})"))
            .collect::<Vec<_>>()
            .join("+");
        chain.push(format!("volume=0:enable='{enable}'"));
    }
    if delay > 0.0 {
        chain.push(format!("adelay={}:all=1", (delay * 1000.0).round() as i64));
    }
    chain.push(format!("apad=whole_dur={total:.3}"));
    chain.push(format!("atrim=0:{total:.3}"));
    let filter = format!("[1:a]{}[voice]", chain.join(","));
    [
        "-y", "-i", video_path, "-i", track_path, "-filter_complex", &filter, "-map", "0:v:0", "-map", "[voice]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats", output_path,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// Runs `voice_mux_args`. Same `register_child`/`on_progress` contract as
/// `export_lesson`.
#[allow(clippy::too_many_arguments)]
pub async fn mux_voice_track(
    app: &AppHandle,
    video_path: &str,
    track_path: &str,
    output_path: &str,
    delay: f64,
    mute_windows: &[(f64, f64)],
    total: f64,
    register_child: impl FnMut(CommandChild) + Send,
    on_progress: impl FnMut(f64) + Send,
) -> Result<(), String> {
    let args = voice_mux_args(video_path, track_path, output_path, delay, mute_windows, total);
    run_ffmpeg_with_progress(app, args, total, register_child, on_progress).await
}

/// Spawns the ffmpeg sidecar with `args` (which must include `-progress
/// pipe:1`) and reports progress against `duration` seconds of output, as
/// described on `export_lesson`.
async fn run_ffmpeg_with_progress(
    app: &AppHandle,
    args: Vec<String>,
    duration: f64,
    mut register_child: impl FnMut(CommandChild) + Send,
    mut on_progress: impl FnMut(f64) + Send,
) -> Result<(), String> {
    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|err| format!("could not resolve ffmpeg sidecar: {err}"))?
        .args(args)
        .spawn()
        .map_err(|err| format!("could not spawn ffmpeg: {err}"))?;

    register_child(child);

    // Only report forward progress, and only on a real (>=0.5%) change, so
    // a fast export doesn't spam the caller (and, transitively, SQLite)
    // with dozens of near-identical writes per second.
    let mut last_reported = -1.0_f64;
    // ffmpeg logs its normal banner/warnings to stderr even on success;
    // keep only a bounded tail so a real failure's message is useful
    // without holding a whole long encode's log in memory.
    let mut stderr_tail = String::new();
    const MAX_STDERR_TAIL: usize = 4000;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let Ok(line) = String::from_utf8(bytes) else {
                    continue;
                };
                if let Some(value) = line.trim().strip_prefix("out_time_ms=") {
                    if let Ok(micros) = value.parse::<f64>() {
                        if duration > 0.0 {
                            let fraction = (micros / 1_000_000.0 / duration).clamp(0.0, 1.0);
                            if fraction > last_reported + 0.005 {
                                last_reported = fraction;
                                on_progress(fraction);
                            }
                        }
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                if let Ok(line) = String::from_utf8(bytes) {
                    stderr_tail.push_str(&line);
                    stderr_tail.push('\n');
                    if stderr_tail.len() > MAX_STDERR_TAIL {
                        let cut = stderr_tail.len() - MAX_STDERR_TAIL;
                        stderr_tail = stderr_tail[cut..].to_string();
                    }
                }
            }
            CommandEvent::Error(err) => {
                return Err(format!("ffmpeg process error: {err}"));
            }
            CommandEvent::Terminated(payload) => {
                if payload.code == Some(0) {
                    on_progress(1.0);
                    return Ok(());
                }
                return Err(format!(
                    "ffmpeg exited with code {:?} (signal {:?}): {}",
                    payload.code,
                    payload.signal,
                    stderr_tail.trim()
                ));
            }
            _ => {}
        }
    }

    Err("ffmpeg process ended without reporting a result".to_string())
}

/// Concatenates `input_paths`, in order, into `output_path` via ffmpeg's
/// concat demuxer with stream copy (`-f concat -safe 0 -i <list> -c copy`)
/// — safe here specifically because every input is expected to have just
/// been produced by `export_lesson` above with the same `libx264`/`aac`
/// settings, so no re-encode is needed to join them (re-encoding a
/// concatenation nobody asked for would be strictly worse: slower, and a
/// second lossy re-encode of already-encoded frames).
///
/// Used by `export.rs`'s multi-segment export path: each of a lesson's
/// segments is cut to its own temp file with `export_lesson`, then those
/// temp files are joined into the lesson's single output file here (PRD
/// decision: a multi-segment lesson exports as one concatenated video, not
/// one file per segment).
///
/// The concat demuxer reads its input list from a file, not CLI args, so
/// this writes one to the system temp dir first and removes it again once
/// ffmpeg exits, regardless of outcome.
///
/// `register_child` follows the same one-shot-after-spawn contract as
/// `export_lesson`'s: the caller uses it to record this `CommandChild` so
/// `cancel_export` can find and kill it if the user cancels mid-concat.
pub async fn concat_videos(
    app: &AppHandle,
    input_paths: &[String],
    output_path: &str,
    mut register_child: impl FnMut(CommandChild) + Send,
) -> Result<(), String> {
    let list_path = std::env::temp_dir().join(format!("coursecut-concat-{}.txt", uuid::Uuid::new_v4()));
    let mut list_contents = String::new();
    for path in input_paths {
        // The concat demuxer parses each `file` line as a single-quoted
        // string; escape any literal `'` in the path per its documented
        // convention (close the quote, escaped literal quote, reopen).
        let escaped = path.replace('\'', "'\\''");
        list_contents.push_str(&format!("file '{escaped}'\n"));
    }
    std::fs::write(&list_path, &list_contents)
        .map_err(|err| format!("could not write ffmpeg concat filelist: {err}"))?;

    let args: Vec<String> = vec![
        "-y".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        list_path.to_string_lossy().to_string(),
        "-c".to_string(),
        "copy".to_string(),
        output_path.to_string(),
    ];

    let spawn_result = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|err| format!("could not resolve ffmpeg sidecar: {err}"))
        .and_then(|cmd| {
            cmd.args(args)
                .spawn()
                .map_err(|err| format!("could not spawn ffmpeg: {err}"))
        });

    let (mut rx, child) = match spawn_result {
        Ok(pair) => pair,
        Err(err) => {
            let _ = std::fs::remove_file(&list_path);
            return Err(err);
        }
    };
    register_child(child);

    // Same bounded stderr-tail convention as `export_lesson`, for a useful
    // error message without holding a whole log in memory.
    let mut stderr_tail = String::new();
    const MAX_STDERR_TAIL: usize = 4000;

    let result = loop {
        match rx.recv().await {
            Some(CommandEvent::Stderr(bytes)) => {
                if let Ok(line) = String::from_utf8(bytes) {
                    stderr_tail.push_str(&line);
                    stderr_tail.push('\n');
                    if stderr_tail.len() > MAX_STDERR_TAIL {
                        let cut = stderr_tail.len() - MAX_STDERR_TAIL;
                        stderr_tail = stderr_tail[cut..].to_string();
                    }
                }
            }
            Some(CommandEvent::Error(err)) => {
                break Err(format!("ffmpeg process error: {err}"));
            }
            Some(CommandEvent::Terminated(payload)) => {
                if payload.code == Some(0) {
                    break Ok(());
                }
                break Err(format!(
                    "ffmpeg exited with code {:?} (signal {:?}): {}",
                    payload.code,
                    payload.signal,
                    stderr_tail.trim()
                ));
            }
            Some(_) => continue,
            None => break Err("ffmpeg process ended without reporting a result".to_string()),
        }
    };

    let _ = std::fs::remove_file(&list_path);
    result
}

#[cfg(test)]
mod voice_mux_tests {
    use super::*;

    #[test]
    fn plain_voice_is_padded_to_the_export() {
        let args = voice_mux_args("/v.mp4", "/t.wav", "/o.mp4", 0.0, &[], 12.0);
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert_eq!(filter, "[1:a]apad=whole_dur=12.000,atrim=0:12.000[voice]");
        assert!(args.windows(2).any(|w| w == ["-c:v", "copy"]));
        assert!(args.windows(2).any(|w| w == ["-map", "0:v:0"]));
        assert_eq!(args.last().unwrap(), "/o.mp4");
    }

    #[test]
    fn intro_delays_and_muted_slides_silence_the_voice() {
        let args = voice_mux_args("/v.mp4", "/t.wav", "/o.mp4", 3.0, &[(0.0, 2.0)], 15.0);
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert_eq!(
            filter,
            "[1:a]volume=0:enable='gte(t,0)*lt(t,2)',adelay=3000:all=1,apad=whole_dur=15.000,atrim=0:15.000[voice]"
        );
    }
}

#[cfg(test)]
mod resolve_segment_overlay_tests {
    use super::*;

    fn overlay(scale_percent: f64, x_percent: f64, y_percent: f64) -> SegmentOverlay {
        SegmentOverlay {
            image_path: "/tmp/one.png".to_string(),
            start: 1.0,
            end: 3.0,
            scale_percent,
            x_percent,
            y_percent,
        }
    }

    /// At 100% scale with a same-aspect image, the resolved size exactly
    /// matches the main frame and position is `(0,0)` regardless of
    /// x/y_percent (there's no room to move within the frame).
    #[test]
    fn full_frame_same_aspect_fills_exactly() {
        let resolved = resolve_segment_overlay(&overlay(100.0, 50.0, 50.0), 1440, 774, 1440, 774);
        assert_eq!(resolved.width, 1440);
        assert_eq!(resolved.height, 774);
        assert_eq!(resolved.x, 0);
        assert_eq!(resolved.y, 0);
    }

    /// The bug this whole module exists to avoid: a *square* image scaled
    /// into a *non-square* percentage box must come out square (aspect
    /// preserved, height-constrained here since the box is wider than
    /// tall), not stretched to the box's own un-aspected dimensions — this
    /// is exactly the case that silently broke under the old
    /// `scale2ref`+`force_original_aspect_ratio` approach, verified via the
    /// CLI against real ffmpeg.
    #[test]
    fn square_image_into_a_wide_box_stays_square_not_stretched() {
        // Main frame 1440x774, scale_percent 20 -> box 288x154.8. A square
        // 100x100 image's constraining dimension is height (154.8 < 288),
        // so factor = 154.8/100 = 1.548, giving ~155x155 (rounded to even).
        let resolved = resolve_segment_overlay(&overlay(20.0, 100.0, 0.0), 1440, 774, 100, 100);
        assert_eq!(resolved.width, resolved.height, "a square source must stay square");
        assert_eq!(resolved.width, 154);
        // x_percent 100 (right edge) -> x = (1440 - 154) * 1.0
        assert_eq!(resolved.x, 1440 - 154);
        // y_percent 0 (top edge) -> y = 0
        assert_eq!(resolved.y, 0);
    }

    /// A tall/narrow image into a box only constrains on the axis where it
    /// would otherwise overflow — width here, since the image is much
    /// narrower than the box relative to its own height.
    #[test]
    fn tall_image_is_width_constrained_and_centered() {
        // Half-frame box: 720x387. Image 100x300 (aspect 1:3). Width factor
        // 720/100=7.2, height factor 387/300=1.29 -> height-constrained
        // (smaller factor), giving 100*1.29=129 (rounded even), 300*1.29=387.
        let resolved = resolve_segment_overlay(&overlay(50.0, 50.0, 50.0), 1440, 774, 100, 300);
        assert_eq!(resolved.height, 386); // 387 rounded down to even
        assert_eq!(resolved.width, 128); // 129 rounded down to even (100 * 386/300)
        // Centered (50/50): x = (1440-128)/2, y = (774-386)/2
        assert_eq!(resolved.x, (1440 - 128) / 2);
        assert_eq!(resolved.y, (774 - 386) / 2);
    }

    #[test]
    fn resolved_dimensions_are_always_even() {
        // An odd-dimensioned image scaled by an awkward factor shouldn't
        // produce odd output dims (libx264/yuv420p need even chroma
        // planes).
        let resolved = resolve_segment_overlay(&overlay(33.0, 50.0, 50.0), 1441, 775, 101, 101);
        assert_eq!(resolved.width % 2, 0);
        assert_eq!(resolved.height % 2, 0);
    }
}

#[cfg(test)]
mod overlay_filter_tests {
    use super::*;

    fn resolved(width: i64, height: i64, x: i64, y: i64, start: f64, end: f64) -> ResolvedOverlay {
        ResolvedOverlay { width, height, x, y, start, end }
    }

    /// Exact string manually validated end-to-end against the system
    /// ffmpeg — a plain single-input `scale=W:H` per overlay image (no
    /// reference input, unlike the earlier `scale2ref`-based version), then
    /// a plain `overlay=x=X:y=Y` with literal pixel values.
    #[test]
    fn single_overlay_builds_a_scale_and_overlay_graph() {
        let overlays = [resolved(1440, 774, 0, 0, 1.0, 3.0)];
        let graph = build_filter_complex(&[], &overlays, &[]);
        assert_eq!(
            graph,
            "[1:v]scale=1440:774[scaled0];\
             [0:v][scaled0]overlay=x=0:y=0:enable='between(t,1,3)'[outv]"
        );
    }

    /// A shrunk, off-center overlay uses its own resolved width/height/x/y
    /// — no fractions or expressions left in the filter string at all.
    #[test]
    fn shrunk_overlay_uses_its_resolved_pixel_box() {
        let overlays = [resolved(154, 154, 1286, 0, 1.0, 3.0)];
        let graph = build_filter_complex(&[], &overlays, &[]);
        assert_eq!(
            graph,
            "[1:v]scale=154:154[scaled0];\
             [0:v][scaled0]overlay=x=1286:y=0:enable='between(t,1,3)'[outv]"
        );
    }

    /// Multi-overlay case: each image gets its own independent `scale`
    /// filter (no chaining needed, unlike the old `scale2ref` version,
    /// since a plain `scale` filter has exactly one output — nothing to
    /// leave unmapped), and `overlay` calls chain in order, the first onto
    /// the main video (`0:v`), each next onto the previous one's output.
    #[test]
    fn two_overlays_each_get_their_own_scale_and_chain_overlay_bases() {
        let overlays = [resolved(1440, 774, 0, 0, 1.0, 2.0), resolved(200, 100, 50, 50, 3.0, 4.0)];
        let graph = build_filter_complex(&[], &overlays, &[]);
        assert_eq!(
            graph,
            "[1:v]scale=1440:774[scaled0];\
             [2:v]scale=200:100[scaled1];\
             [0:v][scaled0]overlay=x=0:y=0:enable='between(t,1,2)'[ov0];\
             [ov0][scaled1]overlay=x=50:y=50:enable='between(t,3,4)'[outv]"
        );
    }
}


#[cfg(test)]
mod region_filter_tests {
    use super::*;

    fn region(shape: RegionShape, fill: RegionFill, x: f64, y: f64, w: f64, h: f64, strength: i64) -> SegmentRegion {
        SegmentRegion {
            shape,
            fill,
            start: 1.0,
            end: 3.5,
            x_percent: x,
            y_percent: y,
            w_percent: w,
            h_percent: h,
            blur_strength: strength,
        }
    }

    #[test]
    fn resolved_regions_are_even_and_inside_the_frame() {
        // Odd main dims and awkward percentages.
        for fill in [RegionFill::Blur, RegionFill::Solid("#000000".into())] {
            let resolved = resolve_region(&region(RegionShape::Rect, fill, 33.3, 47.1, 41.7, 38.3, 20), 1441, 775);
            for value in [resolved.x, resolved.y, resolved.width, resolved.height] {
                assert_eq!(value % 2, 0, "{resolved:?}");
            }
            assert!(resolved.x + resolved.width <= 1441);
            assert!(resolved.y + resolved.height <= 775);
        }
        // A rect touching the right/bottom edge is pulled back inside.
        let edge = resolve_region(&region(RegionShape::Rect, RegionFill::Blur, 99.9, 99.9, 50.0, 50.0, 5), 1440, 774);
        assert_eq!(edge.x + edge.width, 1440);
        assert_eq!(edge.y + edge.height, 774);
    }

    #[test]
    fn width_and_height_resolve_independently() {
        let resolved = resolve_region(&region(RegionShape::Rect, RegionFill::Blur, 25.0, 25.0, 50.0, 20.0, 5), 1440, 774);
        assert_eq!((resolved.width, resolved.height, resolved.x, resolved.y), (720, 154, 360, 194));
    }

    #[test]
    fn blur_radius_is_capped_per_plane() {
        // Luma at min(w,h)/2 - 1, chroma at min(w,h)/4 - 1.
        assert_eq!(blur_radii(100, 300, 80), (49, 24));
        // A strength under both caps is used as-is for both planes.
        assert_eq!(blur_radii(400, 300, 20), (20, 20));
        // Tiny rects never go negative.
        assert_eq!(blur_radii(4, 4, 50), (1, 0));
        let resolved = resolve_region(&region(RegionShape::Ellipse, RegionFill::Blur, 0.0, 0.0, 100.0 * 100.0 / 1440.0, 50.0, 80), 1440, 774);
        assert_eq!((resolved.width, resolved.luma_radius, resolved.chroma_radius), (100, 49, 24));
        // Solid fills don't blur.
        let solid = resolve_region(&region(RegionShape::Rect, RegionFill::Solid("#000000".into()), 0.0, 0.0, 50.0, 50.0, 80), 1440, 774);
        assert_eq!((solid.luma_radius, solid.chroma_radius), (0, 0));
    }

    #[test]
    fn blurred_rect_has_no_mask() {
        let blur = resolve_region(&region(RegionShape::Rect, RegionFill::Blur, 10.0, 10.0, 20.0, 20.0, 30), 1000, 500);
        assert_eq!(
            build_filter_complex(&[blur], &[], &[]),
            "[0:v]split[shm0][shc0];\
             [shc0]crop=200:100:100:50,boxblur=luma_radius=30:luma_power=2:chroma_radius=24:chroma_power=2[shb0];\
             [shm0][shb0]overlay=100:50:enable='gte(t,1)*lt(t,3.5)'[outv]"
        );
    }

    #[test]
    fn blurred_ellipse_is_alpha_masked() {
        let blur = resolve_region(&region(RegionShape::Ellipse, RegionFill::Blur, 10.0, 10.0, 20.0, 20.0, 10), 1000, 500);
        assert_eq!(
            build_filter_complex(&[blur], &[], &[]),
            "[0:v]split[shm0][shc0];\
             [shc0]crop=200:100:100:50,boxblur=luma_radius=10:luma_power=2:chroma_radius=10:chroma_power=2[shb0];\
             color=c=black:s=200x100:d=1,format=gray,geq=lum='255*lte(pow((X+0.5-100)/100,2)+pow((Y+0.5-50)/50,2),1)',loop=loop=-1:size=1[shk0];\
             [shb0][shk0]alphamerge[shf0];\
             [shm0][shf0]overlay=100:50:enable='gte(t,1)*lt(t,3.5)'[outv]"
        );
    }

    #[test]
    fn solid_rect_is_a_plain_colour_source_and_rounded_is_masked() {
        let rect = resolve_region(&region(RegionShape::Rect, RegionFill::Solid("#1a2B3c".into()), 10.0, 10.0, 20.0, 20.0, 10), 1000, 500);
        assert_eq!(
            build_filter_complex(&[rect], &[], &[]),
            "color=c=0x1a2B3c:s=200x100[shf0];\
             [0:v][shf0]overlay=100:50:enable='gte(t,1)*lt(t,3.5)'[outv]"
        );
        let rounded = resolve_region(&region(RegionShape::Rounded, RegionFill::Solid("#000000".into()), 10.0, 10.0, 20.0, 20.0, 10), 1000, 500);
        // Corner radius = 20% of the shorter side (100) = 20.
        assert_eq!(
            build_filter_complex(&[rounded], &[], &[]),
            "color=c=0x000000:s=200x100,format=yuva420p[shc0];\
             color=c=black:s=200x100:d=1,format=gray,geq=lum='255*lte(pow(max(max(20-X-0.5,X+0.5-180),0),2)+pow(max(max(20-Y-0.5,Y+0.5-80),0),2),400)',loop=loop=-1:size=1[shk0];\
             [shc0][shk0]alphamerge[shf0];\
             [0:v][shf0]overlay=100:50:enable='gte(t,1)*lt(t,3.5)'[outv]"
        );
    }

    /// Shapes chain in the order given, then image overlays go on top.
    #[test]
    fn chain_order_is_shapes_then_overlays() {
        let solid = resolve_region(&region(RegionShape::Rect, RegionFill::Solid("#ffffff".into()), 0.0, 0.0, 10.0, 10.0, 10), 1000, 500);
        let blur = resolve_region(&region(RegionShape::Rect, RegionFill::Blur, 50.0, 50.0, 20.0, 20.0, 10), 1000, 500);
        let overlay = ResolvedOverlay { width: 100, height: 100, x: 0, y: 0, start: 2.0, end: 3.0 };
        let graph = build_filter_complex(&[solid, blur], &[overlay], &[]);
        assert_eq!(
            graph,
            "[1:v]scale=100:100[scaled0];\
             color=c=0xffffff:s=100x50[shf0];\
             [0:v][shf0]overlay=0:0:enable='gte(t,1)*lt(t,3.5)'[sh0];\
             [sh0]split[shm1][shc1];\
             [shc1]crop=200:100:500:250,boxblur=luma_radius=10:luma_power=2:chroma_radius=10:chroma_power=2[shb1];\
             [shm1][shb1]overlay=500:250:enable='gte(t,1)*lt(t,3.5)'[sh1];\
             [sh1][scaled0]overlay=x=0:y=0:enable='between(t,2,3)'[outv]"
        );
    }

    #[test]
    fn plain_path_is_unchanged_without_regions_or_overlays() {
        let args = lesson_cut_args("/in.mp4", 5.0, 12.5, "/out.mp4", &[], &[], &[], (0, 0), &CutExtras::default(), &[]);
        assert_eq!(
            args,
            [
                "-y", "-ss", "5", "-i", "/in.mp4", "-t", "7.5", "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", "-progress",
                "pipe:1", "-nostats", "/out.mp4"
            ]
        );
    }

    #[test]
    fn regions_alone_switch_to_the_filter_path() {
        let blur = region(RegionShape::Rect, RegionFill::Blur, 0.0, 0.0, 50.0, 50.0, 10);
        let args = lesson_cut_args("/in.mp4", 5.0, 12.5, "/out.mp4", &[], &[], &[blur], (1000, 500), &CutExtras::default(), &[]);
        let filter_at = args.iter().position(|arg| arg == "-filter_complex").unwrap();
        assert!(args[filter_at + 1].starts_with("[0:v]split[shm0][shc0]"));
        assert!(args.windows(2).any(|pair| pair == ["-map", "[outv]"]));
        assert!(args.windows(2).any(|pair| pair == ["-map", "0:a?"]));
        assert!(args.windows(2).any(|pair| pair == ["-t", "7.5"]));
        assert!(!args.iter().any(|arg| arg == "-loop"));
    }
}

#[cfg(test)]
mod slide_tests {
    use super::*;

    fn stream(audio: bool) -> StreamParams {
        StreamParams {
            fps: "25/1".into(),
            audio: audio.then(|| AudioParams {
                sample_rate: 48000,
                channels: 2,
                layout: "stereo".into(),
            }),
            color_space: Some("bt709".into()),
            color_primaries: Some("bt709".into()),
            color_transfer: Some("bt709".into()),
            color_range: Some("tv".into()),
            sar: None,
        }
    }

    #[test]
    fn stream_params_are_parsed_from_ffprobe_json() {
        let json = r#"{"streams":[
            {"codec_type":"video","r_frame_rate":"25/1","avg_frame_rate":"25/1","sample_aspect_ratio":"0:1","color_space":"bt709",
             "color_primaries":"bt709","color_transfer":"bt709","color_range":"tv"},
            {"codec_type":"audio","sample_rate":"48000","channels":2,"channel_layout":"stereo"}]}"#;
        assert_eq!(parse_stream_params(json).unwrap(), stream(true));

        // No audio, untagged colour, a timebase-sized r_frame_rate.
        let json = r#"{"streams":[{"codec_type":"video","r_frame_rate":"90000/1","avg_frame_rate":"30000/1001",
            "color_space":"unknown","sample_aspect_ratio":"4:3"}]}"#;
        let parsed = parse_stream_params(json).unwrap();
        assert_eq!(parsed.fps, "30000/1001");
        assert_eq!(parsed.sar.as_deref(), Some("4/3"));
        assert_eq!(parsed.audio, None);
        assert_eq!(
            (parsed.color_space, parsed.color_primaries, parsed.color_transfer, parsed.color_range),
            (None, None, None, None)
        );

        // Mono with no layout name falls back to one from the channel count.
        let json = r#"{"streams":[{"codec_type":"video","r_frame_rate":"0/0"},
            {"codec_type":"audio","sample_rate":"44100","channels":1}]}"#;
        let parsed = parse_stream_params(json).unwrap();
        assert_eq!(parsed.fps, "30");
        assert_eq!(parsed.audio.unwrap().layout, "mono");

        assert!(parse_stream_params(r#"{"streams":[{"codec_type":"audio"}]}"#).is_err());
    }

    #[test]
    fn mute_filter_string() {
        assert_eq!(mute_filter(&[]), None);
        assert_eq!(
            mute_filter(&[(0.0, 4.5)]).unwrap(),
            "[0:a:0]volume=0:enable='gte(t,0)*lt(t,4.5)'[outa]"
        );
        assert_eq!(
            mute_filter(&[(0.0, 2.0), (8.0, 10.0)]).unwrap(),
            "[0:a:0]volume=0:enable='gte(t,0)*lt(t,2)+gte(t,8)*lt(t,10)'[outa]"
        );
    }

    fn slide(start: f64, end: f64) -> SegmentSlide {
        SegmentSlide {
            image_path: "/cache/slides/intro.png".into(),
            start,
            end,
        }
    }

    /// An overlay-mode slide goes after shapes and image overlays, as its
    /// own input after the overlay images, letterboxed to the frame.
    #[test]
    fn overlay_slide_is_the_top_layer() {
        let region = SegmentRegion {
            shape: RegionShape::Rect,
            fill: RegionFill::Solid("#000000".into()),
            start: 1.0,
            end: 2.0,
            x_percent: 0.0,
            y_percent: 0.0,
            w_percent: 10.0,
            h_percent: 10.0,
            blur_strength: 10,
        };
        let overlay = SegmentOverlay {
            image_path: "/img/logo.png".into(),
            start: 1.0,
            end: 3.0,
            scale_percent: 10.0,
            x_percent: 100.0,
            y_percent: 0.0,
        };
        let extras = CutExtras { slides: vec![slide(0.0, 4.0)], ..CutExtras::default() };
        // A 4:3 image into a 1000x500 frame: 666x500 (even), centred.
        let args = lesson_cut_args(
            "/in.mp4",
            5.0,
            12.5,
            "/out.mp4",
            &[overlay],
            &[(100, 100)],
            &[region],
            (1000, 500),
            &extras,
            &[(800, 600)],
        );
        assert_eq!(
            args,
            [
                "-y",
                "-ss",
                "5",
                "-i",
                "/in.mp4",
                "-loop",
                "1",
                "-i",
                "/img/logo.png",
                "-loop",
                "1",
                "-i",
                "/cache/slides/intro.png",
                "-filter_complex",
                "[1:v]scale=50:50[scaled0];\
                 color=c=0x000000:s=100x50[shf0];\
                 [0:v][shf0]overlay=0:0:enable='gte(t,1)*lt(t,2)'[sh0];\
                 [sh0][scaled0]overlay=x=950:y=0:enable='between(t,1,3)'[ov0];\
                 [2:v]scale=666:500,pad=1000:500:167:0:color=black,setsar=1[slide0];\
                 [ov0][slide0]overlay=0:0:enable='gte(t,0)*lt(t,4)'[outv]",
                "-t",
                "7.5",
                "-map",
                "[outv]",
                "-map",
                "0:a?",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                "-pix_fmt", "yuv420p",
                "-progress",
                "pipe:1",
                "-nostats",
                "/out.mp4"
            ]
        );
    }

    /// Mute adds an audio chain and maps `[outa]`; the video graph is the
    /// same string with or without it.
    #[test]
    fn mute_maps_the_filtered_audio_and_leaves_the_video_graph_alone() {
        let without = CutExtras { slides: vec![slide(0.0, 4.0)], ..CutExtras::default() };
        let with = CutExtras { mute_windows: vec![(0.0, 4.0)], ..without.clone() };
        let run = |extras: &CutExtras| {
            lesson_cut_args("/in.mp4", 0.0, 10.0, "/out.mp4", &[], &[], &[], (1440, 774), extras, &[(1440, 774)])
        };
        let (plain, muted) = (run(&without), run(&with));
        let graph = |args: &[String]| args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1].clone();
        assert_eq!(
            graph(&plain),
            "[1:v]scale=1440:774,pad=1440:774:0:0:color=black,setsar=1[slide0];\
             [0:v][slide0]overlay=0:0:enable='gte(t,0)*lt(t,4)'[outv]"
        );
        assert_eq!(
            graph(&muted),
            format!("{};[0:a:0]volume=0:enable='gte(t,0)*lt(t,4)'[outa]", graph(&plain))
        );
        assert!(plain.windows(2).any(|pair| pair == ["-map", "0:a?"]));
        assert!(muted.windows(2).any(|pair| pair == ["-map", "[outa]"]));
        assert!(!muted.iter().any(|arg| arg == "0:a?"));
        // Everything else is identical.
        let normalized = |args: &[String]| -> Vec<String> {
            args.iter()
                .map(|arg| match arg.as_str() {
                    "0:a?" | "[outa]" => "AUDIO".to_string(),
                    other if other.starts_with("[1:v]") => "GRAPH".to_string(),
                    other => other.to_string(),
                })
                .collect()
        };
        assert_eq!(normalized(&plain), normalized(&muted));
    }

    /// A lecture piece of an export with an inserted slide pins the stream
    /// params after the codecs; nothing else changes.
    #[test]
    fn lecture_piece_gets_stream_params_only_when_asked() {
        let extras = CutExtras { stream: Some(stream(true)), ..CutExtras::default() };
        let args = lesson_cut_args("/in.mp4", 5.0, 12.5, "/out.mp4", &[], &[], &[], (0, 0), &extras, &[]);
        assert_eq!(
            args,
            [
                "-y", "-ss", "5", "-i", "/in.mp4", "-t", "7.5", "-c:v", "libx264", "-c:a", "aac", "-pix_fmt",
                "yuv420p", "-r", "25/1", "-video_track_timescale", "90000", "-ar", "48000", "-ac", "2", "-progress",
                "pipe:1", "-nostats", "/out.mp4"
            ]
        );
        let extras = CutExtras { stream: Some(stream(false)), ..CutExtras::default() };
        let args = lesson_cut_args("/in.mp4", 5.0, 12.5, "/out.mp4", &[], &[], &[], (0, 0), &extras, &[]);
        assert!(!args.iter().any(|arg| arg == "-ar" || arg == "-ac"));
        assert!(args.windows(2).any(|pair| pair == ["-video_track_timescale", "90000"]));
    }

    #[test]
    fn slide_piece_args_match_the_lecture_stream() {
        let fit = fit_full_frame(1440, 774, 1920, 1080);
        assert_eq!(fit, (1376, 774, 32, 0));
        let args = slide_piece_args("/img/intro.png", 3.0, "/tmp/intro.mp4", fit, (1440, 774), &stream(true));
        assert_eq!(
            args,
            [
                "-y",
                "-loop",
                "1",
                "-framerate",
                "25/1",
                "-t",
                "3",
                "-i",
                "/img/intro.png",
                "-f",
                "lavfi",
                "-t",
                "3",
                "-i",
                "anullsrc=r=48000:cl=stereo",
                "-vf",
                "scale=1376:774:out_color_matrix=bt709:out_range=tv,pad=1440:774:32:0:color=black,setsar=0,format=yuv420p,\
                 setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                "-pix_fmt",
                "yuv420p",
                "-r",
                "25/1",
                "-video_track_timescale",
                "90000",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-t",
                "3",
                "-progress",
                "pipe:1",
                "-nostats",
                "/tmp/intro.mp4"
            ]
        );
    }

    /// A source tagged only `bt709` + `tv` (primaries and transfer unset):
    /// the slide converts with BT.709 and carries exactly those two tags.
    #[test]
    fn partially_tagged_colour_is_handled_per_tag() {
        let json = r#"{"streams":[{"codec_type":"video","r_frame_rate":"30/1","color_range":"tv",
            "color_space":"bt709","color_transfer":"unknown","color_primaries":"unknown","sample_aspect_ratio":"1:1"},
            {"codec_type":"audio","sample_rate":"48000","channels":2,"channel_layout":"stereo"}]}"#;
        let parsed = parse_stream_params(json).unwrap();
        assert_eq!(
            (
                parsed.color_space.as_deref(),
                parsed.color_primaries.as_deref(),
                parsed.color_transfer.as_deref(),
                parsed.color_range.as_deref()
            ),
            (Some("bt709"), None, None, Some("tv"))
        );
        let args = slide_piece_args("/img/intro.png", 2.0, "/tmp/intro.mp4", (640, 360, 0, 0), (640, 360), &parsed);
        let vf = &args[args.iter().position(|arg| arg == "-vf").unwrap() + 1];
        assert_eq!(
            vf,
            "scale=640:360:out_color_matrix=bt709:out_range=tv,pad=640:360:0:0:color=black,setsar=1/1,format=yuv420p,\
             setparams=colorspace=bt709:range=tv"
        );

        // Primaries only: no matrix to convert with, and just that one tag.
        let primaries_only = StreamParams {
            color_space: None,
            color_transfer: None,
            color_range: None,
            ..stream(false)
        };
        let args = slide_piece_args("/i.png", 2.0, "/o.mp4", (1440, 774, 0, 0), (1440, 774), &primaries_only);
        let vf = &args[args.iter().position(|arg| arg == "-vf").unwrap() + 1];
        assert!(vf.starts_with("scale=1440:774,pad="), "{vf}");
        assert!(vf.ends_with(",setparams=color_primaries=bt709"), "{vf}");
    }

    /// With any slide in the export, every lecture piece maps exactly one
    /// audio track, whichever path it takes; without, `0:a?` as before.
    #[test]
    fn single_audio_maps_only_the_first_track() {
        let single = CutExtras { single_audio: true, ..CutExtras::default() };
        let plain = lesson_cut_args("/in.mp4", 5.0, 12.5, "/out.mp4", &[], &[], &[], (0, 0), &single, &[]);
        assert_eq!(
            plain,
            [
                "-y", "-ss", "5", "-i", "/in.mp4", "-t", "7.5", "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264",
                "-c:a", "aac", "-pix_fmt", "yuv420p", "-progress", "pipe:1", "-nostats", "/out.mp4"
            ]
        );

        let overlay = CutExtras { slides: vec![slide(0.0, 4.0)], single_audio: true, ..CutExtras::default() };
        let filtered =
            lesson_cut_args("/in.mp4", 0.0, 10.0, "/out.mp4", &[], &[], &[], (1440, 774), &overlay, &[(1440, 774)]);
        assert!(filtered.windows(2).any(|pair| pair == ["-map", "0:a:0?"]));
        assert!(!filtered.iter().any(|arg| arg == "0:a?"));

        let muted = CutExtras { mute_windows: vec![(0.0, 4.0)], ..overlay };
        let muted = lesson_cut_args("/in.mp4", 0.0, 10.0, "/out.mp4", &[], &[], &[], (1440, 774), &muted, &[(1440, 774)]);
        assert!(muted.iter().any(|arg| arg.ends_with(";[0:a:0]volume=0:enable='gte(t,0)*lt(t,4)'[outa]")));
        assert_eq!(muted.iter().filter(|arg| *arg == "-map").count(), 2);
        assert!(muted.windows(2).any(|pair| pair == ["-map", "[outa]"]));

        assert!(!CutExtras::default().single_audio, "no-slide exports keep every track");
    }

    #[test]
    fn slide_piece_without_source_audio_is_video_only() {
        let plain = StreamParams {
            color_space: None,
            color_primaries: None,
            color_transfer: None,
            color_range: None,
            sar: Some("1/1".into()),
            ..stream(false)
        };
        let args = slide_piece_args("/img/intro.png", 2.5, "/tmp/intro.mp4", (1440, 774, 0, 0), (1440, 774), &plain);
        assert!(!args.iter().any(|arg| arg.starts_with("anullsrc") || arg == "lavfi" || arg == "-c:a" || arg == "1:a:0"));
        assert!(args.windows(2).any(|pair| pair == ["-vf", "scale=1440:774,pad=1440:774:0:0:color=black,setsar=1/1,format=yuv420p"]));
        assert!(args.windows(2).any(|pair| pair == ["-map", "0:v:0"]));
    }
}
