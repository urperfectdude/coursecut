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

/// Loads the `frame_overlays` rows (lesson-scoped, `start`/`end` in
/// *virtual* stitched-lesson seconds — see `0009_frame_overlay_lesson_scoped.sql`)
/// that intersect one particular segment's slice of the lesson's virtual
/// timeline, translated into that segment's own real, segment-relative
/// seconds (0 = the start of the cut `export_lesson` is about to make) —
/// what `crate::ffmpeg::SegmentOverlay` needs.
///
/// `segment_offset` is that segment's cumulative virtual-timeline position
/// (same quantity as `LessonPreviewPlayer.tsx`'s `segmentOffsets[i]` on the
/// frontend: the summed length of every earlier segment in the lesson) and
/// `segment_length` is its own duration (`segment.end - segment.start`).
/// Within one segment, virtual time and real time advance at the same
/// rate and only differ by a constant offset, so `local_start`/`local_end`
/// computed relative to `segment_offset` are *already* the real,
/// segment-relative seconds `SegmentOverlay` wants — no further
/// translation back through `segment.start` needed, unlike the old
/// video-scoped/absolute-time version of this function. An overlay that
/// only partially covers the segment's virtual slice is clipped to just
/// the overlapping sub-window, not the whole segment.
///
/// Takes a plain `&Connection` rather than `&AppHandle` (unlike most of
/// this module's helpers) so it's directly unit-testable against an
/// in-memory DB, matching `reconcile_interrupted_exports`'s pattern —
/// callers lock the app's `DbConnection` state themselves and pass the
/// guard through.
fn overlays_for_segment(
    conn: &Connection,
    lesson_id: &str,
    segment_offset: f64,
    segment_length: f64,
) -> Result<Vec<crate::ffmpeg::SegmentOverlay>, String> {
    let segment_virtual_end = segment_offset + segment_length;
    let mut stmt = conn
        .prepare(
            "SELECT image_path, start, end, scale_percent, x_percent, y_percent FROM frame_overlays
             WHERE lesson_id = ?1 AND start < ?2 AND end > ?3 ORDER BY start",
        )
        .map_err(|err| err.to_string())?;
    let rows: Vec<(String, f64, f64, f64, f64, f64)> = stmt
        .query_map(params![lesson_id, segment_virtual_end, segment_offset], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let mut overlays = Vec::with_capacity(rows.len());
    for (image_path, row_start, row_end, scale_percent, x_percent, y_percent) in rows {
        let local_start = (row_start - segment_offset).max(0.0);
        let local_end = (row_end - segment_offset).min(segment_length);
        if local_end <= local_start {
            continue;
        }
        overlays.push(crate::ffmpeg::SegmentOverlay {
            image_path,
            start: local_start,
            end: local_end,
            scale_percent,
            x_percent,
            y_percent,
        });
    }
    Ok(overlays)
}

/// The `lesson_regions` rows (shape layers) that intersect one segment's
/// slice of the lesson's virtual timeline, translated into that segment's
/// own cut-relative seconds and clipped to the overlap — exactly the mapping
/// `overlays_for_segment` does for overlays (see its doc; same
/// `segment_offset`/`segment_length` meaning). Ordered by start, so the
/// export chain's shape stacking order is stable.
fn regions_for_segment(
    conn: &Connection,
    lesson_id: &str,
    segment_offset: f64,
    segment_length: f64,
) -> Result<Vec<crate::ffmpeg::SegmentRegion>, String> {
    use crate::ffmpeg::{RegionFill, RegionShape, SegmentRegion};

    let segment_virtual_end = segment_offset + segment_length;
    let rows: Vec<crate::db::LessonRegionRow> = crate::db::query_lesson_regions(conn, lesson_id)?
        .into_iter()
        .filter(|row| row.start < segment_virtual_end && row.end > segment_offset)
        .collect();

    let mut regions = Vec::with_capacity(rows.len());
    for row in rows {
        let local_start = (row.start - segment_offset).max(0.0);
        let local_end = (row.end - segment_offset).min(segment_length);
        if local_end <= local_start {
            continue;
        }
        let shape = match row.shape.as_str() {
            "rect" => RegionShape::Rect,
            "rounded" => RegionShape::Rounded,
            "ellipse" => RegionShape::Ellipse,
            other => return Err(format!("region {} has an unknown shape {other:?}", row.id)),
        };
        let fill = match row.fill.as_str() {
            "blur" => RegionFill::Blur,
            "solid" => RegionFill::Solid(row.color.clone()),
            other => return Err(format!("region {} has an unknown fill {other:?}", row.id)),
        };
        regions.push(SegmentRegion {
            shape,
            fill,
            start: local_start,
            end: local_end,
            x_percent: row.x_percent,
            y_percent: row.y_percent,
            w_percent: row.w_percent,
            h_percent: row.h_percent,
            blur_strength: row.blur_strength,
        });
    }
    Ok(regions)
}

/// The lesson's crop for `CutExtras::crop`: `None` without a row or while
/// it's switched off, so such an export is exactly what it was before crop
/// existed. The same crop applies to every segment of the lesson.
fn crop_for_lesson(conn: &Connection, lesson_id: &str) -> Result<Option<crate::ffmpeg::SegmentCrop>, String> {
    let Some(row) = crate::db::query_lesson_crop(conn, lesson_id)? else {
        return Ok(None);
    };
    if !row.enabled {
        return Ok(None);
    }
    Ok(Some(crate::ffmpeg::SegmentCrop {
        x_percent: row.x_percent,
        y_percent: row.y_percent,
        w_percent: row.w_percent,
        h_percent: row.h_percent,
        bg_color: row.bg_color,
        padding_percent: row.padding_percent,
        shadow: row.shadow_enabled.then_some(crate::ffmpeg::CropShadow {
            blur: row.shadow_blur,
            opacity: row.shadow_opacity,
            offset_y: row.shadow_offset_y,
        }),
        sar: None,
    }))
}

/// One piece of an export's output, in play order. Each is encoded to its
/// own file, and the files are joined by the stream-copy `concat_videos`.
#[derive(Debug, Clone, PartialEq)]
enum ExportPiece {
    /// Lesson segment `index` (`[start, end)` of the source). `virtual_offset`
    /// is where it starts on the lesson's virtual timeline, which overlays,
    /// shapes and overlay-mode slides are positioned on.
    Segment {
        index: usize,
        start: f64,
        end: f64,
        virtual_offset: f64,
    },
    /// An inserted intro or outro slide (`position`). It takes no virtual
    /// time, so it doesn't move anything on the virtual timeline.
    Slide {
        position: String,
        image_path: String,
        duration: f64,
    },
}

impl ExportPiece {
    fn duration(&self) -> f64 {
        match self {
            ExportPiece::Segment { start, end, .. } => (end - start).max(0.0),
            ExportPiece::Slide { duration, .. } => *duration,
        }
    }
}

/// The lesson's pieces in play order: an inserted intro, every segment,
/// then an inserted outro. Overlay-mode slides aren't pieces (see
/// `overlay_slide_windows`).
fn build_export_pieces(segments: &[SegmentBounds], slides: &[db::LessonSlideRow]) -> Vec<ExportPiece> {
    let inserted = |position: &str| {
        slides
            .iter()
            .find(|slide| slide.mode == "insert" && slide.position == position)
            .map(|slide| ExportPiece::Slide {
                position: slide.position.clone(),
                image_path: slide.image_path.clone(),
                duration: slide.duration,
            })
    };
    let mut pieces: Vec<ExportPiece> = inserted("intro").into_iter().collect();
    let mut virtual_offset = 0.0;
    for (index, segment) in segments.iter().enumerate() {
        pieces.push(ExportPiece::Segment {
            index,
            start: segment.start,
            end: segment.end,
            virtual_offset,
        });
        virtual_offset += (segment.end - segment.start).max(0.0);
    }
    pieces.extend(inserted("outro"));
    pieces
}

/// An overlay-mode slide's window on the virtual timeline.
#[derive(Debug, Clone, PartialEq)]
struct SlideWindow {
    image_path: String,
    start: f64,
    end: f64,
    mute: bool,
}

/// Where each overlay-mode slide shows on a lesson `lesson_length` seconds
/// long: an intro covers `[0, N)`, an outro `[L - N, L)`, with `N` clamped
/// to the lesson's length.
fn overlay_slide_windows(slides: &[db::LessonSlideRow], lesson_length: f64) -> Vec<SlideWindow> {
    if lesson_length <= 0.0 {
        return Vec::new();
    }
    slides
        .iter()
        .filter(|slide| slide.mode == "overlay")
        .map(|slide| {
            let length = slide.duration.min(lesson_length);
            let (start, end) = if slide.position == "intro" {
                (0.0, length)
            } else {
                (lesson_length - length, lesson_length)
            };
            SlideWindow {
                image_path: slide.image_path.clone(),
                start,
                end,
                mute: slide.mute_audio,
            }
        })
        .collect()
}

/// The overlay-mode slides and mute windows that fall in one segment's
/// slice of the virtual timeline, translated to cut-relative seconds and
/// clipped, the same mapping `overlays_for_segment` does (an outro can
/// span segment boundaries). Mutes are dropped when the source has no
/// audio, since there's nothing to filter.
fn slides_for_segment(
    windows: &[SlideWindow],
    segment_offset: f64,
    segment_length: f64,
    source_has_audio: bool,
) -> crate::ffmpeg::CutExtras {
    let mut extras = crate::ffmpeg::CutExtras::default();
    for window in windows {
        let local_start = (window.start - segment_offset).max(0.0);
        let local_end = (window.end - segment_offset).min(segment_length);
        if local_end <= local_start {
            continue;
        }
        extras.slides.push(crate::ffmpeg::SegmentSlide {
            image_path: window.image_path.clone(),
            start: local_start,
            end: local_end,
        });
        if window.mute && source_has_audio {
            extras.mute_windows.push((local_start, local_end));
        }
    }
    extras
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
/// A single-segment lesson with no inserted slide (the common case) takes a
/// fast path: `export_lesson` cuts straight to `job.output_path`, with no
/// intermediate temp file and no concat step, so it produces exactly the
/// same output as before multi-segment export existed (no extra
/// re-mux/quality loss).
///
/// Otherwise the lesson is laid out as pieces (`build_export_pieces`): an
/// inserted intro, each segment, an inserted outro. Each piece is encoded to
/// its own temp file under `segment_temp_dir`, then they're concatenated
/// via `ffmpeg::concat_videos` (a stream-copy concat: every segment piece is
/// encoded by the same `export_lesson`/libx264/aac settings, and when there
/// is an inserted slide every piece, slide or segment, also gets the
/// source's probed `StreamParams` pinned so the slide pieces match).
/// Temp files (and their directory) are removed once the concat succeeds,
/// and also on a mid-job failure/cancellation — the loop below cleans up
/// whatever was encoded so far before returning `Err`, so a failed or
/// cancelled export never leaves stray piece files behind.
///
/// Overlay-mode slides aren't pieces: each segment gets the slice of their
/// windows that falls inside it (`slides_for_segment`), composited
/// full-frame on top of everything, with the lecture audio muted there if
/// asked. With no slides at all, nothing here is probed and every ffmpeg
/// invocation is exactly what it was before slides existed.
///
/// When the lesson has an AI voice switched on for exports (`lesson_voice`),
/// the video is first written to a temp file, then one more pass swaps its
/// sound for the voice track (`ffmpeg::mux_voice_track`). A voice that no
/// longer matches the lesson fails the export with a clear message instead.
async fn do_export(app: &AppHandle, job: &PendingExport) -> Result<(), String> {
    let voice = {
        let conn = app.state::<DbConnection>();
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        crate::voice::voice_track_for_export(&guard, &job.lesson_id)?
    };
    let Some(voice) = voice else {
        return export_video(app, job, &job.output_path).await;
    };

    let temp_dir = segment_temp_dir(app, &job.id)?;
    let silent_path = temp_dir.join("before-voice.mp4");
    let Some(silent) = silent_path.to_str().map(str::to_string) else {
        return Err("export temp path is not valid UTF-8".to_string());
    };
    let cleanup = || {
        let _ = std::fs::remove_file(&silent);
        let _ = std::fs::remove_dir(&temp_dir);
    };
    if let Err(err) = export_video(app, job, &silent).await {
        cleanup();
        return Err(err);
    }
    if is_cancelled(app, &job.id) {
        cleanup();
        return Err("export cancelled".to_string());
    }

    let slides = {
        let conn = app.state::<DbConnection>();
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        db::query_lesson_slides(&guard, &job.lesson_id)?
    };
    let lesson_length: f64 = job
        .segments
        .iter()
        .map(|segment| (segment.end - segment.start).max(0.0))
        .sum();
    let (delay, mutes, total) = voice_placement(&slides, lesson_length);
    let result = crate::ffmpeg::mux_voice_track(
        app,
        &silent,
        &voice.path,
        &job.output_path,
        delay,
        &mutes,
        total,
        register_child_closure(app, &job.id),
        |_| {},
    )
    .await;
    deregister_child(app, &job.id);
    cleanup();
    result
}

/// Where the voice track (on the lesson's own timeline) goes in the export:
/// delayed by an inserted intro, silenced under overlay slides that mute
/// the lecture, and as long as the whole export (inserted outro included).
fn voice_placement(slides: &[db::LessonSlideRow], lesson_length: f64) -> (f64, Vec<(f64, f64)>, f64) {
    let inserted = |position: &str| {
        slides
            .iter()
            .find(|slide| slide.mode == "insert" && slide.position == position)
            .map_or(0.0, |slide| slide.duration.max(0.0))
    };
    let delay = inserted("intro");
    let mutes = overlay_slide_windows(slides, lesson_length)
        .into_iter()
        .filter(|window| window.mute)
        .map(|window| (window.start, window.end))
        .collect();
    (delay, mutes, delay + lesson_length + inserted("outro"))
}

/// The video part of `do_export`, written to `output_path`.
async fn export_video(app: &AppHandle, job: &PendingExport, output_path: &str) -> Result<(), String> {
    if job.segments.is_empty() {
        return Err(format!(
            "lesson {} has no segments to export",
            job.lesson_id
        ));
    }

    let slides = {
        let conn = app.state::<DbConnection>();
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        db::query_lesson_slides(&guard, &job.lesson_id)?
    };
    let has_inserted_slide = slides.iter().any(|slide| slide.mode == "insert");
    // Only probed when there are slides: whether there's audio to mute, and
    // the params inserted slide pieces must match.
    let stream = if slides.is_empty() {
        None
    } else {
        Some(crate::ffmpeg::probe_stream_params(app, &job.video_path).await?)
    };
    let source_has_audio = stream.as_ref().is_some_and(|stream| stream.audio.is_some());
    let lesson_length: f64 = job
        .segments
        .iter()
        .map(|segment| (segment.end - segment.start).max(0.0))
        .sum();
    let windows = overlay_slide_windows(&slides, lesson_length);

    if job.segments.len() == 1 && !has_inserted_slide {
        let segment = &job.segments[0];
        let (overlays, regions, crop) = {
            let conn = app.state::<DbConnection>();
            let guard = conn.0.lock().map_err(|err| err.to_string())?;
            // A single-segment lesson's one segment starts at virtual t=0 —
            // it *is* the whole lesson's timeline.
            let length = (segment.end - segment.start).max(0.0);
            (
                overlays_for_segment(&guard, &job.lesson_id, 0.0, length)?,
                regions_for_segment(&guard, &job.lesson_id, 0.0, length)?,
                crop_for_lesson(&guard, &job.lesson_id)?,
            )
        };
        let mut extras = slides_for_segment(&windows, 0.0, lesson_length, source_has_audio);
        extras.single_audio = !slides.is_empty();
        extras.crop = crop;
        let register_child = register_child_closure(app, &job.id);
        let on_progress = progress_closure(app, &job.id, 0.0, 1.0, 1.0);
        let result = crate::ffmpeg::export_lesson(
            app,
            &job.video_path,
            segment.start,
            segment.end,
            output_path,
            &overlays,
            &regions,
            &extras,
            register_child,
            on_progress,
        )
        .await;
        deregister_child(app, &job.id);
        return result;
    }

    // Inserted slide pieces are fitted to the lecture's frame and encoded
    // with its stream params; segment pieces get the same params pinned.
    let insert_params = match (&stream, has_inserted_slide) {
        (Some(stream), true) => Some((
            stream.clone(),
            crate::ffmpeg::probe_dimensions(app, &job.video_path).await?,
        )),
        _ => None,
    };
    let pieces = build_export_pieces(&job.segments, &slides);
    let total_duration: f64 = pieces.iter().map(ExportPiece::duration).sum();
    let temp_dir = segment_temp_dir(app, &job.id)?;
    let mut temp_paths: Vec<String> = Vec::new();
    // Output seconds encoded so far, slides included (for progress).
    let mut elapsed = 0.0;

    for piece in &pieces {
        if is_cancelled(app, &job.id) {
            cleanup_segment_temp_files(&temp_dir, &temp_paths);
            return Err("export cancelled".to_string());
        }

        let file_name = match piece {
            ExportPiece::Segment { index, .. } => format!("segment-{index}.mp4"),
            ExportPiece::Slide { position, .. } => format!("{position}.mp4"),
        };
        let temp_path = temp_dir.join(file_name);
        let Some(temp_path_str) = temp_path.to_str().map(str::to_string) else {
            cleanup_segment_temp_files(&temp_dir, &temp_paths);
            return Err("segment temp path is not valid UTF-8".to_string());
        };
        let piece_duration = piece.duration();
        let result = encode_piece(
            app,
            job,
            piece,
            &temp_path_str,
            &windows,
            source_has_audio,
            !slides.is_empty(),
            insert_params.as_ref(),
            progress_closure(app, &job.id, elapsed, piece_duration, total_duration),
        )
        .await;
        deregister_child(app, &job.id);

        if let Err(err) = result {
            // This piece's own (possibly partial) temp file too, not just
            // the ones from prior pieces.
            let _ = std::fs::remove_file(&temp_path_str);
            cleanup_segment_temp_files(&temp_dir, &temp_paths);
            return Err(err);
        }

        temp_paths.push(temp_path_str);
        elapsed += piece_duration;
    }

    if is_cancelled(app, &job.id) {
        cleanup_segment_temp_files(&temp_dir, &temp_paths);
        return Err("export cancelled".to_string());
    }

    let register_child = register_child_closure(app, &job.id);
    let concat_result =
        crate::ffmpeg::concat_videos(app, &temp_paths, output_path, register_child).await;
    deregister_child(app, &job.id);

    cleanup_segment_temp_files(&temp_dir, &temp_paths);

    concat_result
}

/// Encodes one `ExportPiece` of a concatenated export to `temp_path`. A
/// segment piece gets the lesson's crop, and the overlays, shapes and
/// overlay-mode slides of its own slice of the virtual timeline
/// (`virtual_offset`, which doesn't count inserted slides), plus `insert_params`' stream params when the export has
/// an inserted slide; `any_slides` maps only the first audio track (see
/// `CutExtras::single_audio`). A slide piece needs `insert_params`, which is
/// set whenever one exists.
#[allow(clippy::too_many_arguments)]
async fn encode_piece(
    app: &AppHandle,
    job: &PendingExport,
    piece: &ExportPiece,
    temp_path: &str,
    windows: &[SlideWindow],
    source_has_audio: bool,
    any_slides: bool,
    insert_params: Option<&(crate::ffmpeg::StreamParams, (u32, u32))>,
    on_progress: impl FnMut(f64) + Send,
) -> Result<(), String> {
    let register_child = register_child_closure(app, &job.id);
    match piece {
        ExportPiece::Segment {
            start,
            end,
            virtual_offset,
            ..
        } => {
            let length = (end - start).max(0.0);
            let (overlays, regions, crop) = {
                let conn = app.state::<DbConnection>();
                let guard = conn.0.lock().map_err(|err| err.to_string())?;
                (
                    overlays_for_segment(&guard, &job.lesson_id, *virtual_offset, length)?,
                    regions_for_segment(&guard, &job.lesson_id, *virtual_offset, length)?,
                    crop_for_lesson(&guard, &job.lesson_id)?,
                )
            };
            let mut extras = slides_for_segment(windows, *virtual_offset, length, source_has_audio);
            extras.stream = insert_params.map(|(stream, _)| stream.clone());
            extras.single_audio = any_slides;
            extras.crop = crop;
            crate::ffmpeg::export_lesson(
                app,
                &job.video_path,
                *start,
                *end,
                temp_path,
                &overlays,
                &regions,
                &extras,
                register_child,
                on_progress,
            )
            .await
        }
        ExportPiece::Slide {
            image_path,
            duration,
            ..
        } => {
            let (stream, main_dims) =
                insert_params.expect("an inserted slide piece always comes with insert params");
            crate::ffmpeg::export_slide_piece(
                app,
                image_path,
                *duration,
                temp_path,
                *main_dims,
                stream,
                register_child,
                on_progress,
            )
            .await
        }
    }
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

#[cfg(test)]
mod overlays_for_segment_tests {
    use super::*;

    /// In-memory, fully-migrated DB seeded with one project/video/lesson —
    /// `frame_overlays` is lesson-scoped since 0009, with `start`/`end` in
    /// virtual (stitched-lesson) seconds, not the segment's own real bounds.
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
            "INSERT INTO lessons (id, video_id, title, start, end) VALUES ('l1', 'v1', 'Lesson', 0, 0)",
            [],
        )
        .unwrap();

        conn
    }

    fn insert_overlay(conn: &Connection, id: &str, image_path: &str, start: f64, end: f64) {
        conn.execute(
            "INSERT INTO frame_overlays (id, video_id, lesson_id, image_path, start, end, created_at)
             VALUES (?1, 'v1', 'l1', ?2, ?3, ?4, 't')",
            params![id, image_path, start, end],
        )
        .unwrap();
    }

    /// A segment whose virtual slice is `[10, 20)` — i.e. 10 seconds of
    /// earlier segments already played (`segment_offset: 10.0`) before this
    /// one's own 10-second length.
    const SEGMENT_OFFSET: f64 = 10.0;
    const SEGMENT_LENGTH: f64 = 10.0;

    #[test]
    fn overlay_fully_inside_the_segment_is_returned_unclipped() {
        let conn = seeded_conn();
        // Virtual [12, 15) falls entirely inside this segment's virtual
        // slice [10, 20).
        insert_overlay(&conn, "o1", "/tmp/img.png", 12.0, 15.0);

        let overlays = overlays_for_segment(&conn, "l1", SEGMENT_OFFSET, SEGMENT_LENGTH).unwrap();

        assert_eq!(overlays.len(), 1);
        assert_eq!(overlays[0].image_path, "/tmp/img.png");
        assert_eq!(overlays[0].start, 2.0);
        assert_eq!(overlays[0].end, 5.0);
        // `insert_overlay` omits `scale_percent`, relying on the column's
        // `DEFAULT 100` — asserting it here confirms the default actually
        // flows all the way through the query, not just that the schema has
        // one.
        assert_eq!(overlays[0].scale_percent, 100.0);
    }

    /// A non-default `scale_percent` is read back correctly, not silently
    /// hardcoded to 100 anywhere in the query/translation path.
    #[test]
    fn overlay_scale_percent_is_read_from_the_row() {
        let conn = seeded_conn();
        conn.execute(
            "INSERT INTO frame_overlays (id, video_id, lesson_id, image_path, start, end, scale_percent, created_at)
             VALUES ('o1', 'v1', 'l1', '/tmp/img.png', 12.0, 15.0, 40.0, 't')",
            [],
        )
        .unwrap();

        let overlays = overlays_for_segment(&conn, "l1", SEGMENT_OFFSET, SEGMENT_LENGTH).unwrap();

        assert_eq!(overlays.len(), 1);
        assert_eq!(overlays[0].scale_percent, 40.0);
    }

    /// The overlay only partially covers the segment's virtual slice (it
    /// starts before the slice and ends inside it) — the sub-window
    /// returned should be clipped to just the overlapping part, not the
    /// whole segment.
    #[test]
    fn overlay_spanning_a_segment_boundary_is_clipped_to_the_overlap() {
        let conn = seeded_conn();
        insert_overlay(&conn, "o1", "/tmp/img.png", 5.0, 15.0);

        let overlays = overlays_for_segment(&conn, "l1", SEGMENT_OFFSET, SEGMENT_LENGTH).unwrap();

        assert_eq!(overlays.len(), 1);
        // Overlay covers virtual [5, 15); this segment's virtual slice is
        // [10, 20), so the overlap translated to segment-relative real time
        // is [0, 5).
        assert_eq!(overlays[0].start, 0.0);
        assert_eq!(overlays[0].end, 5.0);
    }

    /// An overlay spanning *two adjacent* segments (the scenario the whole
    /// lesson-scoped/virtual-time rework exists for) produces two correctly
    /// clipped ranges, one per segment call — mirrors what `do_export`'s
    /// multi-segment loop actually does, one `overlays_for_segment` call
    /// per segment with its own running `elapsed` offset.
    #[test]
    fn overlay_spanning_two_segments_is_clipped_per_segment() {
        let conn = seeded_conn();
        // Segment A: virtual [0, 10). Segment B: virtual [10, 20) (matches
        // SEGMENT_OFFSET/LENGTH above). Overlay covers virtual [8, 14).
        insert_overlay(&conn, "o1", "/tmp/img.png", 8.0, 14.0);

        let in_a = overlays_for_segment(&conn, "l1", 0.0, 10.0).unwrap();
        assert_eq!(in_a.len(), 1);
        assert_eq!(in_a[0].start, 8.0);
        assert_eq!(in_a[0].end, 10.0);

        let in_b = overlays_for_segment(&conn, "l1", SEGMENT_OFFSET, SEGMENT_LENGTH).unwrap();
        assert_eq!(in_b.len(), 1);
        assert_eq!(in_b[0].start, 0.0);
        assert_eq!(in_b[0].end, 4.0);
    }

    #[test]
    fn overlay_outside_the_segment_is_excluded() {
        let conn = seeded_conn();
        insert_overlay(&conn, "o1", "/tmp/img.png", 0.0, 5.0);

        let overlays = overlays_for_segment(&conn, "l1", SEGMENT_OFFSET, SEGMENT_LENGTH).unwrap();

        assert!(overlays.is_empty());
    }

    #[test]
    fn overlay_for_a_different_lesson_is_excluded() {
        let conn = seeded_conn();
        conn.execute(
            "INSERT INTO lessons (id, video_id, title, start, end) VALUES ('l2', 'v1', 'Other', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO frame_overlays (id, video_id, lesson_id, image_path, start, end, created_at)
             VALUES ('o1', 'v1', 'l2', '/tmp/img.png', 12.0, 15.0, 't')",
            [],
        )
        .unwrap();

        let overlays = overlays_for_segment(&conn, "l1", SEGMENT_OFFSET, SEGMENT_LENGTH).unwrap();

        assert!(overlays.is_empty());
    }
}

#[cfg(test)]
mod regions_for_segment_tests {
    use super::*;
    use crate::ffmpeg::{RegionFill, RegionShape};

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
        for id in ["l1", "l2"] {
            conn.execute(
                "INSERT INTO lessons (id, video_id, title, start, end) VALUES (?1, 'v1', 'Lesson', 0, 0)",
                params![id],
            )
            .unwrap();
        }
        conn
    }

    fn insert_region(conn: &Connection, id: &str, lesson: &str, start: f64, end: f64, shape: &str, fill: &str) {
        conn.execute(
            "INSERT INTO lesson_regions (id, lesson_id, start, end, x_percent, y_percent, w_percent, h_percent,
                                         shape, fill, blur_strength, color, created_at)
             VALUES (?1, ?2, ?3, ?4, 10, 20, 30, 40, ?5, ?6, 15, '#ff0000', 't')",
            params![id, lesson, start, end, shape, fill],
        )
        .unwrap();
    }

    // Segment whose virtual slice is [10, 20).
    const OFFSET: f64 = 10.0;
    const LENGTH: f64 = 10.0;

    #[test]
    fn region_inside_the_segment_is_translated_and_parsed() {
        let conn = seeded_conn();
        insert_region(&conn, "r1", "l1", 12.0, 15.0, "ellipse", "solid");
        let regions = regions_for_segment(&conn, "l1", OFFSET, LENGTH).unwrap();
        assert_eq!(regions.len(), 1);
        assert_eq!((regions[0].start, regions[0].end), (2.0, 5.0));
        assert_eq!(regions[0].shape, RegionShape::Ellipse);
        assert_eq!(regions[0].fill, RegionFill::Solid("#ff0000".into()));
        assert_eq!(
            (regions[0].x_percent, regions[0].y_percent, regions[0].w_percent, regions[0].h_percent),
            (10.0, 20.0, 30.0, 40.0)
        );
        assert_eq!(regions[0].blur_strength, 15);
    }

    #[test]
    fn region_spanning_two_segments_is_clipped_per_segment() {
        let conn = seeded_conn();
        insert_region(&conn, "r1", "l1", 7.0, 13.0, "rounded", "blur");
        // First segment: virtual [0, 10).
        let first = regions_for_segment(&conn, "l1", 0.0, 10.0).unwrap();
        assert_eq!((first[0].start, first[0].end), (7.0, 10.0));
        assert_eq!((first[0].shape, &first[0].fill), (RegionShape::Rounded, &RegionFill::Blur));
        // Second segment: virtual [10, 20) -> local [0, 3).
        let second = regions_for_segment(&conn, "l1", OFFSET, LENGTH).unwrap();
        assert_eq!((second[0].start, second[0].end), (0.0, 3.0));
    }

    #[test]
    fn regions_outside_the_segment_or_in_other_lessons_are_excluded() {
        let conn = seeded_conn();
        insert_region(&conn, "before", "l1", 2.0, 10.0, "rect", "blur"); // ends exactly at the start
        insert_region(&conn, "after", "l1", 20.0, 25.0, "rect", "blur"); // starts exactly at the end
        insert_region(&conn, "other", "l2", 12.0, 15.0, "rect", "blur");
        assert!(regions_for_segment(&conn, "l1", OFFSET, LENGTH).unwrap().is_empty());
    }

    #[test]
    fn unknown_enum_values_are_an_error_not_a_silent_skip() {
        let conn = seeded_conn();
        insert_region(&conn, "r1", "l1", 12.0, 15.0, "star", "blur");
        assert!(regions_for_segment(&conn, "l1", OFFSET, LENGTH).is_err());
        let conn = seeded_conn();
        insert_region(&conn, "r1", "l1", 12.0, 15.0, "rect", "pixelate");
        assert!(regions_for_segment(&conn, "l1", OFFSET, LENGTH).is_err());
    }

    #[test]
    fn crop_is_loaded_only_while_enabled() {
        let conn = seeded_conn();
        assert_eq!(crop_for_lesson(&conn, "l1").unwrap(), None);
        let mut input = crate::db::CropInput {
            enabled: false,
            x_percent: 10.0,
            y_percent: 20.0,
            w_percent: 40.0,
            h_percent: 50.0,
            bg_color: "#123456".into(),
            padding_percent: 4.0,
            shadow_enabled: true,
            shadow_blur: 12,
            shadow_opacity: 0.25,
            shadow_offset_y: -3,
        };
        crate::db::upsert_lesson_crop_for_test(&conn, "l1", &input).unwrap();
        assert_eq!(crop_for_lesson(&conn, "l1").unwrap(), None);
        input.enabled = true;
        crate::db::upsert_lesson_crop_for_test(&conn, "l1", &input).unwrap();
        let crop = crop_for_lesson(&conn, "l1").unwrap().unwrap();
        assert_eq!((crop.x_percent, crop.w_percent, crop.padding_percent), (10.0, 40.0, 4.0));
        assert_eq!(crop.bg_color, "#123456");
        assert_eq!(crop.shadow, Some(crate::ffmpeg::CropShadow { blur: 12, opacity: 0.25, offset_y: -3 }));
        input.shadow_enabled = false;
        crate::db::upsert_lesson_crop_for_test(&conn, "l1", &input).unwrap();
        assert_eq!(crop_for_lesson(&conn, "l1").unwrap().unwrap().shadow, None);
        assert_eq!(crop_for_lesson(&conn, "l2").unwrap(), None);
    }

    /// Not a real test: dumps the exact per-segment ffmpeg arg lists
    /// `do_export` would run for a 2-segment lesson with a blurred ellipse
    /// crossing the segment boundary, a solid rounded rect and an image
    /// overlay, so they can be run against the real sidecar ffmpeg. Run with
    /// `CC_VIDEO=... CC_IMAGE=... CC_OUT=<dir> cargo test --lib dump_cli_check_args -- --ignored`.
    /// Dimensions are passed in (`CC_DIMS=1440x774`, `CC_IMAGE_DIMS=WxH`)
    /// since there's no AppHandle to probe with here. `CC_CROP=1` adds an
    /// enabled crop with the default background, padding and shadow.
    #[test]
    #[ignore]
    fn dump_cli_check_args() {
        let env = |key: &str| std::env::var(key).unwrap_or_else(|_| panic!("set {key}"));
        let dims = |value: String| -> (u32, u32) {
            let (w, h) = value.split_once('x').unwrap();
            (w.parse().unwrap(), h.parse().unwrap())
        };
        let (video, image, out_dir) = (env("CC_VIDEO"), env("CC_IMAGE"), env("CC_OUT"));
        let (main_dims, image_dims) = (dims(env("CC_DIMS")), dims(env("CC_IMAGE_DIMS")));

        let conn = seeded_conn();
        let region = |start: f64, end: f64, rect: (f64, f64, f64, f64), shape: &str, fill: &str, color: &str| {
            let input = crate::db::RegionInput {
                start,
                end,
                x_percent: rect.0,
                y_percent: rect.1,
                w_percent: rect.2,
                h_percent: rect.3,
                shape: shape.into(),
                fill: fill.into(),
                blur_strength: 25,
                color: color.into(),
            };
            crate::db::add_lesson_region_for_test(&conn, "l1", &input).unwrap();
        };
        // Virtual timeline: segment A = source [30, 40) -> virtual [0, 10),
        // segment B = source [100, 110) -> virtual [10, 20).
        region(5.0, 13.0, (5.0, 5.0, 40.0, 30.0), "ellipse", "blur", "#000000");
        region(14.0, 18.0, (55.0, 10.0, 35.0, 25.0), "rounded", "solid", "#e11d48");
        conn.execute(
            "INSERT INTO frame_overlays (id, video_id, lesson_id, image_path, start, end, scale_percent, x_percent, y_percent, created_at)
             VALUES ('o1', 'v1', 'l1', ?1, 16.0, 19.0, 30, 100, 100, 't')",
            params![image],
        )
        .unwrap();

        if std::env::var("CC_CROP").is_ok() {
            let crop = crate::db::CropInput {
                enabled: true,
                x_percent: 10.0,
                y_percent: 5.0,
                w_percent: 45.0,
                h_percent: 80.0,
                bg_color: "#0B1F3A".into(),
                padding_percent: 6.0,
                shadow_enabled: true,
                shadow_blur: 24,
                shadow_opacity: 0.5,
                shadow_offset_y: 8,
            };
            crate::db::upsert_lesson_crop_for_test(&conn, "l1", &crop).unwrap();
        }
        let extras = crate::ffmpeg::CutExtras {
            crop: crop_for_lesson(&conn, "l1").unwrap(),
            ..crate::ffmpeg::CutExtras::default()
        };

        let mut offset = 0.0;
        let mut lines = Vec::new();
        for (index, (start, end)) in [(30.0, 40.0), (100.0, 110.0)].into_iter().enumerate() {
            let length: f64 = end - start;
            let overlays = overlays_for_segment(&conn, "l1", offset, length).unwrap();
            let regions = regions_for_segment(&conn, "l1", offset, length).unwrap();
            let overlay_dims = vec![image_dims; overlays.len()];
            let output = format!("{out_dir}/segment-{index}.mp4");
            let args = crate::ffmpeg::lesson_cut_args(
                &video,
                start,
                end,
                &output,
                &overlays,
                &overlay_dims,
                &regions,
                main_dims,
                &extras,
                &[],
            );
            lines.push(serde_json::to_string(&args).unwrap());
            offset += length;
        }
        std::fs::write(format!("{out_dir}/args.jsonl"), lines.join("\n") + "\n").unwrap();
    }
}

