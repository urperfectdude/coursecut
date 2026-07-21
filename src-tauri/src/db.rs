//! Rust-side SQLite access for coursecut, via a single `rusqlite`
//! connection opened at startup and stored in managed state. The frontend
//! has no direct SQL surface (see `capabilities/default.json`) — all
//! querying happens through this module's `#[tauri::command]`s.
//!
//! Migrations in `../migrations/` are applied here at startup, tracked via
//! `PRAGMA user_version` (one integer bump per migration, applied in
//! order).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Filename of the sqlite database, stored under the app's config dir.
const DB_FILENAME: &str = "coursecut.db";

/// Video file extensions accepted by import (PRD §7.2), lowercase.
/// Mirrored by `SUPPORTED_VIDEO_EXTENSIONS` in `src/db.ts` for dialog filters.
const SUPPORTED_EXTENSIONS: &[&str] = &["mp4", "mov", "mkv", "avi", "m4v"];

/// Managed state wrapping the single Rust-owned SQLite connection.
pub struct DbConnection(pub Mutex<Connection>);

#[derive(Debug, Serialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct Video {
    pub id: String,
    pub project_id: String,
    pub file_path: String,
    pub duration: Option<f64>,
    pub transcript_status: String,
    pub created_at: String,
    pub updated_at: String,
    /// Path to the cached extracted audio for this video, set once
    /// `extract_audio_for_video` succeeds (see `ffmpeg.rs`). Exposed to the
    /// frontend so a retry can tell whether extraction has already
    /// completed and skip straight to transcription.
    pub audio_path: Option<String>,
}

/// Resolves the on-disk path for the app's database: `app_config_dir()`
/// joined with the filename.
fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("could not resolve app config dir: {err}"))?;
    Ok(dir.join(DB_FILENAME))
}

/// Opens the app's `rusqlite` connection and applies any pending
/// migrations. Called once, at app setup, and stored in managed state.
pub fn open_connection(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("could not create app config dir: {err}"))?;
    }
    let conn = Connection::open(path).map_err(|err| format!("could not open database: {err}"))?;
    // SQLite disables FK enforcement per-connection by default; without this,
    // ON DELETE CASCADE in the schema silently does nothing on this connection.
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|err| format!("could not enable foreign keys: {err}"))?;
    migrate(&conn)?;
    Ok(conn)
}

/// Applies migrations from `../migrations/` that are newer than the
/// database's current `PRAGMA user_version`. Add one `if version < N`
/// block per migration file as they're introduced.
///
/// `pub(crate)` (rather than private) so `export.rs`'s tests can build a
/// fully-migrated in-memory connection the same way `db.rs`'s own tests do,
/// without duplicating the schema.
pub(crate) fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|err| format!("could not read schema version: {err}"))?;

    if version < 1 {
        conn.execute_batch(include_str!("../migrations/0001_init.sql"))
            .map_err(|err| format!("migration 0001_init failed: {err}"))?;
        conn.pragma_update(None, "user_version", 1)
            .map_err(|err| format!("could not update schema version: {err}"))?;
    }

    if version < 2 {
        conn.execute_batch(include_str!("../migrations/0002_video_audio_cache.sql"))
            .map_err(|err| format!("migration 0002_video_audio_cache failed: {err}"))?;
        conn.pragma_update(None, "user_version", 2)
            .map_err(|err| format!("could not update schema version: {err}"))?;
    }

    if version < 3 {
        conn.execute_batch(include_str!("../migrations/0003_lesson_ai_fields.sql"))
            .map_err(|err| format!("migration 0003_lesson_ai_fields failed: {err}"))?;
        conn.pragma_update(None, "user_version", 3)
            .map_err(|err| format!("could not update schema version: {err}"))?;
    }

    if version < 4 {
        conn.execute_batch(include_str!("../migrations/0004_app_settings.sql"))
            .map_err(|err| format!("migration 0004_app_settings failed: {err}"))?;
        conn.pragma_update(None, "user_version", 4)
            .map_err(|err| format!("could not update schema version: {err}"))?;
    }

    if version < 5 {
        conn.execute_batch(include_str!("../migrations/0005_export_queue_fields.sql"))
            .map_err(|err| format!("migration 0005_export_queue_fields failed: {err}"))?;
        conn.pragma_update(None, "user_version", 5)
            .map_err(|err| format!("could not update schema version: {err}"))?;
    }

    if version < 6 {
        conn.execute_batch(include_str!("../migrations/0006_lesson_segments.sql"))
            .map_err(|err| format!("migration 0006_lesson_segments failed: {err}"))?;
        conn.pragma_update(None, "user_version", 6)
            .map_err(|err| format!("could not update schema version: {err}"))?;
    }

    Ok(())
}

/// Whether `path` has one of the supported video extensions
/// (case-insensitive).
fn has_supported_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| SUPPORTED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Hard cap on directory recursion depth during import scans, as a
/// backstop against pathological trees (symlink cycles are already
/// excluded by the symlink check below).
const MAX_SCAN_DEPTH: u32 = 64;

/// Collects supported video files reachable from `path` into `out`:
/// directories are scanned recursively (children visited in sorted order,
/// for deterministic import order), plain files are accepted only with a
/// supported extension. Nonexistent and unreadable paths are skipped, not
/// errors — import is best-effort per PRD §7.2. Read-only: source files
/// are never copied, moved, or modified (non-destructive, PRD §17).
///
/// Symlinks (and Windows junctions) are skipped entirely: following them
/// can cycle back to an ancestor directory and recurse without bound, and
/// imported rows should reference real files.
fn collect_video_files(path: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() {
        return;
    }
    if meta.is_dir() {
        if depth >= MAX_SCAN_DEPTH {
            return;
        }
        let Ok(entries) = std::fs::read_dir(path) else {
            return;
        };
        let mut children: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
        children.sort();
        for child in children {
            collect_video_files(&child, depth + 1, out);
        }
    } else if meta.is_file() && has_supported_extension(path) {
        out.push(path.to_path_buf());
    }
}

/// Grants the webview's asset protocol (`convertFileSrc`, used by
/// `LessonEditorView` to play back imported videos — see `src/db.ts`) read
/// access to a single video file. `tauri.conf.json`'s
/// `security.assetProtocol.scope` is empty by design (no filesystem-wide
/// wildcard); every playable path has to be allow-listed here at runtime
/// instead, once per imported video.
///
/// Best-effort: `Scope::allow_file` only returns `Err` if the path can't be
/// turned into a glob pattern, which isn't expected for the absolute paths
/// this is called with. A failure here would only leave that one video
/// unplayable in the editor — it shouldn't abort an otherwise-successful
/// import, so it's logged rather than surfaced as a command error.
pub(crate) fn allow_video_playback(app: &AppHandle, file_path: &str) {
    if let Err(err) = app.asset_protocol_scope().allow_file(file_path) {
        eprintln!("could not register {file_path} with the asset protocol scope: {err}");
    }
}

/// Re-registers every already-imported video's `file_path` with the
/// asset-protocol scope (see `allow_video_playback`). Called once from
/// `setup()` after opening the connection: the scope is in-memory only and
/// doesn't persist across launches like the `videos` rows do, so without
/// this, every video imported in a previous session would silently stop
/// being playable the moment the app restarts.
pub fn allow_existing_video_playback(app: &AppHandle, conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT file_path FROM videos")
        .map_err(|err| err.to_string())?;
    let paths = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;
    for path in paths {
        let path = path.map_err(|err| err.to_string())?;
        allow_video_playback(app, &path);
    }
    Ok(())
}

