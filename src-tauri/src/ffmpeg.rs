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

/// Extracts mono 16kHz WAV audio from `video_path` into `output_path` — the
/// format Whisper expects (PRD §7.3/§9). Reads the source video and writes
/// only the new audio file; the source is never modified, copied, or
/// uploaded.
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

    match run_extraction(&app, &conn, &video_id, &file_path).await {
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
            let output_path = dir.join(format!("{hash}.wav"));
            let output_path_str = output_path
                .to_str()
                .ok_or_else(|| "audio cache path is not valid UTF-8".to_string())?
                .to_string();
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

