//! Export queue (PRD §10-11, Milestone 7): output-filename/collision
//! handling, the `#[tauri::command]`s that manage `exports` rows, and the
//! single, sequential, app-wide worker that actually cuts and (for a
//! multi-segment lesson) concatenates a lesson's `lesson_segments` into one
//! output file via `ffmpeg::export_lesson`/`ffmpeg::concat_videos` (see
//! `ffmpeg.rs` for the encode/concat invocations themselves — this module
//! owns orchestration, not the ffmpeg subprocess details).
//!
//! Exports are video-only (MP4) — SRT export was dropped (see
//! `docs/ux-overhaul-plan.md`'s M1: re-timing subtitle cues against a
//! concatenated, gapped output was the riskiest silent-failure part of
//! multi-segment export, and removing the feature was less work and less
//! risk than getting that right).
//!
//! Per `coursecut-privacy-invariants`: nothing here makes a network call.
//! It only ever reads the already-imported source video (never modified or
//! deleted), and writes new local output files (the exported MP4, plus
//! transient per-segment temp files cleaned up before/after use) under a
//! user-chosen folder or the app's cache dir.
//!
//! ## Scoped pause/resume (a deliberate scope-narrowing, not an oversight)
//!
//! "Pause" here only ever applies to a job that hasn't started encoding
//! yet (`queued` -> `paused`, and back). There is no realistically
//! portable way to suspend a live, plain ffmpeg subprocess mid-encode and
//! resume it later across both macOS and Windows with this stack (no job
//! control API this app already depends on gives us that), so this
//! intentionally does *not* attempt it — calling `pause_export` on a
//! `running` job returns a clear `Err` instead of silently doing nothing
//! or (worse) actually killing the process. Cancelling a running job *is*
//! supported (see `cancel_export`), since killing a subprocess outright is
//! portable and unambiguous in a way that "freeze and later resume" is not.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandChild;

use crate::db::{self, DbConnection, TranscriptSegmentRow};

#[derive(Debug, Clone, Serialize)]
pub struct ExportRow {
    pub id: String,
    pub lesson_id: String,
    pub output_path: String,
    pub status: String,
    pub created_at: String,
    pub progress: f64,
    pub error: Option<String>,
    // The four fields below are only ever populated by `list_exports` (its
    // query joins `lessons`/`videos`, so they're guaranteed non-null there).
    // Every other command in this module builds an `ExportRow` from just the
    // bare `exports` table (via `query_export`, which only ever selects the
    // plain columns above) and fills these in with the same placeholder
    // values it always has — Milestone 8 (PRD §11, Export History) is the
    // only consumer that needs this ancestry, and re-deriving it in every
    // other command would mean an extra join for data those callers don't
    // use.
    pub lesson_title: String,
    pub lesson_start: f64,
    pub lesson_end: f64,
    pub video_file_path: String,
}