#[cfg(test)]
mod slide_export_tests {
    use super::*;
    use crate::ffmpeg::SegmentSlide;

    fn slide(position: &str, mode: &str, duration: f64, mute: bool) -> db::LessonSlideRow {
        db::LessonSlideRow {
            id: format!("{position}-id"),
            lesson_id: "l1".into(),
            position: position.into(),
            mode: mode.into(),
            duration,
            kind: "image".into(),
            image_path: format!("/img/{position}.png"),
            title: String::new(),
            subtitle: String::new(),
            bg_color: "#111827".into(),
            text_color: "#ffffff".into(),
            mute_audio: mute,
            created_at: "t".into(),
        }
    }

    #[test]
    fn voice_follows_inserted_slides_and_muted_overlays() {
        assert_eq!(voice_placement(&[], 10.0), (0.0, vec![], 10.0));
        let slides = [slide("intro", "insert", 3.0, false), slide("outro", "insert", 2.0, false)];
        assert_eq!(voice_placement(&slides, 10.0), (3.0, vec![], 15.0));
        let slides = [slide("intro", "overlay", 4.0, true), slide("outro", "overlay", 2.0, false)];
        assert_eq!(voice_placement(&slides, 10.0), (0.0, vec![(0.0, 4.0)], 10.0));
    }

