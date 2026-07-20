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
use serde::Serialize;
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
/// transcript segments to build its SRT file and reuses this mapping
/// rather than duplicating the column list (see `row_to_video`/
/// `row_to_lesson` above for the same pattern).
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

/// Patch-semantics update of a lesson's `title`/`summary`/`start`/`end`:
/// only the `Some` fields are written, anything `None` is left unchanged.
/// Used by Transcript Mode's inline rename (title/summary) today; `start`/
/// `end` are exposed for Milestone 6's Timestamp Mode trim actions to reuse
/// this same command rather than needing a second one.
///
/// The frontend already rejects an inverted `start`/`end` range before ever
/// calling this, but that's not a substitute for a server-side check: this
/// validates the *effective* range (new value if given, else the lesson's
/// current one) before writing anything, so no caller — today's UI or a
/// future one — can persist `start >= end` into SQLite.
#[tauri::command]
pub fn update_lesson(
    conn: tauri::State<'_, DbConnection>,
    id: String,
    title: Option<String>,
    summary: Option<String>,
    start: Option<f64>,
    end: Option<f64>,
) -> Result<LessonRow, String> {
    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;

    if start.is_some() || end.is_some() {
        let current = query_lesson(&tx, &id)?;
        let new_start = start.unwrap_or(current.start);
        let new_end = end.unwrap_or(current.end);
        if new_start >= new_end {
            return Err(format!(
                "invalid lesson range: start ({new_start}) must be before end ({new_end})"
            ));
        }
    }

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
    if let Some(start) = start {
        tx.execute(
            "UPDATE lessons SET start = ?1 WHERE id = ?2",
            params![start, id],
        )
        .map_err(|err| err.to_string())?;
    }
    if let Some(end) = end {
        tx.execute(
            "UPDATE lessons SET end = ?1 WHERE id = ?2",
            params![end, id],
        )
        .map_err(|err| err.to_string())?;
    }
    let result = query_lesson(&tx, &id)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(result)
}

/// Splits a lesson into two at `at_time`, which must fall strictly inside
/// `[start, end]` (not equal to either boundary — an equal split would
/// produce a zero-length lesson). The original `lesson_id` row keeps
/// `[start, at_time)`; a new lesson (new UUID) is created for
/// `[at_time, end]`, copying `title` (with " (cont.)" appended so the two
/// are distinguishable in the lesson list), `summary`, `kind`, `confidence`,
/// and `source` from the original. `sort_order` for the whole video is
/// then re-sequenced by `start` (see `resequence_lessons`) since the new
/// lesson needs a slot between the original and whatever followed it.
fn split_lesson_tx(
    tx: &rusqlite::Transaction<'_>,
    lesson_id: &str,
    at_time: f64,
) -> Result<Vec<LessonRow>, String> {
    let original = query_lesson(tx, lesson_id)?;

    if !(at_time > original.start && at_time < original.end) {
        return Err(format!(
            "split time {at_time} must be strictly between the lesson's start ({}) and end ({})",
            original.start, original.end
        ));
    }

    tx.execute(
        "UPDATE lessons SET end = ?1 WHERE id = ?2",
        params![at_time, lesson_id],
    )
    .map_err(|err| err.to_string())?;

    let new_id = uuid::Uuid::new_v4().to_string();
    let new_title = format!("{} (cont.)", original.title);
    tx.execute(
        "INSERT INTO lessons (id, video_id, title, summary, start, end, sort_order, confidence, kind, source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            new_id,
            original.video_id,
            new_title,
            original.summary,
            at_time,
            original.end,
            original.sort_order,
            original.confidence,
            original.kind,
            original.source,
        ],
    )
    .map_err(|err| err.to_string())?;

    resequence_lessons(tx, &original.video_id)?;

    let updated_original = query_lesson(tx, lesson_id)?;
    let new_lesson = query_lesson(tx, &new_id)?;
    Ok(vec![updated_original, new_lesson])
}

#[tauri::command]
pub fn split_lesson(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
    at_time: f64,
) -> Result<Vec<LessonRow>, String> {
    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let result = split_lesson_tx(&tx, &lesson_id, at_time)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(result)
}

/// Merges `second_id` into `first_id` (both must belong to the same
/// video): `first_id`'s row is kept with `start`/`end` widened to
/// `min`/`max` of both, `title` unchanged, and `summary` set to the
/// concatenation of both non-empty summaries (newline-joined) — if only
/// one side has a non-empty summary, that one wins as-is. `second_id`'s row
/// is then deleted and `sort_order` re-sequenced for the video.
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

    let merged_start = first.start.min(second.start);
    let merged_end = first.end.max(second.end);
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
        "UPDATE lessons SET start = ?1, end = ?2, summary = ?3 WHERE id = ?4",
        params![merged_start, merged_end, merged_summary, first_id],
    )
    .map_err(|err| err.to_string())?;

    tx.execute("DELETE FROM lessons WHERE id = ?1", params![second_id])
        .map_err(|err| err.to_string())?;

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

    /// In-memory DB with migrations applied, plus one project/video and
    /// three lessons at `[0,10)`, `[10,20)`, `[20,30)` (sort_order 0,1,2) —
    /// shared setup for the split/merge/delete/resequence tests below.
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

    #[test]
    fn split_lesson_divides_range_and_resequences() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        let result = split_lesson_tx(&tx, "l0", 4.0).unwrap();
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
            let err = split_lesson_tx(&tx, "l0", at_time).unwrap_err();
            assert!(err.contains("strictly between"), "unexpected error: {err}");
        }
    }

    #[test]
    fn split_lesson_rejects_missing_lesson() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();
        let err = split_lesson_tx(&tx, "does-not-exist", 5.0).unwrap_err();
        assert!(err.contains("does not exist"));
    }

    #[test]
    fn merge_lessons_widens_range_and_concatenates_summaries() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        let merged = merge_lessons_tx(&tx, "l0", "l1").unwrap();
        tx.commit().unwrap();

        assert_eq!(merged.id, "l0");
        assert_eq!(merged.start, 0.0);
        assert_eq!(merged.end, 20.0);
        assert_eq!(merged.summary.as_deref(), Some("summary\nsummary"));

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
}