fn row_to_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get("id")?,
        name: row.get("name")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

#[tauri::command]
pub fn create_project(
    conn: tauri::State<'_, DbConnection>,
    name: String,
) -> Result<Project, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("project name must not be empty".to_string());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    conn.execute(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, now, now],
    )
    .map_err(|err| err.to_string())?;

    Ok(Project {
        id,
        name,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
pub fn list_projects(conn: tauri::State<'_, DbConnection>) -> Result<Vec<Project>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], row_to_project)
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_project(
    conn: tauri::State<'_, DbConnection>,
    id: String,
) -> Result<Option<Project>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    match conn.query_row(
        "SELECT id, name, created_at, updated_at FROM projects WHERE id = ?1",
        params![id],
        row_to_project,
    ) {
        Ok(project) => Ok(Some(project)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(other) => Err(other.to_string()),
    }
}

/// Shared with `ffmpeg.rs`'s `extract_audio_for_video`, which re-queries a
/// `videos` row after updating it and reuses this mapping rather than
/// duplicating the column list.
pub(crate) fn row_to_video(row: &rusqlite::Row<'_>) -> rusqlite::Result<Video> {
    Ok(Video {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        file_path: row.get("file_path")?,
        duration: row.get("duration")?,
        transcript_status: row.get("transcript_status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        audio_path: row.get("audio_path")?,
    })
}

/// Imports videos into a project from a mix of file and directory paths
/// (PRD §7.2): directories are scanned recursively for supported files,
/// unsupported/nonexistent paths and files already imported into this
/// project (by absolute path) are silently skipped. Duration stays NULL
/// (probed later by the preview layer) and `transcript_status` keeps its
/// `'pending'` schema default. Source files are never touched on disk.
///
/// Declared `async` so the (potentially large) folder walk runs off the
/// main thread instead of freezing the UI.
#[tauri::command(async)]
pub fn import_videos(
    app: AppHandle,
    conn: tauri::State<'_, DbConnection>,
    project_id: String,
    paths: Vec<String>,
) -> Result<Vec<Video>, String> {
    // Walk the filesystem before taking the DB lock.
    let mut candidates: Vec<PathBuf> = Vec::new();
    for path in &paths {
        collect_video_files(Path::new(path), 0, &mut candidates);
    }

    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    // One transaction so a mid-batch failure doesn't leave a partial import.
    let tx = conn.transaction().map_err(|err| err.to_string())?;

    match tx.query_row(
        "SELECT id FROM projects WHERE id = ?1",
        params![project_id],
        |_| Ok(()),
    ) {
        Ok(()) => {}
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Err(format!("project {project_id} does not exist"));
        }
        Err(other) => return Err(other.to_string()),
    }

    // Already-imported absolute paths for this project; also dedupes
    // within the incoming batch (e.g. a file plus its parent folder).
    let mut seen: HashSet<String> = {
        let mut stmt = tx
            .prepare("SELECT file_path FROM videos WHERE project_id = ?1")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![project_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<HashSet<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    let mut imported: Vec<Video> = Vec::new();
    for candidate in candidates {
        let Ok(absolute) = std::path::absolute(&candidate) else {
            continue;
        };
        let Some(file_path) = absolute.to_str().map(str::to_string) else {
            // Skip non-UTF-8 paths — they can't round-trip through IPC.
            continue;
        };
        if !seen.insert(file_path.clone()) {
            continue;
        }

        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO videos (id, project_id, file_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, project_id, file_path, now, now],
        )
        .map_err(|err| err.to_string())?;

        imported.push(Video {
            id,
            project_id: project_id.clone(),
            file_path,
            duration: None,
            transcript_status: "pending".to_string(),
            created_at: now.clone(),
            updated_at: now,
            audio_path: None,
        });
    }

    // The project list is ordered by updated_at, so an import that changed
    // the project should surface it.
    if !imported.is_empty() {
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![now, project_id],
        )
        .map_err(|err| err.to_string())?;
    }

    tx.commit().map_err(|err| err.to_string())?;

    // Grant playback access for each newly imported video now that the
    // insert has committed (see `allow_video_playback`).
    for video in &imported {
        allow_video_playback(&app, &video.file_path);
    }

    Ok(imported)
}

#[tauri::command]
pub fn list_videos(
    conn: tauri::State<'_, DbConnection>,
    project_id: String,
) -> Result<Vec<Video>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, file_path, duration, transcript_status, created_at, updated_at, audio_path
             FROM videos WHERE project_id = ?1 ORDER BY created_at, id",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![project_id], row_to_video)
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

/// Looks up a single video by id — mirrors `get_project`'s shape
/// (`Option`, `None` for not-found rather than an `Err`). Added for
/// `LessonEditorView`, which is only handed a `videoId` (not its parent
/// `projectId`) and needs the row's `file_path` to build a playback URL via
/// `convertFileSrc`.
#[tauri::command]
pub fn get_video(conn: tauri::State<'_, DbConnection>, id: String) -> Result<Option<Video>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    match conn.query_row(
        "SELECT id, project_id, file_path, duration, transcript_status, created_at, updated_at, audio_path
         FROM videos WHERE id = ?1",
        params![id],
        row_to_video,
    ) {
        Ok(video) => Ok(Some(video)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(other) => Err(other.to_string()),
    }
}

/// Marks a video row `transcript_status = 'error'` without having actually
/// attempted extraction/transcription — used by the frontend when it
/// short-circuits the pipeline itself (e.g. no OpenAI key saved yet, so
/// there's no point paying for ffmpeg transcoding only to fail at the
/// transcription step). Mirrors the same-named private helpers in
/// `ffmpeg.rs`/`openai.rs` (each set this after their own failed attempt);
/// this is the one path where the caller never made an attempt at all, so
/// it needs its own entry point rather than reusing those.
#[tauri::command]
pub fn mark_video_error(conn: tauri::State<'_, DbConnection>, id: String) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE videos SET transcript_status = 'error', updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct TranscriptSegmentRow {
    pub id: String,
    pub video_id: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub keep: bool,
}

/// Shared with `export.rs`'s export worker, which loads a lesson's kept
/// transcript segments (currently unused now that SRT export is gone, kept
/// for M6's planned silence-trimming) and reuses this mapping rather than
/// duplicating the column list (see `row_to_video`/`row_to_lesson` above for
/// the same pattern).
pub(crate) fn row_to_transcript_segment(row: &rusqlite::Row<'_>) -> rusqlite::Result<TranscriptSegmentRow> {
    Ok(TranscriptSegmentRow {
        id: row.get("id")?,
        video_id: row.get("video_id")?,
        start: row.get("start")?,
        end: row.get("end")?,
        text: row.get("text")?,
        keep: row.get("keep")?,
    })
}

/// Read-only listing of a video's transcript segments (see `openai.rs` for
/// where they're populated). Pure CRUD — no OpenAI or filesystem work here.
#[tauri::command]
pub fn list_transcript_segments(
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
) -> Result<Vec<TranscriptSegmentRow>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, video_id, start, end, text, keep FROM transcript_segments
             WHERE video_id = ?1 ORDER BY start, id",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![video_id], row_to_transcript_segment)
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

/// A lesson row, including the AI-analysis fields added by
/// `0003_lesson_ai_fields.sql` (see `openai.rs`, where `analyze_video`
/// populates these). `confidence` is nullable for any future
/// manually-created lesson that never went through AI analysis.
#[derive(Debug, Serialize)]
pub struct LessonRow {
    pub id: String,
    pub video_id: String,
    pub title: String,
    pub summary: Option<String>,
    pub start: f64,
    pub end: f64,
    pub sort_order: i64,
    pub confidence: Option<f64>,
    pub kind: String,
    pub source: String,
}

/// Shared with `openai.rs`'s `analyze_video`, which re-queries `lessons`
/// rows after inserting AI suggestions and reuses this mapping rather than
/// duplicating the column list.
pub(crate) fn row_to_lesson(row: &rusqlite::Row<'_>) -> rusqlite::Result<LessonRow> {
    Ok(LessonRow {
        id: row.get("id")?,
        video_id: row.get("video_id")?,
        title: row.get("title")?,
        summary: row.get("summary")?,
        start: row.get("start")?,
        end: row.get("end")?,
        sort_order: row.get("sort_order")?,
        confidence: row.get("confidence")?,
        kind: row.get("kind")?,
        source: row.get("source")?,
    })
}

/// Read-only listing of a video's lesson suggestions/rows (see `openai.rs`
/// for where AI suggestions are populated). Pure CRUD — no OpenAI or
/// filesystem work here.
#[tauri::command]
pub fn list_lessons(
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
) -> Result<Vec<LessonRow>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, video_id, title, summary, start, end, sort_order, confidence, kind, source
             FROM lessons WHERE video_id = ?1 ORDER BY sort_order, id",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![video_id], row_to_lesson)
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

/// Simple field-level update of a transcript segment's `keep` flag (the
/// Transcript Mode keep/delete toggle, PRD §8.1) — not a row delete, per
/// `coursecut-data-model`.
#[tauri::command]
pub fn update_transcript_segment(
    conn: tauri::State<'_, DbConnection>,
    id: String,
    keep: bool,
) -> Result<TranscriptSegmentRow, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    let updated = conn
        .execute(
            "UPDATE transcript_segments SET keep = ?1 WHERE id = ?2",
            params![keep, id],
        )
        .map_err(|err| err.to_string())?;
    if updated == 0 {
        return Err(format!("transcript segment {id} does not exist"));
    }
    conn.query_row(
        "SELECT id, video_id, start, end, text, keep FROM transcript_segments WHERE id = ?1",
        params![id],
        row_to_transcript_segment,
    )
    .map_err(|err| err.to_string())
}

fn query_lesson(conn: &Connection, id: &str) -> Result<LessonRow, String> {
    conn.query_row(
        "SELECT id, video_id, title, summary, start, end, sort_order, confidence, kind, source
         FROM lessons WHERE id = ?1",
        params![id],
        row_to_lesson,
    )
    .map_err(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => format!("lesson {id} does not exist"),
        other => other.to_string(),
    })
}

/// Re-sequences `sort_order` for all of `video_id`'s lessons by `start`
/// ascending (0-indexed). Shared by `split_lesson`, `merge_lessons`, and
/// `delete_lesson`, all of which can leave `sort_order` with a gap or
/// duplicate after inserting/removing a row — kept as one helper rather
/// than duplicating this SQL three times (see data-model skill's note that
/// reordering always goes through `sort_order`, never implicit row order).
fn resequence_lessons(tx: &rusqlite::Transaction<'_>, video_id: &str) -> Result<(), String> {
    let ids: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM lessons WHERE video_id = ?1 ORDER BY start, id")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![video_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };
    for (index, id) in ids.into_iter().enumerate() {
        tx.execute(
            "UPDATE lessons SET sort_order = ?1 WHERE id = ?2",
            params![index as i64, id],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Lesson segments (`0006_lesson_segments.sql`) — a lesson is built from one
// or more, possibly overlapping and non-contiguous, segments of its source
// video. `lessons.start`/`lessons.end` remain on the table but are now a
// cached derived bound (min segment start, max segment end), kept in sync
// by `recompute_lesson_bounds_tx` after every segment write rather than a
// SQL trigger — see docs/lesson-segments-plan.md.
// ---------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct LessonSegmentRow {
    pub id: String,
    pub lesson_id: String,
    pub start: f64,
    pub end: f64,
    pub sort_order: i64,
}

fn row_to_lesson_segment(row: &rusqlite::Row<'_>) -> rusqlite::Result<LessonSegmentRow> {
    Ok(LessonSegmentRow {
        id: row.get("id")?,
        lesson_id: row.get("lesson_id")?,
        start: row.get("start")?,
        end: row.get("end")?,
        sort_order: row.get("sort_order")?,
    })
}

fn query_lesson_segment(conn: &Connection, id: &str) -> Result<LessonSegmentRow, String> {
    conn.query_row(
        "SELECT id, lesson_id, start, end, sort_order FROM lesson_segments WHERE id = ?1",
        params![id],
        row_to_lesson_segment,
    )
    .map_err(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => format!("lesson segment {id} does not exist"),
        other => other.to_string(),
    })
}

/// Recomputes `lessons.start`/`lessons.end` for `lesson_id` as the min
/// start / max end across that lesson's current segments, and persists it.
/// If the lesson has no segments left (its last one was just deleted), the
/// cached bound is left as-is — there's nothing to derive it from, and the
/// spec for this step explicitly doesn't require a lesson to keep at least
/// one segment.
fn recompute_lesson_bounds_tx(tx: &rusqlite::Transaction<'_>, lesson_id: &str) -> Result<(), String> {
    let bounds: Vec<(f64, f64)> = {
        let mut stmt = tx
            .prepare("SELECT start, end FROM lesson_segments WHERE lesson_id = ?1")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![lesson_id], |row| {
                Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?))
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<(f64, f64)>, _>>()
            .map_err(|err| err.to_string())?
    };

    if bounds.is_empty() {
        return Ok(());
    }
    let min_start = bounds.iter().map(|(start, _)| *start).fold(f64::INFINITY, f64::min);
    let max_end = bounds.iter().map(|(_, end)| *end).fold(f64::NEG_INFINITY, f64::max);

    tx.execute(
        "UPDATE lessons SET start = ?1, end = ?2 WHERE id = ?3",
        params![min_start, max_end, lesson_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// Read-only listing of a lesson's segments, in playback order.
#[tauri::command]
pub fn list_lesson_segments(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
) -> Result<Vec<LessonSegmentRow>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, lesson_id, start, end, sort_order FROM lesson_segments
             WHERE lesson_id = ?1 ORDER BY sort_order, id",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![lesson_id], row_to_lesson_segment)
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

/// Appends a new segment to `lesson_id` (`sort_order` = current segment
/// count, i.e. always added last), then recomputes the parent lesson's
/// cached `start`/`end` bound and re-sequences lesson ordering for its
/// video. No overlap validation against the lesson's other segments or any
/// other lesson's segments — intentional, see the plan doc.
fn add_lesson_segment_tx(
    tx: &rusqlite::Transaction<'_>,
    lesson_id: &str,
    start: f64,
    end: f64,
) -> Result<LessonSegmentRow, String> {
    if start >= end {
        return Err(format!(
            "invalid segment range: start ({start}) must be before end ({end})"
        ));
    }

    let lesson = query_lesson(tx, lesson_id)?;

    let next_order: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM lesson_segments WHERE lesson_id = ?1",
            params![lesson_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO lesson_segments (id, lesson_id, start, end, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, lesson_id, start, end, next_order],
    )
    .map_err(|err| err.to_string())?;

    recompute_lesson_bounds_tx(tx, lesson_id)?;
    resequence_lessons(tx, &lesson.video_id)?;

    query_lesson_segment(tx, &id)
}

#[tauri::command]
pub fn add_lesson_segment(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
    start: f64,
    end: f64,
) -> Result<LessonSegmentRow, String> {
    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let result = add_lesson_segment_tx(&tx, &lesson_id, start, end)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(result)
}

/// Updates a segment's `start`/`end`, then recomputes its parent lesson's
/// cached bound and re-sequences lesson ordering. Same no-overlap-check
/// stance as `add_lesson_segment`.
fn update_lesson_segment_tx(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    start: f64,
    end: f64,
) -> Result<LessonSegmentRow, String> {
    if start >= end {
        return Err(format!(
            "invalid segment range: start ({start}) must be before end ({end})"
        ));
    }

    let segment = query_lesson_segment(tx, id)?;
    tx.execute(
        "UPDATE lesson_segments SET start = ?1, end = ?2 WHERE id = ?3",
        params![start, end, id],
    )
    .map_err(|err| err.to_string())?;

    recompute_lesson_bounds_tx(tx, &segment.lesson_id)?;
    let lesson = query_lesson(tx, &segment.lesson_id)?;
    resequence_lessons(tx, &lesson.video_id)?;

    query_lesson_segment(tx, id)
}

#[tauri::command]
pub fn update_lesson_segment(
    conn: tauri::State<'_, DbConnection>,
    id: String,
    start: f64,
    end: f64,
) -> Result<LessonSegmentRow, String> {
    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let result = update_lesson_segment_tx(&tx, &id, start, end)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(result)
}

/// Result of `delete_lesson_segment`: a lesson with zero segments isn't
/// meaningful, so deleting a lesson's *last* remaining segment deletes the
/// lesson itself instead of leaving it behind with stale cached bounds
/// (see `delete_lesson_segment_tx`). `lesson_deleted` tells the caller
/// which happened, so e.g. the frontend knows whether to drop the parent
/// lesson from its lists rather than trying to re-render one that's gone.
#[derive(Debug, Serialize)]
pub struct DeleteLessonSegmentResult {
    pub lesson_id: String,
    pub lesson_deleted: bool,
}

/// Deletes a segment. If it was the lesson's only segment, the lesson
/// itself is deleted instead (via `delete_lesson_tx`, whose `ON DELETE
/// CASCADE` from `lessons` removes this segment row along with it) —
/// otherwise the segment alone is removed, and the parent lesson's cached
/// bound is recomputed and lesson ordering re-sequenced as usual.
fn delete_lesson_segment_tx(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
) -> Result<DeleteLessonSegmentResult, String> {
    let segment = query_lesson_segment(tx, id)?;

    let segment_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM lesson_segments WHERE lesson_id = ?1",
            params![segment.lesson_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;

    if segment_count <= 1 {
        delete_lesson_tx(tx, &segment.lesson_id)?;
        return Ok(DeleteLessonSegmentResult {
            lesson_id: segment.lesson_id,
            lesson_deleted: true,
        });
    }

    tx.execute("DELETE FROM lesson_segments WHERE id = ?1", params![id])
        .map_err(|err| err.to_string())?;

    recompute_lesson_bounds_tx(tx, &segment.lesson_id)?;
    let lesson = query_lesson(tx, &segment.lesson_id)?;
    resequence_lessons(tx, &lesson.video_id)?;

    Ok(DeleteLessonSegmentResult {
        lesson_id: segment.lesson_id,
        lesson_deleted: false,
    })
}

#[tauri::command]
pub fn delete_lesson_segment(
    conn: tauri::State<'_, DbConnection>,
    id: String,
) -> Result<DeleteLessonSegmentResult, String> {
    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let result = delete_lesson_segment_tx(&tx, &id)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(result)
}

/// Re-sequences a lesson's own segments' `sort_order` to match `ordered_ids`
/// exactly (same all-or-nothing validation as `reorder_lessons_tx`, scoped
/// to one lesson's segments instead of one video's lessons) — lets
/// `LessonSegmentsView` support drag/swap reordering. Doesn't touch the
/// lesson's cached `start`/`end` bound: reordering only changes playback
/// sequence, not any segment's own `start`/`end`, so the min/max across all
/// of them can't change.
fn reorder_lesson_segments_tx(
    tx: &rusqlite::Transaction<'_>,
    lesson_id: &str,
    ordered_ids: &[String],
) -> Result<(), String> {
    let existing_ids: HashSet<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM lesson_segments WHERE lesson_id = ?1")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![lesson_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<HashSet<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    let given_ids: HashSet<String> = ordered_ids.iter().cloned().collect();
    if given_ids.len() != ordered_ids.len() {
        return Err("ordered_ids contains duplicate ids".to_string());
    }
    if given_ids != existing_ids {
        return Err(format!(
            "ordered_ids must exactly match lesson {lesson_id}'s current segments — no missing or extra ids"
        ));
    }

    for (index, id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE lesson_segments SET sort_order = ?1 WHERE id = ?2",
            params![index as i64, id],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn reorder_lesson_segments(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    reorder_lesson_segments_tx(&tx, &lesson_id, &ordered_ids)?;
    tx.commit().map_err(|err| err.to_string())
}

/// One `{start, end}` range from the frontend's Create Lesson modal, already
/// collapsed from a transcript-segment checkbox selection into contiguous
/// runs (see `src/components/CreateLessonModal.tsx`) — a non-contiguous
/// checked selection arrives here as more than one `SegmentRange`. Plain
/// IPC input, not a table row.
#[derive(Debug, Deserialize)]
pub struct SegmentRange {
    pub start: f64,
    pub end: f64,
}

/// Creates a manually-built lesson (`source = 'manual'`, `confidence =
/// NULL`, `kind = 'lesson'`) from `segments` — one `lesson_segments` row per
/// entry, in the order given. Unlike `openai.rs`'s `replace_ai_lessons_tx`,
/// this never touches existing rows: it only appends. `source != 'ai'`
/// means `analyze_video`'s `DELETE ... WHERE source = 'ai'` (see
/// `replace_ai_lessons_tx`) leaves this lesson alone on re-analysis.
///
/// The new lesson's `start`/`end` are inserted as a placeholder (the first
/// segment's own range) and then corrected by `recompute_lesson_bounds_tx`
/// once all its segments exist, mirroring `split_lesson_tx`'s pattern rather
/// than duplicating the min/max computation here. `sort_order` is likewise a
/// placeholder (`0`), immediately corrected by `resequence_lessons`, which
/// re-derives every lesson's order from `start` — so the new lesson lands
/// wherever its earliest segment falls chronologically among the video's
/// existing lessons, not necessarily last.
fn create_lesson_tx(
    tx: &rusqlite::Transaction<'_>,
    video_id: &str,
    title: &str,
    segments: &[SegmentRange],
) -> Result<LessonRow, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("lesson title must not be empty".to_string());
    }
    let Some(first) = segments.first() else {
        return Err("a lesson needs at least one segment".to_string());
    };
    for segment in segments {
        if segment.start >= segment.end {
            return Err(format!(
                "invalid segment range: start ({}) must be before end ({})",
                segment.start, segment.end
            ));
        }
    }

    match tx.query_row(
        "SELECT id FROM videos WHERE id = ?1",
        params![video_id],
        |_| Ok(()),
    ) {
        Ok(()) => {}
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Err(format!("video {video_id} does not exist"));
        }
        Err(other) => return Err(other.to_string()),
    }

    let id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO lessons (id, video_id, title, summary, start, end, sort_order, confidence, kind, source)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, 0, NULL, 'lesson', 'manual')",
        params![id, video_id, title, first.start, first.end],
    )
    .map_err(|err| err.to_string())?;

    for (index, segment) in segments.iter().enumerate() {
        let segment_id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO lesson_segments (id, lesson_id, start, end, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![segment_id, id, segment.start, segment.end, index as i64],
        )
        .map_err(|err| err.to_string())?;
    }

    recompute_lesson_bounds_tx(tx, &id)?;
    resequence_lessons(tx, video_id)?;

    query_lesson(tx, &id)
}

#[tauri::command]
pub fn create_lesson(
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
    title: String,
    segments: Vec<SegmentRange>,
) -> Result<LessonRow, String> {
    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let result = create_lesson_tx(&tx, &video_id, &title, &segments)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(result)
}

/// Patch-semantics update of a lesson's `title`/`summary`: only the `Some`
/// fields are written, anything `None` is left unchanged. `start`/`end` are
/// no longer settable here — since `0006_lesson_segments.sql`, they're a
/// cached bound derived from the lesson's segments (see
/// `recompute_lesson_bounds_tx`), adjusted only via segment CRUD
/// (`add_lesson_segment`/`update_lesson_segment`/`delete_lesson_segment`) or
/// `split_lesson`/`merge_lessons`.
#[tauri::command]
pub fn update_lesson(
    conn: tauri::State<'_, DbConnection>,
    id: String,
    title: Option<String>,
    summary: Option<String>,
) -> Result<LessonRow, String> {
    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;

    if let Some(title) = &title {
        tx.execute(
            "UPDATE lessons SET title = ?1 WHERE id = ?2",
            params![title, id],
        )
        .map_err(|err| err.to_string())?;
    }
    if let Some(summary) = &summary {
        tx.execute(
            "UPDATE lessons SET summary = ?1 WHERE id = ?2",
            params![summary, id],
        )
        .map_err(|err| err.to_string())?;
    }
    let result = query_lesson(&tx, &id)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(result)
}

/// Splits `lesson_id`'s segment `segment_id` into two at `at_time`, which
/// must fall strictly inside that segment's own `[start, end)` range (not
/// equal to either boundary — an equal split would produce a zero-length
/// segment). The segment is truncated to `[start, at_time)`; a new lesson
/// (new UUID) is created holding a single new segment `[at_time, end)`,
/// copying `title` (with " (cont.)" appended so the two are distinguishable
/// in the lesson list), `summary`, `kind`, `confidence`, and `source` from
/// the original lesson. Cached `start`/`end` bounds are recomputed for both
/// lessons afterward, and `sort_order` for the whole video is re-sequenced
/// (see `resequence_lessons`) since the new lesson needs a slot in the
/// ordering.
fn split_lesson_tx(
    tx: &rusqlite::Transaction<'_>,
    lesson_id: &str,
    segment_id: &str,
    at_time: f64,
) -> Result<Vec<LessonRow>, String> {
    let original = query_lesson(tx, lesson_id)?;
    let segment = query_lesson_segment(tx, segment_id)?;

    if segment.lesson_id != original.id {
        return Err(format!(
            "segment {segment_id} does not belong to lesson {lesson_id}"
        ));
    }

    if !(at_time > segment.start && at_time < segment.end) {
        return Err(format!(
            "split time {at_time} must be strictly between the segment's start ({}) and end ({})",
            segment.start, segment.end
        ));
    }

    tx.execute(
        "UPDATE lesson_segments SET end = ?1 WHERE id = ?2",
        params![at_time, segment_id],
    )
    .map_err(|err| err.to_string())?;

    let new_lesson_id = uuid::Uuid::new_v4().to_string();
    let new_title = format!("{} (cont.)", original.title);
    tx.execute(
        "INSERT INTO lessons (id, video_id, title, summary, start, end, sort_order, confidence, kind, source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            new_lesson_id,
            original.video_id,
            new_title,
            original.summary,
            at_time,
            segment.end,
            original.sort_order,
            original.confidence,
            original.kind,
            original.source,
        ],
    )
    .map_err(|err| err.to_string())?;

    let new_segment_id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO lesson_segments (id, lesson_id, start, end, sort_order) VALUES (?1, ?2, ?3, ?4, 0)",
        params![new_segment_id, new_lesson_id, at_time, segment.end],
    )
    .map_err(|err| err.to_string())?;

    recompute_lesson_bounds_tx(tx, lesson_id)?;
    recompute_lesson_bounds_tx(tx, &new_lesson_id)?;
    resequence_lessons(tx, &original.video_id)?;

    let updated_original = query_lesson(tx, lesson_id)?;
    let new_lesson = query_lesson(tx, &new_lesson_id)?;
    Ok(vec![updated_original, new_lesson])
}

