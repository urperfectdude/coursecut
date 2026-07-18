//! Rust-side SQLite access for coursecut, via a single `rusqlite`
//! connection opened at startup and stored in managed state. The frontend
//! has no direct SQL surface (see `capabilities/default.json`) — all
//! querying happens through this module's `#[tauri::command]`s.
//!
//! Migrations in `../migrations/` are applied here at startup, tracked via
//! `PRAGMA user_version` (one integer bump per migration, applied in
//! order).

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Filename of the sqlite database, stored under the app's config dir.
const DB_FILENAME: &str = "coursecut.db";

/// Managed state wrapping the single Rust-owned SQLite connection.
pub struct DbConnection(pub Mutex<Connection>);

#[derive(Debug, Serialize)]
pub struct Project {
    pub id: String,
    pub name: String,
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

#[tauri::command]
pub fn delete_project(conn: tauri::State<'_, DbConnection>, id: String) -> Result<(), String> {
    // Videos/transcript_segments/lessons/exports cascade via the schema's
    // ON DELETE CASCADE (see 0001_init.sql) — no app-level cascade needed.
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|err| err.to_string())?;
    Ok(())
}