fn row_to_export(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExportRow> {
    Ok(ExportRow {
        id: row.get("id")?,
        lesson_id: row.get("lesson_id")?,
        output_path: row.get("output_path")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        progress: row.get("progress")?,
        error: row.get("error")?,
        lesson_title: String::new(),
        lesson_start: 0.0,
        lesson_end: 0.0,
        video_file_path: String::new(),
    })
}

/// Same shape as `row_to_export`, but for `list_exports`'s wider `SELECT`
/// (see below), which also joins in the lesson/video ancestry Export
/// History (PRD §11) needs to render a row without a second round-trip per
/// row.
fn row_to_export_with_ancestry(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExportRow> {
    Ok(ExportRow {
        id: row.get("id")?,
        lesson_id: row.get("lesson_id")?,
        output_path: row.get("output_path")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        progress: row.get("progress")?,
        error: row.get("error")?,
        lesson_title: row.get("lesson_title")?,
        lesson_start: row.get("lesson_start")?,
        lesson_end: row.get("lesson_end")?,
        video_file_path: row.get("video_file_path")?,
    })
}

fn query_export(conn: &Connection, id: &str) -> Result<ExportRow, String> {
    conn.query_row(
        "SELECT id, lesson_id, output_path, status, created_at, progress, error
         FROM exports WHERE id = ?1",
        params![id],
        row_to_export,
    )
    .map_err(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => format!("export {id} does not exist"),
        other => other.to_string(),
    })
}

// ---------------------------------------------------------------------
// Output filename derivation + collision handling.
// ---------------------------------------------------------------------

/// Filesystem-safe filename stem derived from a lesson's title:
/// non-alphanumeric (and non-`-`) characters collapse to a single `_`,
/// leading/trailing underscores are trimmed, and an empty result (e.g. a
/// title that's entirely punctuation/emoji) falls back to `"lesson"`
/// rather than producing an unusable empty filename.
fn sanitize_filename(title: &str) -> String {
    let mut out = String::new();
    let mut last_was_underscore = false;
    for ch in title.chars() {
        if ch.is_alphanumeric() || ch == '-' {
            out.push(ch);
            last_was_underscore = false;
        } else if !last_was_underscore {
            out.push('_');
            last_was_underscore = true;
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "lesson".to_string()
    } else {
        trimmed
    }
}

/// Picks an output `.mp4` path under `output_dir` for `title` that doesn't
/// collide with `taken` (already-registered `exports.output_path` values,
/// checked by the caller so two lessons queued in the same or a different
/// batch never resolve to the same not-yet-created path) or with a file
/// that already exists on disk — appending `_2`, `_3`, etc. to the
/// sanitized title until a free name is found.
///
/// This check happens once, at queue time; it does not defend against two
/// *concurrent* `queue_export` calls racing on the filesystem (SQLite
/// access is serialized by `DbConnection`'s mutex, so two calls to this
/// command can't interleave with each other, but a file appearing on disk
/// *after* this check and before the worker actually writes it — e.g. the
/// user manually saving a same-named file into that folder in the
/// meantime — isn't guarded against). Acceptable for this milestone's
/// scope; flagged here rather than silently assumed airtight.
fn unique_output_path(output_dir: &Path, title: &str, taken: &HashSet<String>) -> PathBuf {
    let base = sanitize_filename(title);
    let mut suffix = 0u32;
    loop {
        let stem = if suffix == 0 {
            base.clone()
        } else {
            format!("{base}_{}", suffix + 1)
        };
        let candidate = output_dir.join(format!("{stem}.mp4"));
        let candidate_str = candidate.to_string_lossy().to_string();
        if !taken.contains(&candidate_str) && !candidate.exists() {
            return candidate;
        }
        suffix += 1;
    }
}

// ---------------------------------------------------------------------
// Queue commands.
// ---------------------------------------------------------------------

/// Inserts one `exports` row (`status = 'queued'`) per lesson id, with
/// `output_path` derived from that lesson's title under `output_dir`
/// (collision-checked against both the filesystem and every other
/// already-registered export's `output_path`, including ones queued
/// earlier in this same call — see `unique_output_path`). Returns the
/// created rows in the order `lesson_ids` was given.
#[tauri::command(async)]
pub fn queue_export(
    conn: tauri::State<'_, DbConnection>,
    lesson_ids: Vec<String>,
    output_dir: String,
) -> Result<Vec<ExportRow>, String> {
    if lesson_ids.is_empty() {
        return Err("no lessons selected to export".to_string());
    }

    let output_dir_path = Path::new(&output_dir);
    if !output_dir_path.is_dir() {
        return Err(format!("{output_dir} is not a directory"));
    }

    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;

    let mut taken: HashSet<String> = {
        let mut stmt = tx
            .prepare("SELECT output_path FROM exports")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<HashSet<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    let mut created = Vec::new();
    for lesson_id in lesson_ids {
        let title: String = tx
            .query_row(
                "SELECT title FROM lessons WHERE id = ?1",
                params![lesson_id],
                |row| row.get(0),
            )
            .map_err(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => {
                    format!("lesson {lesson_id} does not exist")
                }
                other => other.to_string(),
            })?;

        let output_path = unique_output_path(output_dir_path, &title, &taken);
        let output_path_str = output_path
            .to_str()
            .ok_or_else(|| "output path is not valid UTF-8".to_string())?
            .to_string();
        taken.insert(output_path_str.clone());

        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO exports (id, lesson_id, output_path, status, created_at, progress, error)
             VALUES (?1, ?2, ?3, 'queued', ?4, 0, NULL)",
            params![id, lesson_id, output_path_str, now],
        )
        .map_err(|err| err.to_string())?;

        created.push(ExportRow {
            id,
            lesson_id,
            output_path: output_path_str,
            status: "queued".to_string(),
            created_at: now,
            progress: 0.0,
            error: None,
            // Placeholder — see `ExportRow`'s doc comment: this command's
            // return value is never rendered directly by the frontend (it
            // always re-fetches via `list_exports` after queuing), so this
            // doesn't need the real lesson/video ancestry.
            lesson_title: String::new(),
            lesson_start: 0.0,
            lesson_end: 0.0,
            video_file_path: String::new(),
        });
    }

    tx.commit().map_err(|err| err.to_string())?;
    Ok(created)
}

/// Pauses a job that hasn't started yet: `queued` -> `paused`. See the
/// module docs' "Scoped pause/resume" section for why this rejects
/// anything other than `queued` rather than trying to suspend a live
/// `running` encode.
#[tauri::command]
pub fn pause_export(conn: tauri::State<'_, DbConnection>, id: String) -> Result<ExportRow, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    let status: String = conn
        .query_row(
            "SELECT status FROM exports WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => format!("export {id} does not exist"),
            other => other.to_string(),
        })?;
    if status != "queued" {
        return Err(format!(
            "cannot pause export {id}: only a queued export can be paused (current status: {status})"
        ));
    }
    conn.execute(
        "UPDATE exports SET status = 'paused' WHERE id = ?1",
        params![id],
    )
    .map_err(|err| err.to_string())?;
    query_export(&conn, &id)
}