#[tauri::command]
pub fn split_lesson(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
    segment_id: String,
    at_time: f64,
) -> Result<Vec<LessonRow>, String> {
    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let result = split_lesson_tx(&tx, &lesson_id, &segment_id, at_time)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(result)
}

/// Merges `second_id` into `first_id` (both must belong to the same
/// video): all of `second_id`'s segments are re-pointed to `first_id`,
/// with `sort_order` adjusted so they're appended after `first_id`'s
/// existing segments — concatenating the two lessons' segment lists rather
/// than widening a single range. `title` is left unchanged, `summary` is
/// set to the concatenation of both non-empty summaries (newline-joined) —
/// if only one side has a non-empty summary, that one wins as-is.
/// `second_id`'s (now segment-less) row is then deleted, `first_id`'s
/// cached `start`/`end` bound is recomputed from its now-combined segment
/// list, and `sort_order` is re-sequenced for the video.
fn merge_lessons_tx(
    tx: &rusqlite::Transaction<'_>,
    first_id: &str,
    second_id: &str,
) -> Result<LessonRow, String> {
    let first = query_lesson(tx, first_id)?;
    let second = query_lesson(tx, second_id)?;

    if first.video_id != second.video_id {
        return Err("cannot merge lessons belonging to different videos".to_string());
    }

    let next_order: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM lesson_segments WHERE lesson_id = ?1",
            params![first_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;

    let second_segment_ids: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM lesson_segments WHERE lesson_id = ?1 ORDER BY sort_order, id")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![second_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    for (offset, segment_id) in second_segment_ids.into_iter().enumerate() {
        tx.execute(
            "UPDATE lesson_segments SET lesson_id = ?1, sort_order = ?2 WHERE id = ?3",
            params![first_id, next_order + offset as i64, segment_id],
        )
        .map_err(|err| err.to_string())?;
    }

    let non_empty = |summary: &Option<String>| {
        summary
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let merged_summary = match (non_empty(&first.summary), non_empty(&second.summary)) {
        (Some(a), Some(b)) => Some(format!("{a}\n{b}")),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };

    tx.execute(
        "UPDATE lessons SET summary = ?1 WHERE id = ?2",
        params![merged_summary, first_id],
    )
    .map_err(|err| err.to_string())?;

    tx.execute("DELETE FROM lessons WHERE id = ?1", params![second_id])
        .map_err(|err| err.to_string())?;

    recompute_lesson_bounds_tx(tx, first_id)?;
    resequence_lessons(tx, &first.video_id)?;

    query_lesson(tx, first_id)
}

#[tauri::command]
pub fn merge_lessons(
    conn: tauri::State<'_, DbConnection>,
    first_id: String,
    second_id: String,
) -> Result<LessonRow, String> {
    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let result = merge_lessons_tx(&tx, &first_id, &second_id)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(result)
}

fn delete_lesson_tx(tx: &rusqlite::Transaction<'_>, id: &str) -> Result<(), String> {
    let video_id: String = tx
        .query_row(
            "SELECT video_id FROM lessons WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => format!("lesson {id} does not exist"),
            other => other.to_string(),
        })?;

    tx.execute("DELETE FROM lessons WHERE id = ?1", params![id])
        .map_err(|err| err.to_string())?;

    resequence_lessons(tx, &video_id)
}