    fn segments() -> Vec<SegmentBounds> {
        // Virtual [0, 10) then [10, 15).
        vec![SegmentBounds { start: 30.0, end: 40.0 }, SegmentBounds { start: 100.0, end: 105.0 }]
    }

    fn segment_piece(index: usize, start: f64, end: f64, virtual_offset: f64) -> ExportPiece {
        ExportPiece::Segment {
            index,
            start,
            end,
            virtual_offset,
        }
    }

    fn slide_piece(position: &str, duration: f64) -> ExportPiece {
        ExportPiece::Slide {
            position: position.into(),
            image_path: format!("/img/{position}.png"),
            duration,
        }
    }

    #[test]
    fn no_slides_is_one_piece_per_segment() {
        assert_eq!(
            build_export_pieces(&segments(), &[]),
            [segment_piece(0, 30.0, 40.0, 0.0), segment_piece(1, 100.0, 105.0, 10.0)]
        );
    }

    /// Intro, then the segments, then the outro, whatever order the rows
    /// come in. Inserted slides take no virtual time: the segments keep
    /// their offsets.
    #[test]
    fn inserted_slides_wrap_the_segments() {
        let slides = [slide("outro", "insert", 2.0, false), slide("intro", "insert", 3.0, false)];
        let pieces = build_export_pieces(&segments(), &slides);
        assert_eq!(
            pieces,
            [
                slide_piece("intro", 3.0),
                segment_piece(0, 30.0, 40.0, 0.0),
                segment_piece(1, 100.0, 105.0, 10.0),
                slide_piece("outro", 2.0),
            ]
        );
        let total: f64 = pieces.iter().map(ExportPiece::duration).sum();
        assert_eq!(total, 3.0 + 15.0 + 2.0, "progress counts the slide seconds");
    }