/// Resumes a paused job: `paused` -> `queued` (the worker picks it up on
/// its next poll, same as any other queued row).
#[tauri::command]
pub fn resume_export(conn: tauri::State<'_, DbConnection>, id: String) -> Result<ExportRow, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    let status: String = conn
        .query_row(
            "SELECT status FROM exports WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => format!("export {id} does not exist"),
            other => other.to_string(),
        })?;
    if status != "paused" {
        return Err(format!(
            "cannot resume export {id}: only a paused export can be resumed (current status: {status})"
        ));
    }
    conn.execute(
        "UPDATE exports SET status = 'queued' WHERE id = ?1",
        params![id],
    )
    .map_err(|err| err.to_string())?;
    query_export(&conn, &id)
}

/// Cancels a job. For a `queued`/`paused` job this just flips its status.
/// For a `running` job this actually stops the in-flight ffmpeg process:
/// the row is marked `cancelled` immediately, and — if the worker has
/// registered the child by the time this runs — its `CommandChild` is
/// looked up in `ExportRunning` (keyed by export id) and killed via
/// `tauri-plugin-shell`'s `CommandChild::kill()`. There's a narrow window
/// between the worker marking a row `running` and actually registering its
/// spawned child where this is a no-op kill (nothing to find yet); that's
/// fine because the row is already marked `cancelled` at that point, and
/// the worker's own post-encode check of the row's current status (see
/// `finalize`) is what makes cancellation reliable even then — it won't
/// overwrite `cancelled` with `done`/`failed` once the encode it can't stop
/// in time eventually finishes.
#[tauri::command]
pub fn cancel_export(
    conn: tauri::State<'_, DbConnection>,
    running: tauri::State<'_, ExportRunning>,
    id: String,
) -> Result<ExportRow, String> {
    let db = conn.0.lock().map_err(|err| err.to_string())?;
    let status: String = db
        .query_row(
            "SELECT status FROM exports WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => format!("export {id} does not exist"),
            other => other.to_string(),
        })?;

    match status.as_str() {
        "queued" | "paused" | "running" => {
            db.execute(
                "UPDATE exports SET status = 'cancelled' WHERE id = ?1",
                params![id],
            )
            .map_err(|err| err.to_string())?;
            if status == "running" {
                let mut map = running.0.lock().map_err(|err| err.to_string())?;
                if let Some(child) = map.remove(&id) {
                    // Best-effort: if the kill itself fails (process
                    // already gone, OS error), the row is already marked
                    // cancelled regardless.
                    let _ = child.kill();
                }
            }
        }
        other => {
            return Err(format!("cannot cancel export {id}: already {other}"));
        }
    }

    query_export(&db, &id)
}

/// Resets a `failed`/`cancelled` job back to `queued` (clearing `progress`
/// and `error`) so the worker picks it up again on its next poll.
#[tauri::command]
pub fn retry_export(conn: tauri::State<'_, DbConnection>, id: String) -> Result<ExportRow, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    let status: String = conn
        .query_row(
            "SELECT status FROM exports WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => format!("export {id} does not exist"),
            other => other.to_string(),
        })?;
    if status != "failed" && status != "cancelled" {
        return Err(format!(
            "cannot retry export {id}: only a failed or cancelled export can be retried (current status: {status})"
        ));
    }
    conn.execute(
        "UPDATE exports SET status = 'queued', progress = 0, error = NULL WHERE id = ?1",
        params![id],
    )
    .map_err(|err| err.to_string())?;
    query_export(&conn, &id)
}

/// Read-only listing of a project's exports (joined through `lessons` ->
/// `videos` to filter by `project_id`), newest first. Also selects the
/// lesson/video ancestry (title, start/end, source file path) via that same
/// join, for Export History (PRD §11) to render a row without a second
/// round-trip per row. Pure CRUD — no ffmpeg or network work here.
#[tauri::command]
pub fn list_exports(
    conn: tauri::State<'_, DbConnection>,
    project_id: String,
) -> Result<Vec<ExportRow>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.lesson_id, e.output_path, e.status, e.created_at, e.progress, e.error,
                    l.title AS lesson_title, l.start AS lesson_start, l.end AS lesson_end,
                    v.file_path AS video_file_path
             FROM exports e
             JOIN lessons l ON l.id = e.lesson_id
             JOIN videos v ON v.id = l.video_id
             WHERE v.project_id = ?1
             ORDER BY e.created_at DESC, e.id DESC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![project_id], row_to_export_with_ancestry)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