#[tauri::command]
pub fn delete_lesson(conn: tauri::State<'_, DbConnection>, id: String) -> Result<(), String> {
    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    delete_lesson_tx(&tx, &id)?;
    tx.commit().map_err(|err| err.to_string())
}

/// Sets `sort_order` to each id's position (0-indexed) in `ordered_ids`.
/// Strict validation: `ordered_ids` must be exactly the set of `video_id`'s
/// current lesson ids (no duplicates, no missing/extra ids) — a partial or
/// mismatched list is rejected rather than silently applied, since a
/// silent partial reorder could leave `sort_order` in a confusing mixed
/// state.
fn reorder_lessons_tx(
    tx: &rusqlite::Transaction<'_>,
    video_id: &str,
    ordered_ids: &[String],
) -> Result<(), String> {
    let existing_ids: HashSet<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM lessons WHERE video_id = ?1")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![video_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<HashSet<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    let given_ids: HashSet<String> = ordered_ids.iter().cloned().collect();
    if given_ids.len() != ordered_ids.len() {
        return Err("ordered_ids contains duplicate ids".to_string());
    }
    if given_ids != existing_ids {
        return Err(format!(
            "ordered_ids must exactly match video {video_id}'s current lessons — no missing or extra ids"
        ));
    }

    for (index, id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE lessons SET sort_order = ?1 WHERE id = ?2",
            params![index as i64, id],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn reorder_lessons(
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    reorder_lessons_tx(&tx, &video_id, &ordered_ids)?;
    tx.commit().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn delete_project(conn: tauri::State<'_, DbConnection>, id: String) -> Result<(), String> {
    // Videos/transcript_segments/lessons/exports cascade via the schema's
    // ON DELETE CASCADE (see 0001_init.sql) — no app-level cascade needed.
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_video(conn: tauri::State<'_, DbConnection>, id: String) -> Result<(), String> {
    // transcript_segments/lessons cascade via the schema's ON DELETE CASCADE
    // (see 0001_init.sql) — no app-level cascade needed. Note: this does not
    // remove the cached extracted-audio WAV file from disk (it's keyed by
    // content hash and may be shared/reused by other videos with identical
    // content) — that cache is left alone deliberately.
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    conn.execute("DELETE FROM videos WHERE id = ?1", params![id])
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg(test)]
mod lesson_editing_tests {
    use super::*;

    /// In-memory DB with migrations applied, plus one project/video, three
    /// lessons at `[0,10)`, `[10,20)`, `[20,30)` (sort_order 0,1,2), and one
    /// segment per lesson (`s0`/`s1`/`s2`, sort_order 0) mirroring the
    /// lesson's own range — shared setup for the segment/split/merge/
    /// delete/resequence tests below.
    ///
    /// Migration 0006's own SQL backfill only covers lessons that already
    /// exist at migration time, so these test lessons (inserted after
    /// `migrate()` runs) need their segments inserted explicitly here.
    fn seeded_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        migrate(&conn).unwrap();

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

        for (id, start, end, order) in [("l0", 0.0, 10.0, 0), ("l1", 10.0, 20.0, 1), ("l2", 20.0, 30.0, 2)] {
            conn.execute(
                "INSERT INTO lessons (id, video_id, title, summary, start, end, sort_order, confidence, kind, source)
                 VALUES (?1, 'v1', ?2, 'summary', ?3, ?4, ?5, 0.8, 'lesson', 'ai')",
                params![id, format!("Lesson {id}"), start, end, order],
            )
            .unwrap();
            let segment_id = format!("s{}", &id[1..]);
            conn.execute(
                "INSERT INTO lesson_segments (id, lesson_id, start, end, sort_order)
                 VALUES (?1, ?2, ?3, ?4, 0)",
                params![segment_id, id, start, end],
            )
            .unwrap();
        }

        conn
    }

    fn lesson_ids_by_order(conn: &Connection) -> Vec<(String, i64)> {
        let mut stmt = conn
            .prepare("SELECT id, sort_order FROM lessons WHERE video_id = 'v1' ORDER BY sort_order")
            .unwrap();
        stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    /// `(id, start, end, sort_order)` for every segment of `lesson_id`, in
    /// `sort_order` order.
    fn lesson_segment_rows(conn: &Connection, lesson_id: &str) -> Vec<(String, f64, f64, i64)> {
        let mut stmt = conn
            .prepare(
                "SELECT id, start, end, sort_order FROM lesson_segments
                 WHERE lesson_id = ?1 ORDER BY sort_order, id",
            )
            .unwrap();
        stmt.query_map(params![lesson_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    }

    fn lesson_bounds(conn: &Connection, lesson_id: &str) -> (f64, f64) {
        conn.query_row(
            "SELECT start, end FROM lessons WHERE id = ?1",
            params![lesson_id],
            |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?)),
        )
        .unwrap()
    }

    #[test]
    fn add_lesson_segment_appends_and_updates_lesson_bounds() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        let added = add_lesson_segment_tx(&tx, "l0", 15.0, 25.0).unwrap();
        tx.commit().unwrap();

        assert_eq!(added.lesson_id, "l0");
        assert_eq!(added.start, 15.0);
        assert_eq!(added.end, 25.0);
        // Appended after the seeded s0.
        assert_eq!(added.sort_order, 1);

        // l0's cached bound widens to cover both of its segments.
        assert_eq!(lesson_bounds(&conn, "l0"), (0.0, 25.0));

        let segments = lesson_segment_rows(&conn, "l0");
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].0, "s0");
        assert_eq!(segments[1].0, added.id);
    }

    #[test]
    fn add_lesson_segment_rejects_inverted_range() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();
        let err = add_lesson_segment_tx(&tx, "l0", 5.0, 5.0).unwrap_err();
        assert!(err.contains("must be before"), "unexpected error: {err}");
    }

    #[test]
    fn update_lesson_segment_changes_range_and_updates_lesson_bounds() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        let updated = update_lesson_segment_tx(&tx, "s0", 2.0, 8.0).unwrap();
        tx.commit().unwrap();

        assert_eq!(updated.start, 2.0);
        assert_eq!(updated.end, 8.0);
        assert_eq!(lesson_bounds(&conn, "l0"), (2.0, 8.0));
    }

    #[test]
    fn update_lesson_segment_rejects_inverted_range() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();
        let err = update_lesson_segment_tx(&tx, "s0", 8.0, 2.0).unwrap_err();
        assert!(err.contains("must be before"), "unexpected error: {err}");
    }

    #[test]
    fn delete_lesson_segment_leaves_lesson_intact_when_other_segments_remain() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        // Give l0 a second segment so it isn't s0's last one.
        add_lesson_segment_tx(&tx, "l0", 15.0, 25.0).unwrap();
        let result = delete_lesson_segment_tx(&tx, "s0").unwrap();
        tx.commit().unwrap();

        assert_eq!(result.lesson_id, "l0");
        assert!(!result.lesson_deleted);
        // The lesson survives, with its cached bound recomputed from the
        // one remaining segment.
        assert_eq!(lesson_bounds(&conn, "l0"), (15.0, 25.0));
        assert_eq!(lesson_segment_rows(&conn, "l0").len(), 1);
        assert!(query_lesson(&conn, "l0").is_ok());
    }

    #[test]
    fn delete_lesson_segment_deletes_lesson_when_it_was_the_last_segment() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        let result = delete_lesson_segment_tx(&tx, "s0").unwrap();
        tx.commit().unwrap();

        assert_eq!(result.lesson_id, "l0");
        assert!(result.lesson_deleted);

        // The lesson itself (and its now-orphaned segment, via cascade)
        // is gone rather than left behind with stale bounds and no
        // segments.
        assert!(query_lesson(&conn, "l0").unwrap_err().contains("does not exist"));
        assert_eq!(lesson_segment_rows(&conn, "l0").len(), 0);

        // The remaining two lessons are re-sequenced.
        let ordered = lesson_ids_by_order(&conn);
        assert_eq!(ordered, vec![("l1".to_string(), 0), ("l2".to_string(), 1)]);
    }

    #[test]
    fn lesson_segments_may_overlap_within_and_across_lessons() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        // Overlaps l0's own s0 [0,10).
        let within = add_lesson_segment_tx(&tx, "l0", 5.0, 15.0).unwrap();
        // Overlaps l0's segments, but from a different lesson entirely.
        let across = add_lesson_segment_tx(&tx, "l1", 0.0, 12.0).unwrap();
        tx.commit().unwrap();

        assert_eq!(within.lesson_id, "l0");
        assert_eq!(across.lesson_id, "l1");
        assert_eq!(lesson_segment_rows(&conn, "l0").len(), 2);
        assert_eq!(lesson_segment_rows(&conn, "l1").len(), 2);
    }

    /// Simulates upgrading an existing user's database: a lesson inserted
    /// under the pre-0006 schema (migrations 0001-0005 only) should get
    /// exactly one backfilled `lesson_segments` row, at `sort_order 0`,
    /// copying its own `start`/`end` — the migration's own SQL, not the
    /// Rust CRUD helpers above.
    #[test]
    fn migration_0006_backfills_one_segment_per_pre_existing_lesson() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(include_str!("../migrations/0001_init.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../migrations/0002_video_audio_cache.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../migrations/0003_lesson_ai_fields.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../migrations/0004_app_settings.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../migrations/0005_export_queue_fields.sql"))
            .unwrap();
        conn.pragma_update(None, "user_version", 5).unwrap();

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
            "INSERT INTO lessons (id, video_id, title, start, end, sort_order)
             VALUES ('l0', 'v1', 'Pre-existing', 3.5, 12.25, 0)",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let segments = lesson_segment_rows(&conn, "l0");
        assert_eq!(segments.len(), 1);
        assert_eq!((segments[0].1, segments[0].2, segments[0].3), (3.5, 12.25, 0));
    }

    #[test]
    fn split_lesson_divides_segment_and_resequences() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        let result = split_lesson_tx(&tx, "l0", "s0", 4.0).unwrap();
        tx.commit().unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "l0");
        assert_eq!(result[0].start, 0.0);
        assert_eq!(result[0].end, 4.0);
        assert_eq!(result[1].start, 4.0);
        assert_eq!(result[1].end, 10.0);
        assert_eq!(result[1].title, "Lesson l0 (cont.)");
        // Same metadata copied onto the new half.
        assert_eq!(result[1].kind, "lesson");
        assert_eq!(result[1].confidence, Some(0.8));
        assert_eq!(result[1].source, "ai");

        // The original segment is truncated in place; the new lesson gets
        // one new segment covering the tail.
        assert_eq!(
            lesson_segment_rows(&conn, "l0"),
            vec![("s0".to_string(), 0.0, 4.0, 0)]
        );
        let new_segments = lesson_segment_rows(&conn, &result[1].id);
        assert_eq!(new_segments.len(), 1);
        assert_eq!((new_segments[0].1, new_segments[0].2), (4.0, 10.0));

        // Four lessons now, sort_order 0..3 by start ascending.
        let ordered = lesson_ids_by_order(&conn);
        assert_eq!(ordered.len(), 4);
        assert_eq!(ordered[0].1, 0);
        assert_eq!(ordered[3].1, 3);
        assert_eq!(ordered[0].0, "l0");
        assert_eq!(ordered[1].0, result[1].id);
    }

    #[test]
    fn split_lesson_rejects_boundary_and_out_of_range_times() {
        let mut conn = seeded_conn();

        for at_time in [0.0, 10.0, -1.0, 15.0] {
            let tx = conn.transaction().unwrap();
            let err = split_lesson_tx(&tx, "l0", "s0", at_time).unwrap_err();
            assert!(err.contains("strictly between"), "unexpected error: {err}");
        }
    }

    #[test]
    fn split_lesson_rejects_missing_lesson() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();
        let err = split_lesson_tx(&tx, "does-not-exist", "s0", 5.0).unwrap_err();
        assert!(err.contains("does not exist"));
    }

    #[test]
    fn split_lesson_rejects_segment_from_a_different_lesson() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();
        // s0 belongs to l0, not l1.
        let err = split_lesson_tx(&tx, "l1", "s0", 5.0).unwrap_err();
        assert!(err.contains("does not belong to lesson"), "unexpected error: {err}");
    }

    #[test]
    fn merge_lessons_concatenates_segments_and_widens_bounds() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        let merged = merge_lessons_tx(&tx, "l0", "l1").unwrap();
        tx.commit().unwrap();

        assert_eq!(merged.id, "l0");
        assert_eq!(merged.start, 0.0);
        assert_eq!(merged.end, 20.0);
        assert_eq!(merged.summary.as_deref(), Some("summary\nsummary"));

        // l1's segment (s1) now belongs to l0, appended after l0's own.
        assert_eq!(
            lesson_segment_rows(&conn, "l0"),
            vec![
                ("s0".to_string(), 0.0, 10.0, 0),
                ("s1".to_string(), 10.0, 20.0, 1),
            ]
        );
        assert_eq!(lesson_segment_rows(&conn, "l1").len(), 0);

        // l1 gone, sort_order re-sequenced for the remaining two.
        let ordered = lesson_ids_by_order(&conn);
        assert_eq!(ordered.len(), 2);
        assert_eq!(ordered, vec![("l0".to_string(), 0), ("l2".to_string(), 1)]);
    }

    #[test]
    fn merge_lessons_keeps_single_non_empty_summary_as_is() {
        let mut conn = seeded_conn();
        conn.execute("UPDATE lessons SET summary = '' WHERE id = 'l1'", [])
            .unwrap();
        let tx = conn.transaction().unwrap();

        let merged = merge_lessons_tx(&tx, "l0", "l1").unwrap();
        tx.commit().unwrap();

        assert_eq!(merged.summary.as_deref(), Some("summary"));
    }

    #[test]
    fn merge_lessons_rejects_different_videos() {
        let mut conn = seeded_conn();
        conn.execute(
            "INSERT INTO videos (id, project_id, file_path, created_at, updated_at)
             VALUES ('v2', 'p1', '/tmp/other.mp4', 't', 't')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO lessons (id, video_id, title, start, end, sort_order)
             VALUES ('other', 'v2', 'Other', 0.0, 5.0, 0)",
            [],
        )
        .unwrap();

        let tx = conn.transaction().unwrap();
        let err = merge_lessons_tx(&tx, "l0", "other").unwrap_err();
        assert!(err.contains("different videos"));
    }

    #[test]
    fn delete_lesson_resequences_remaining_lessons() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        delete_lesson_tx(&tx, "l1").unwrap();
        tx.commit().unwrap();

        let ordered = lesson_ids_by_order(&conn);
        assert_eq!(ordered, vec![("l0".to_string(), 0), ("l2".to_string(), 1)]);
    }

    #[test]
    fn reorder_lessons_applies_given_order() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        reorder_lessons_tx(
            &tx,
            "v1",
            &["l2".to_string(), "l0".to_string(), "l1".to_string()],
        )
        .unwrap();
        tx.commit().unwrap();

        let ordered = lesson_ids_by_order(&conn);
        assert_eq!(
            ordered,
            vec![
                ("l2".to_string(), 0),
                ("l0".to_string(), 1),
                ("l1".to_string(), 2),
            ]
        );
    }

    #[test]
    fn reorder_lessons_rejects_partial_or_mismatched_lists() {
        let mut conn = seeded_conn();

        // Missing one id.
        let tx = conn.transaction().unwrap();
        let err = reorder_lessons_tx(&tx, "v1", &["l0".to_string(), "l1".to_string()]).unwrap_err();
        assert!(err.contains("exactly match"));
        drop(tx);

        // Duplicate id.
        let tx = conn.transaction().unwrap();
        let err = reorder_lessons_tx(
            &tx,
            "v1",
            &["l0".to_string(), "l0".to_string(), "l1".to_string()],
        )
        .unwrap_err();
        assert!(err.contains("duplicate"));
        drop(tx);

        // Id from a different video.
        let tx = conn.transaction().unwrap();
        let err = reorder_lessons_tx(
            &tx,
            "v1",
            &["l0".to_string(), "l1".to_string(), "does-not-exist".to_string()],
        )
        .unwrap_err();
        assert!(err.contains("exactly match"));
    }

    #[test]
    fn reorder_lesson_segments_applies_given_order() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        // Give l0 a second segment so there's something to reorder.
        let second = add_lesson_segment_tx(&tx, "l0", 15.0, 25.0).unwrap();
        reorder_lesson_segments_tx(&tx, "l0", &[second.id.clone(), "s0".to_string()]).unwrap();
        tx.commit().unwrap();

        let rows = lesson_segment_rows(&conn, "l0");
        assert_eq!(rows[0].0, second.id);
        assert_eq!(rows[0].3, 0);
        assert_eq!(rows[1].0, "s0");
        assert_eq!(rows[1].3, 1);
        // Reordering never touches any segment's own start/end, so the
        // lesson's cached bound (min start, max end) can't have changed.
        assert_eq!(lesson_bounds(&conn, "l0"), (0.0, 25.0));
    }

    #[test]
    fn reorder_lesson_segments_rejects_partial_or_mismatched_lists() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();
        add_lesson_segment_tx(&tx, "l0", 15.0, 25.0).unwrap();

        // Missing one id.
        let err = reorder_lesson_segments_tx(&tx, "l0", &["s0".to_string()]).unwrap_err();
        assert!(err.contains("exactly match"));

        // Duplicate id.
        let err =
            reorder_lesson_segments_tx(&tx, "l0", &["s0".to_string(), "s0".to_string()]).unwrap_err();
        assert!(err.contains("duplicate"));

        // Id from a different lesson.
        let err = reorder_lesson_segments_tx(&tx, "l0", &["s0".to_string(), "s1".to_string()])
            .unwrap_err();
        assert!(err.contains("exactly match"));
    }

    #[test]
    fn create_lesson_writes_one_segment_per_range_with_source_manual() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        // Mirrors a non-contiguous checkbox selection collapsed into two
        // runs by the frontend (see `CreateLessonModal`) — one lesson, two
        // `lesson_segments` rows.
        let created = create_lesson_tx(
            &tx,
            "v1",
            "Manual lesson",
            &[
                SegmentRange { start: 1.0, end: 3.0 },
                SegmentRange { start: 7.0, end: 8.0 },
            ],
        )
        .unwrap();
        tx.commit().unwrap();

        assert_eq!(created.title, "Manual lesson");
        assert_eq!(created.source, "manual");
        assert_eq!(created.confidence, None);
        assert_eq!(created.kind, "lesson");
        // Cached bound spans both segments, not just the first.
        assert_eq!((created.start, created.end), (1.0, 8.0));

        let segments = lesson_segment_rows(&conn, &created.id);
        assert_eq!(segments.len(), 2);
        assert_eq!((segments[0].1, segments[0].2, segments[0].3), (1.0, 3.0, 0));
        assert_eq!((segments[1].1, segments[1].2, segments[1].3), (7.0, 8.0, 1));
    }

    #[test]
    fn create_lesson_survives_ai_replace() {
        // A manually-created lesson must not be deleted by
        // `openai.rs::replace_ai_lessons_tx`'s `WHERE source = 'ai'` delete
        // on re-analysis — simulated here directly against the schema
        // rather than pulling in `openai.rs`, since this file owns the
        // invariant being protected (`source != 'ai'`) even though the
        // delete statement itself lives there.
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();
        let created = create_lesson_tx(
            &tx,
            "v1",
            "Manual lesson",
            &[SegmentRange { start: 1.0, end: 3.0 }],
        )
        .unwrap();
        tx.execute(
            "DELETE FROM lessons WHERE video_id = 'v1' AND source = 'ai'",
            [],
        )
        .unwrap();
        tx.commit().unwrap();

        let survived = query_lesson(&conn, &created.id).unwrap();
        assert_eq!(survived.id, created.id);
    }

    #[test]
    fn create_lesson_rejects_empty_title_and_empty_segments() {
        let mut conn = seeded_conn();

        let tx = conn.transaction().unwrap();
        let err = create_lesson_tx(&tx, "v1", "   ", &[SegmentRange { start: 0.0, end: 1.0 }])
            .unwrap_err();
        assert!(err.contains("title"));
        drop(tx);

        let tx = conn.transaction().unwrap();
        let err = create_lesson_tx(&tx, "v1", "Title", &[]).unwrap_err();
        assert!(err.contains("segment"));
    }

    #[test]
    fn create_lesson_rejects_inverted_segment_range() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();
        let err = create_lesson_tx(&tx, "v1", "Title", &[SegmentRange { start: 5.0, end: 5.0 }])
            .unwrap_err();
        assert!(err.contains("must be before"));
    }
}
