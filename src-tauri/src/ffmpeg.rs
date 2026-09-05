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
            "SELECT id, project_id, file_path, duration, transcript_status, created_at, updated_at, audio_path
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
pub async fn export_lesson(
    app: &AppHandle,
    video_path: &str,
    start: f64,
    end: f64,
    output_path: &str,
    mut register_child: impl FnMut(CommandChild) + Send,
    mut on_progress: impl FnMut(f64) + Send,
) -> Result<(), String> {
    let duration = (end - start).max(0.0);

    let args: Vec<String> = vec![
        "-y".to_string(),
        "-ss".to_string(),
        start.to_string(),
        "-i".to_string(),
        video_path.to_string(),
        "-t".to_string(),
        duration.to_string(),
        "-c:v".to_string(),
        "libx264".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-nostats".to_string(),
        output_path.to_string(),
    ];

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