/// Reveals an exported file in the OS file manager (Finder on macOS,
/// Explorer on Windows — the only two target platforms, see
/// `CLAUDE.md`/PRD "Platform"). Shells out directly with a hardcoded
/// binary name rather than going through `tauri_plugin_shell` (whose ACL
/// in `capabilities/default.json` only allow-lists the ffmpeg/ffprobe
/// sidecars) — `path` is the only caller-controlled part, same trust
/// level as an ffmpeg argument already has.
#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|err| format!("could not reveal {path}: {err}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args([format!("/select,{path}")])
            .spawn()
            .map_err(|err| format!("could not reveal {path}: {err}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Startup crash recovery.
// ---------------------------------------------------------------------

/// Resets every `running` export row back to a retry-able `failed` state.
/// Called once from `lib.rs`'s `setup()`, before the connection is handed to
/// managed state and before `spawn_worker` starts.
///
/// A `running` row only exists while the worker's ffmpeg subprocess is
/// actually encoding it; if the app is killed mid-export (crash, force
/// quit), that row is left stuck at `running` forever otherwise — none of
/// `retry_export` (`failed`/`cancelled` only), `pause_export`/
/// `resume_export` (`queued`/`paused` only) can reach it, so there'd be no
/// UI-reachable way to recover it. There should be at most one such row in
/// practice (the worker is sequential), but every one found is reconciled,
/// in case of a future bug or manual DB state.
///
/// Any partial output file the interrupted encode may have written is
/// best-effort deleted first (same non-fatal cleanup convention as
/// `finalize`'s cancellation path) — an interrupted encode's output isn't a
/// valid video, and leaving it in place would look like a real export.
///
/// Also best-effort removes the whole `export_tmp` scratch directory (see
/// `segment_temp_dir_path`) under `cache_dir`: a multi-segment export's
/// per-segment cut files live there only for the duration of one job, and
/// `do_export`/`finalize` already clean them up on every in-process return
/// path (success, failure, or a cancel) — but a whole-app crash mid-job
/// skips all of that, since nothing runs. Since only one export ever runs
/// at a time, anything found under `export_tmp` at startup is unconditionally
/// orphaned from a previous session, so this doesn't need per-job
/// bookkeeping — the entire directory is safe to remove wholesale.
pub fn reconcile_interrupted_exports(conn: &Connection, cache_dir: &Path) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id, output_path FROM exports WHERE status = 'running'")
        .map_err(|err| err.to_string())?;
    let interrupted: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    drop(stmt);

    for (id, output_path) in interrupted {
        let _ = std::fs::remove_file(&output_path);
        conn.execute(
            "UPDATE exports SET status = 'failed', progress = 0, error = ?1 WHERE id = ?2",
            params![
                "Export was interrupted (app restarted) — use Retry to run it again.",
                id
            ],
        )
        .map_err(|err| err.to_string())?;
    }

    let _ = std::fs::remove_dir_all(cache_dir.join("export_tmp"));

    Ok(())
}

// ---------------------------------------------------------------------
// The sequential, app-wide export worker.
// ---------------------------------------------------------------------

/// Managed state tracking the `CommandChild` of whatever export is
/// currently running, keyed by that export's id — looked up by
/// `cancel_export` to kill an in-flight ffmpeg process. Since only one
/// export ever runs at a time (see `spawn_worker`), this map holds at most
/// one entry in practice, but is keyed by id (rather than a single
/// `Option`) so `cancel_export` doesn't have to guess *which* export a bare
/// `Option` refers to.
pub struct ExportRunning(pub Mutex<HashMap<String, CommandChild>>);

impl ExportRunning {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

impl Default for ExportRunning {
    fn default() -> Self {
        Self::new()
    }
}

/// One segment of a lesson being exported, in `sort_order`. Just the bounds
/// — `id`/`lesson_id` aren't needed once the segments are loaded in order.
struct SegmentBounds {
    start: f64,
    end: f64,
}

/// The oldest still-`queued` export, joined with just enough of its
/// `lessons`/`videos` ancestry to actually run it. `segments` is the
/// lesson's actual `lesson_segments` rows, in playback order — **not**
/// `lessons.start`/`.end`, which for a non-contiguous lesson is only a
/// cached derived bound (min start, max end) and would re-include exactly
/// the gaps the user excluded if used to cut a single span.
struct PendingExport {
    id: String,
    lesson_id: String,
    output_path: String,
    video_path: String,
    segments: Vec<SegmentBounds>,
}

fn next_queued_export(app: &AppHandle) -> Result<Option<PendingExport>, String> {
    let conn = app.state::<DbConnection>();
    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    let base: Option<(String, String, String, String)> = guard
        .query_row(
            "SELECT e.id, e.lesson_id, e.output_path, v.file_path
             FROM exports e
             JOIN lessons l ON l.id = e.lesson_id
             JOIN videos v ON v.id = l.video_id
             WHERE e.status = 'queued'
             ORDER BY e.created_at ASC, e.id ASC
             LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                ))
            },
        )
        .optional()
        .map_err(|err| err.to_string())?;

    let Some((id, lesson_id, output_path, video_path)) = base else {
        return Ok(None);
    };

    // Same query `db::list_lesson_segments` runs, ordered by playback
    // order — this is what actually gets cut, not the lesson's cached
    // start/end bound.
    let mut stmt = guard
        .prepare(
            "SELECT start, end FROM lesson_segments
             WHERE lesson_id = ?1 ORDER BY sort_order, id",
        )
        .map_err(|err| err.to_string())?;
    let segments: Vec<SegmentBounds> = stmt
        .query_map(params![lesson_id], |row| {
            Ok(SegmentBounds {
                start: row.get(0)?,
                end: row.get(1)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    Ok(Some(PendingExport {
        id,
        lesson_id,
        output_path,
        video_path,
        segments,
    }))
}

/// Atomically claims `id` for running: `queued` -> `running`, guarded by
/// `AND status = 'queued'` so this can't clobber a `cancel_export` that runs
/// in the narrow window between `next_queued_export` picking this row and
/// this call actually landing (which would otherwise flip the row
/// `queued -> cancelled -> running`, silently undoing the cancel and
/// letting a cancelled export run to completion). Returns whether the claim
/// succeeded (i.e. whether the row was still `queued`) — the caller must
/// not proceed to actually run `export_lesson` when this is `false`.
fn mark_running(app: &AppHandle, id: &str) -> Result<bool, String> {
    let conn = app.state::<DbConnection>();
    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    let affected = guard
        .execute(
            "UPDATE exports SET status = 'running' WHERE id = ?1 AND status = 'queued'",
            params![id],
        )
        .map_err(|err| err.to_string())?;
    Ok(affected > 0)
}

/// No-op if the row isn't (still) `running` — most relevantly, if
/// `cancel_export` already flipped it to `cancelled`, a progress line that
/// arrives from ffmpeg just before it's killed shouldn't resurrect the row.
fn set_progress(app: &AppHandle, id: &str, fraction: f64) {
    let conn = app.state::<DbConnection>();
    let Ok(guard) = conn.0.lock() else { return };
    let _ = guard.execute(
        "UPDATE exports SET progress = ?1 WHERE id = ?2 AND status = 'running'",
        params![fraction.clamp(0.0, 1.0), id],
    );
}

/// Currently unused now that SRT export (its only consumer) is gone — kept
/// rather than deleted since it's the one place that already knows how to
/// load a lesson's *kept* transcript segments, which a later milestone
/// (silence trimming, PRD ux-overhaul-plan M6) is expected to need again.
#[allow(dead_code)]
fn load_kept_segments(app: &AppHandle, lesson_id: &str) -> Result<Vec<TranscriptSegmentRow>, String> {
    let conn = app.state::<DbConnection>();
    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    let video_id: String = guard
        .query_row(
            "SELECT video_id FROM lessons WHERE id = ?1",
            params![lesson_id],
            |row| row.get(0),
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => format!("lesson {lesson_id} does not exist"),
            other => other.to_string(),
        })?;
    let mut stmt = guard
        .prepare(
            "SELECT id, video_id, start, end, text, keep FROM transcript_segments
             WHERE video_id = ?1 ORDER BY start, id",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![video_id], db::row_to_transcript_segment)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

/// Path (not necessarily existing) of the scratch directory used for one
/// export job's per-segment cut files, under the app's cache dir — same
/// convention as `ffmpeg.rs`'s `audio_cache_dir`, but per-job rather than
/// content-hash-keyed, since nothing here is meant to persist or be reused.
fn segment_temp_dir_path(app: &AppHandle, job_id: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("could not resolve app cache dir: {err}"))?
        .join("export_tmp")
        .join(job_id))
}

/// `segment_temp_dir_path`, created if it doesn't already exist. The caller
/// (`do_export`) removes it again once its segment files are concatenated
/// (or on failure/cancellation).
fn segment_temp_dir(app: &AppHandle, job_id: &str) -> Result<PathBuf, String> {
    let dir = segment_temp_dir_path(app, job_id)?;
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("could not create export temp dir: {err}"))?;
    Ok(dir)
}

/// Best-effort removal of `paths` and then `dir` itself (only succeeds once
/// empty) — never fails the caller, since this only ever cleans up this
/// pipeline's own transient files.
fn cleanup_segment_temp_files(dir: &Path, paths: &[String]) {
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
    let _ = std::fs::remove_dir(dir);
}

/// A fresh `register_child` closure for one ffmpeg spawn — a new one is
/// needed per spawn (a multi-segment export spawns ffmpeg once per segment
/// plus once for the final concat) since each is consumed by value.
/// Registering again under the same job id simply overwrites the previous
/// (already-finished) entry, so `cancel_export` always finds whichever
/// child is actually running right now.
fn register_child_closure(app: &AppHandle, job_id: &str) -> impl FnMut(CommandChild) + Send {
    let app = app.clone();
    let job_id = job_id.to_string();
    move |child: CommandChild| {
        let running = app.state::<ExportRunning>();
        if let Ok(mut map) = running.0.lock() {
            map.insert(job_id.clone(), child);
        };
    }
}

/// The child is gone either way (finished, errored, or killed) — drop its
/// registry entry so a stale `cancel_export` call can't try to kill an
/// already-gone process.
fn deregister_child(app: &AppHandle, job_id: &str) {
    let running = app.state::<ExportRunning>();
    if let Ok(mut map) = running.0.lock() {
        map.remove(job_id);
    };
}

/// Whether `job_id`'s row has already been flipped to `cancelled` (by
/// `cancel_export`, which only kills whatever ffmpeg child is registered
/// *right now*) — checked between segments and before the final concat step
/// in a multi-segment export, since a cancel that lands in the gap between
/// one segment's process exiting and the next one spawning would otherwise
/// go unnoticed until the whole job finishes (every remaining segment plus
/// the concat would still run to completion before `finalize` ever saw the
/// cancelled status). Defaults to "not cancelled" if the row can't be read,
/// so a transient lock/query failure never blocks a job that wasn't
/// actually cancelled.
fn is_cancelled(app: &AppHandle, job_id: &str) -> bool {
    let conn = app.state::<DbConnection>();
    let Ok(guard) = conn.0.lock() else { return false };
    guard
        .query_row(
            "SELECT status FROM exports WHERE id = ?1",
            params![job_id],
            |row| row.get::<_, String>(0),
        )
        .map(|status| status == "cancelled")
        .unwrap_or(false)
}

/// A fresh `on_progress` closure for one segment's own `export_lesson` call,
/// rescaling that segment's own `[0, 1]` fraction into the job's overall
/// `[0, 1]` progress: `elapsed` is the summed duration of segments already
/// finished, `segment_duration` is this segment's own duration, and `total`
/// is the summed duration across every segment in the job. A
/// segment-count-only weighting (`(index + fraction) / segment_count`)
/// would be simpler but skews badly when segments have very different
/// lengths; duration-weighting is barely more code and much more honest
/// about how much of the job is actually left.
fn progress_closure(
    app: &AppHandle,
    job_id: &str,
    elapsed: f64,
    segment_duration: f64,
    total: f64,
) -> impl FnMut(f64) + Send {
    let app = app.clone();
    let job_id = job_id.to_string();
    move |fraction: f64| {
        let overall = if total > 0.0 {
            (elapsed + fraction * segment_duration) / total
        } else {
            fraction
        };
        set_progress(&app, &job_id, overall);
    }
}

/// Runs the encode for one export job: cuts every one of the lesson's
/// segments (in order) and, for a multi-segment lesson, concatenates them
/// into a single output file (PRD decision, `docs/ux-overhaul-plan.md` M1 —
/// a multi-segment lesson exports as one concatenated video, not one file
/// per segment).
///
/// A single-segment lesson (the common case — one segment per lesson unless
/// the user has explicitly built a multi-segment one) takes a fast path:
/// `export_lesson` cuts straight to `job.output_path`, with no intermediate
/// temp file and no concat step, so it produces exactly the same output as
/// before multi-segment export existed (no extra re-mux/quality loss).
///
/// A multi-segment lesson cuts each segment to its own temp file under
/// `segment_temp_dir`, then concatenates them via
/// `ffmpeg::concat_videos` (safe as a stream-copy concat, since every temp
/// file was just encoded by the same `export_lesson`/libx264/aac settings).
/// Temp files (and their directory) are removed once the concat succeeds,
/// and also on a mid-job failure/cancellation — the loop below cleans up
/// whatever was cut so far before returning `Err`, so a failed or cancelled
/// multi-segment export never leaves stray per-segment files behind.
async fn do_export(app: &AppHandle, job: &PendingExport) -> Result<(), String> {
    if job.segments.is_empty() {
        return Err(format!(
            "lesson {} has no segments to export",
            job.lesson_id
        ));
    }

    if job.segments.len() == 1 {
        let segment = &job.segments[0];
        let register_child = register_child_closure(app, &job.id);
        let on_progress = progress_closure(app, &job.id, 0.0, 1.0, 1.0);
        let result = crate::ffmpeg::export_lesson(
            app,
            &job.video_path,
            segment.start,
            segment.end,
            &job.output_path,
            register_child,
            on_progress,
        )
        .await;
        deregister_child(app, &job.id);
        return result;
    }

    let total_duration: f64 = job
        .segments
        .iter()
        .map(|segment| (segment.end - segment.start).max(0.0))
        .sum();
    let temp_dir = segment_temp_dir(app, &job.id)?;
    let mut temp_paths: Vec<String> = Vec::new();
    let mut elapsed = 0.0;

    for (index, segment) in job.segments.iter().enumerate() {
        if is_cancelled(app, &job.id) {
            cleanup_segment_temp_files(&temp_dir, &temp_paths);
            return Err("export cancelled".to_string());
        }

        let temp_path = temp_dir.join(format!("segment-{index}.mp4"));
        let Some(temp_path_str) = temp_path.to_str().map(str::to_string) else {
            cleanup_segment_temp_files(&temp_dir, &temp_paths);
            return Err("segment temp path is not valid UTF-8".to_string());
        };
        let segment_duration = (segment.end - segment.start).max(0.0);
        let register_child = register_child_closure(app, &job.id);
        let on_progress = progress_closure(app, &job.id, elapsed, segment_duration, total_duration);

        let result = crate::ffmpeg::export_lesson(
            app,
            &job.video_path,
            segment.start,
            segment.end,
            &temp_path_str,
            register_child,
            on_progress,
        )
        .await;
        deregister_child(app, &job.id);

        if let Err(err) = result {
            // This segment's own (possibly partial) temp file too, not just
            // the ones from prior segments.
            let _ = std::fs::remove_file(&temp_path_str);
            cleanup_segment_temp_files(&temp_dir, &temp_paths);
            return Err(err);
        }

        temp_paths.push(temp_path_str);
        elapsed += segment_duration;
    }

    if is_cancelled(app, &job.id) {
        cleanup_segment_temp_files(&temp_dir, &temp_paths);
        return Err("export cancelled".to_string());
    }

    let register_child = register_child_closure(app, &job.id);
    let concat_result =
        crate::ffmpeg::concat_videos(app, &temp_paths, &job.output_path, register_child).await;
    deregister_child(app, &job.id);

    cleanup_segment_temp_files(&temp_dir, &temp_paths);

    concat_result
}

/// Writes the final status for a finished job, unless `cancel_export`
/// already marked it `cancelled` while the encode was unwinding — in which
/// case that status is left alone (a killed ffmpeg process reports a
/// non-zero/signal exit, which would otherwise look like a genuine
/// `failed`), and any partially-written output is best-effort cleaned up.
/// This only ever removes files this export pipeline itself wrote — the
/// source video is never touched. `do_export` already cleans up its own
/// per-segment temp files on every return path (including a cancellation
/// mid-job), so there's normally nothing left under `segment_temp_dir` by
/// the time this runs — the removal here is a defensive backstop, not the
/// primary cleanup path.
fn finalize(app: &AppHandle, job: &PendingExport, result: Result<(), String>) {
    let conn = app.state::<DbConnection>();
    let Ok(guard) = conn.0.lock() else { return };

    let current_status: Result<String, _> = guard.query_row(
        "SELECT status FROM exports WHERE id = ?1",
        params![job.id],
        |row| row.get(0),
    );
    let Ok(current_status) = current_status else {
        return;
    };

    if current_status == "cancelled" {
        let _ = std::fs::remove_file(&job.output_path);
        if let Ok(temp_dir) = segment_temp_dir_path(app, &job.id) {
            let _ = std::fs::remove_dir_all(&temp_dir);
        }
        return;
    }

    match result {
        Ok(()) => {
            let _ = guard.execute(
                "UPDATE exports SET status = 'done', progress = 1, error = NULL WHERE id = ?1",
                params![job.id],
            );
        }
        Err(message) => {
            let _ = guard.execute(
                "UPDATE exports SET status = 'failed', error = ?1 WHERE id = ?2",
                params![message, job.id],
            );
        }
    }
}

async fn run_one(app: &AppHandle, job: PendingExport) {
    match mark_running(app, &job.id) {
        Ok(true) => {}
        Ok(false) => {
            // The row was moved out of `queued` (most likely `cancelled`,
            // via `cancel_export`) in the window between the worker picking
            // it up and this claim landing — it's no longer actually queued,
            // so skip encoding it and let the worker's loop move on to look
            // for the next queued job instead.
            return;
        }
        Err(err) => {
            eprintln!("export worker: could not mark {} running: {err}", job.id);
            return;
        }
    }
    let result = do_export(app, &job).await;
    finalize(app, &job, result);
}

/// How long the worker sleeps between polls when there's nothing queued.
/// Not a wake-on-insert mechanism (no existing push channel from
/// Rust->worker to build one on) — a short poll is simple and more than
/// responsive enough for a user-driven export queue.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

/// Spawns the single, sequential, app-wide export worker (PRD §10's
/// "sequential export queue processor") as a background task. Called once
/// from `lib.rs`'s `setup()`. Loops forever: finds the oldest `queued` row
/// (skipping `paused` ones), runs it to completion (or failure/
/// cancellation), then looks for the next one — so only one ffmpeg export
/// subprocess ever runs at a time, regardless of how many videos/lessons
/// have exports queued.
pub fn spawn_worker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let next = match next_queued_export(&app) {
                Ok(next) => next,
                Err(err) => {
                    eprintln!("export worker: could not query next export: {err}");
                    None
                }
            };
            match next {
                Some(job) => run_one(&app, job).await,
                None => tokio::time::sleep(POLL_INTERVAL).await,
            }
        }
    });
}

