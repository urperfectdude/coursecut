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
fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|err| format!("could not read schema version: {err}"))?;

    if version < 1 {
        conn.execute_batch(include_str!("../migrations/0001_init.sql"))
            .map_err(|err| format!("migration 0001_init failed: {err}"))?;
        conn.pragma_update(None, "user_version", 1)
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

fn row_to_video(row: &rusqlite::Row<'_>) -> rusqlite::Result<Video> {
    Ok(Video {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        file_path: row.get("file_path")?,
        duration: row.get("duration")?,
        transcript_status: row.get("transcript_status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
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
            "SELECT id, project_id, file_path, duration, transcript_status, created_at, updated_at
             FROM videos WHERE project_id = ?1 ORDER BY created_at, id",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![project_id], row_to_video)
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
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