    #[test]
    fn overlay_slides_are_not_pieces() {
        let slides = [slide("intro", "overlay", 3.0, true), slide("outro", "insert", 2.0, false)];
        assert_eq!(
            build_export_pieces(&segments(), &slides),
            [segment_piece(0, 30.0, 40.0, 0.0), segment_piece(1, 100.0, 105.0, 10.0), slide_piece("outro", 2.0)]
        );
    }

    #[test]
    fn overlay_windows_sit_at_the_ends_and_clamp() {
        let slides = [
            slide("intro", "overlay", 4.0, true),
            slide("outro", "overlay", 6.0, false),
            slide("intro", "insert", 3.0, false),
        ];
        let windows = overlay_slide_windows(&slides, 15.0);
        assert_eq!(windows.len(), 2, "inserted slides have no window");
        assert_eq!((windows[0].start, windows[0].end, windows[0].mute), (0.0, 4.0, true));
        assert_eq!((windows[1].start, windows[1].end, windows[1].mute), (9.0, 15.0, false));

        // Longer than the lesson: the whole lesson.
        let long = [slide("intro", "overlay", 40.0, false), slide("outro", "overlay", 40.0, false)];
        let windows = overlay_slide_windows(&long, 15.0);
        assert_eq!((windows[0].start, windows[0].end), (0.0, 15.0));
        assert_eq!((windows[1].start, windows[1].end), (0.0, 15.0));

        assert!(overlay_slide_windows(&long, 0.0).is_empty());
    }