#[cfg(test)]
mod filename_tests {
    use super::*;

    #[test]
    fn sanitize_filename_collapses_unsafe_characters() {
        assert_eq!(sanitize_filename("Intro: Variables & Loops?"), "Intro_Variables_Loops");
        assert_eq!(sanitize_filename("  leading/trailing  "), "leading_trailing");
        assert_eq!(sanitize_filename("!!!"), "lesson");
        assert_eq!(sanitize_filename(""), "lesson");
    }

    #[test]
    fn unique_output_path_avoids_filesystem_and_in_batch_collisions() {
        let dir = std::env::temp_dir().join(format!("coursecut-export-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        // Nothing on disk yet, nothing "taken" — plain title wins.
        let taken = HashSet::new();
        let first = unique_output_path(&dir, "Intro", &taken);
        assert_eq!(first.file_name().unwrap().to_str().unwrap(), "Intro.mp4");

        // Simulate that path having actually been created on disk by a
        // prior export.
        std::fs::write(&first, b"fake mp4 bytes").unwrap();
        let second = unique_output_path(&dir, "Intro", &taken);
        assert_eq!(second.file_name().unwrap().to_str().unwrap(), "Intro_2.mp4");

        // A second lesson with the same title queued in the same batch
        // (before either file exists on disk) must not collide with the
        // first pick, even though neither is on disk yet — via the
        // `taken` set the caller threads through.
        let mut taken_in_batch = HashSet::new();
        let dir2 = std::env::temp_dir().join(format!("coursecut-export-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir2).unwrap();
        let batch_first = unique_output_path(&dir2, "Intro", &taken_in_batch);
        taken_in_batch.insert(batch_first.to_string_lossy().to_string());
        let batch_second = unique_output_path(&dir2, "Intro", &taken_in_batch);
        assert_ne!(batch_first, batch_second);
        assert_eq!(batch_second.file_name().unwrap().to_str().unwrap(), "Intro_2.mp4");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }
}

#[cfg(test)]
mod reconcile_tests {
    use super::*;

    /// In-memory, fully-migrated DB seeded with one project/video/lesson,
    /// following the same pattern as `db.rs`'s `lesson_editing_tests`.
    fn seeded_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::migrate(&conn).unwrap();

        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Test', 't', 't')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO videos (id, project_id, file_path, created_at, updated_at)
             VALUES ('v1', 'p1', '/tmp/video.mp4', 't', 't')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO lessons (id, video_id, title, summary, start, end, sort_order, confidence, kind, source)
             VALUES ('l1', 'v1', 'Lesson', 'summary', 0.0, 10.0, 0, 0.8, 'lesson', 'ai')",
            [],
        )
        .unwrap();

        conn
    }

    #[test]
    fn reconcile_resets_running_row_to_failed_and_deletes_partial_output() {
        let conn = seeded_conn();

        let dir = std::env::temp_dir().join(format!("coursecut-reconcile-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let output_path = dir.join("Lesson.mp4");
        std::fs::write(&output_path, b"partial, interrupted mp4 bytes").unwrap();

        conn.execute(
            "INSERT INTO exports (id, lesson_id, output_path, status, created_at, progress, error)
             VALUES ('e1', 'l1', ?1, 'running', 't', 0.42, NULL)",
            params![output_path.to_string_lossy().to_string()],
        )
        .unwrap();

        // An orphaned per-segment scratch dir left behind by a whole-app
        // crash mid multi-segment-export in a previous session — nothing in
        // `do_export`/`finalize` ever runs to clean this up when the app
        // itself is what died, so `reconcile_interrupted_exports` is the
        // only place left that can sweep it.
        let cache_dir = std::env::temp_dir().join(format!("coursecut-reconcile-cache-{}", uuid::Uuid::new_v4()));
        let orphaned_temp_dir = cache_dir.join("export_tmp").join("e1");
        std::fs::create_dir_all(&orphaned_temp_dir).unwrap();
        std::fs::write(orphaned_temp_dir.join("segment-0.mp4"), b"orphaned segment bytes").unwrap();

        reconcile_interrupted_exports(&conn, &cache_dir).unwrap();

        let (status, progress, error): (String, f64, Option<String>) = conn
            .query_row(
                "SELECT status, progress, error FROM exports WHERE id = 'e1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "failed");
        assert_eq!(progress, 0.0);
        assert!(error.unwrap().contains("interrupted"));

        assert!(!output_path.exists(), "partial output file should be deleted");
        assert!(
            !cache_dir.join("export_tmp").exists(),
            "orphaned export_tmp scratch directory should be swept on startup"
        );

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    #[test]
    fn reconcile_leaves_non_running_rows_untouched() {
        let conn = seeded_conn();
        conn.execute(
            "INSERT INTO exports (id, lesson_id, output_path, status, created_at, progress, error)
             VALUES ('e2', 'l1', '/tmp/does-not-exist.mp4', 'queued', 't', 0, NULL)",
            [],
        )
        .unwrap();

        let cache_dir = std::env::temp_dir().join(format!("coursecut-reconcile-cache-{}", uuid::Uuid::new_v4()));
        reconcile_interrupted_exports(&conn, &cache_dir).unwrap();

        let status: String = conn
            .query_row("SELECT status FROM exports WHERE id = 'e2'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(status, "queued");
    }
}