    #[test]
    fn intro_window_maps_onto_the_first_segment_only() {
        let windows = overlay_slide_windows(&[slide("intro", "overlay", 4.0, true)], 15.0);
        let first = slides_for_segment(&windows, 0.0, 10.0, true);
        assert_eq!(
            first.slides,
            [SegmentSlide { image_path: "/img/intro.png".into(), start: 0.0, end: 4.0 }]
        );
        assert_eq!(first.mute_windows, [(0.0, 4.0)]);
        assert!(first.stream.is_none());
        let second = slides_for_segment(&windows, 10.0, 5.0, true);
        assert!(second.slides.is_empty() && second.mute_windows.is_empty());
    }

    /// A 6 s outro on a 10 s + 5 s lesson covers virtual [9, 15): the last
    /// second of segment 0 and all of segment 1.
    #[test]
    fn outro_window_spans_a_segment_boundary() {
        let windows = overlay_slide_windows(&[slide("outro", "overlay", 6.0, true)], 15.0);
        let first = slides_for_segment(&windows, 0.0, 10.0, true);
        assert_eq!((first.slides[0].start, first.slides[0].end), (9.0, 10.0));
        assert_eq!(first.mute_windows, [(9.0, 10.0)]);
        let second = slides_for_segment(&windows, 10.0, 5.0, true);
        assert_eq!((second.slides[0].start, second.slides[0].end), (0.0, 5.0));
        assert_eq!(second.mute_windows, [(0.0, 5.0)]);
    }

    #[test]
    fn mute_is_dropped_without_source_audio_and_absent_unless_asked() {
        let muted = overlay_slide_windows(&[slide("intro", "overlay", 4.0, true)], 15.0);
        let extras = slides_for_segment(&muted, 0.0, 10.0, false);
        assert_eq!(extras.slides.len(), 1);
        assert!(extras.mute_windows.is_empty());

        let unmuted = overlay_slide_windows(&[slide("intro", "overlay", 4.0, false)], 15.0);
        assert!(slides_for_segment(&unmuted, 0.0, 10.0, true).mute_windows.is_empty());
    }

    /// Not a real test: dumps the exact ffmpeg arg lists `do_export` would
    /// run for the two CLI verification cases of the intro/outro feature.
    /// (a) a 2-segment lesson with an inserted image intro, an inserted
    /// title-card outro and a blurred shape crossing the segment boundary;
    /// (b) a single-segment lesson with a muted overlay-mode intro. Run with
    /// `CC_VIDEO=... CC_INTRO=... CC_OUTRO=... CC_STREAM_JSON=<ffprobe json>
    /// CC_DIMS=WxH CC_INTRO_DIMS=WxH CC_OUTRO_DIMS=WxH CC_OUT=<dir> cargo test
    /// --lib dump_slide_cli_args -- --ignored`. Writes `<dir>/a.jsonl` and
    /// `<dir>/b.jsonl`, one `[name, args]` per piece in order.
    #[test]
    #[ignore]
    fn dump_slide_cli_args() {
        let env = |key: &str| std::env::var(key).unwrap_or_else(|_| panic!("set {key}"));
        let dims = |value: String| -> (u32, u32) {
            let (w, h) = value.split_once('x').unwrap();
            (w.parse().unwrap(), h.parse().unwrap())
        };
        let (video, intro, outro, out_dir) = (env("CC_VIDEO"), env("CC_INTRO"), env("CC_OUTRO"), env("CC_OUT"));
        let main_dims = dims(env("CC_DIMS"));
        let image_dims = |path: &str| if path == intro { dims(env("CC_INTRO_DIMS")) } else { dims(env("CC_OUTRO_DIMS")) };
        let stream = crate::ffmpeg::parse_stream_params(&std::fs::read_to_string(env("CC_STREAM_JSON")).unwrap()).unwrap();

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        db::migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'T', 't', 't');
             INSERT INTO videos (id, project_id, file_path, created_at, updated_at) VALUES ('v1', 'p1', '/v', 't', 't');
             INSERT INTO lessons (id, video_id, title, start, end) VALUES ('la', 'v1', 'A', 0, 0);
             INSERT INTO lessons (id, video_id, title, start, end) VALUES ('lb', 'v1', 'B', 0, 0);",
        )
        .unwrap();
        let insert_slide = |lesson: &str, position: &str, mode: &str, duration: f64, kind: &str, path: &str, mute: bool| {
            conn.execute(
                "INSERT INTO lesson_slides (id, lesson_id, position, mode, duration, kind, image_path, title, mute_audio, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'T', ?8, 't')",
                params![format!("{lesson}-{position}"), lesson, position, mode, duration, kind, path, mute],
            )
            .unwrap();
        };
        insert_slide("la", "intro", "insert", 3.0, "image", &intro, false);
        insert_slide("la", "outro", "insert", 3.0, "title", &outro, false);
        insert_slide("lb", "intro", "overlay", 4.0, "title", &outro, true);
        // Case (a)'s shape: a blurred rect over virtual [5, 13), crossing the
        // boundary between segment A (virtual [0, 10)) and B ([10, 20)).
        conn.execute(
            "INSERT INTO lesson_regions (id, lesson_id, start, end, x_percent, y_percent, w_percent, h_percent,
                                         shape, fill, blur_strength, color, created_at)
             VALUES ('r1', 'la', 5, 13, 5, 5, 40, 30, 'rect', 'blur', 25, '#000000', 't')",
            [],
        )
        .unwrap();

        let cases: [(&str, Vec<SegmentBounds>); 2] = [
            ("a", vec![SegmentBounds { start: 30.0, end: 40.0 }, SegmentBounds { start: 100.0, end: 110.0 }]),
            ("b", vec![SegmentBounds { start: 60.0, end: 75.0 }]),
        ];
        for (name, segments) in cases {
            let lesson = format!("l{name}");
            let slides = db::query_lesson_slides(&conn, &lesson).unwrap();
            let has_inserted = slides.iter().any(|slide| slide.mode == "insert");
            let lesson_length: f64 = segments.iter().map(|segment| segment.end - segment.start).sum();
            let windows = overlay_slide_windows(&slides, lesson_length);
            let has_audio = stream.audio.is_some();
            let single = segments.len() == 1 && !has_inserted;
            let mut lines = Vec::new();
            for piece in build_export_pieces(&segments, &slides) {
                let (file, args) = match &piece {
                    ExportPiece::Segment { index, start, end, virtual_offset } => {
                        let length = end - start;
                        let overlays = overlays_for_segment(&conn, &lesson, *virtual_offset, length).unwrap();
                        let regions = regions_for_segment(&conn, &lesson, *virtual_offset, length).unwrap();
                        let mut extras = slides_for_segment(&windows, *virtual_offset, length, has_audio);
                        extras.stream = has_inserted.then(|| stream.clone());
                        extras.single_audio = !slides.is_empty();
                        let slide_dims: Vec<(u32, u32)> =
                            extras.slides.iter().map(|slide| image_dims(&slide.image_path)).collect();
                        let file = if single { format!("{out_dir}/{name}.mp4") } else { format!("{out_dir}/{name}-segment-{index}.mp4") };
                        let args = crate::ffmpeg::lesson_cut_args(
                            &video, *start, *end, &file, &overlays, &[], &regions, main_dims, &extras, &slide_dims,
                        );
                        (file, args)
                    }
                    ExportPiece::Slide { position, image_path, duration } => {
                        let (image_w, image_h) = image_dims(image_path);
                        let fit = crate::ffmpeg::fit_full_frame(main_dims.0, main_dims.1, image_w, image_h);
                        let file = format!("{out_dir}/{name}-{position}.mp4");
                        let args = crate::ffmpeg::slide_piece_args(image_path, *duration, &file, fit, main_dims, &stream);
                        (file, args)
                    }
                };
                lines.push(serde_json::to_string(&(file, args)).unwrap());
            }
            std::fs::write(format!("{out_dir}/{name}.jsonl"), lines.join("\n") + "\n").unwrap();
        }
    }
}
