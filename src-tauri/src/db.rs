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

use rusqlite::{params, Connection, OptionalExtension};
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
    /// Whether the current `transcript_segments` rows came from Whisper
    /// (`'whisper'`, the schema default) or a wholesale VTT import
    /// (`'vtt'`, set by `import_vtt_transcript`). Lets `TranscriptStageView`
    /// hide the Whisper-chunk re-transcribe sidebar for an imported
    /// transcript, since it was never chunked by Whisper.
    pub transcript_source: String,
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

    if version < 7 {
        conn.execute_batch(include_str!("../migrations/0007_frame_overlays.sql"))
            .map_err(|err| format!("migration 0007_frame_overlays failed: {err}"))?;
        conn.pragma_update(None, "user_version", 7)
            .map_err(|err| format!("could not update schema version: {err}"))?;
    }

    if version < 8 {
        conn.execute_batch(include_str!("../migrations/0008_frame_overlay_scale_percent.sql"))
            .map_err(|err| format!("migration 0008_frame_overlay_scale_percent failed: {err}"))?;
        conn.pragma_update(None, "user_version", 8)
            .map_err(|err| format!("could not update schema version: {err}"))?;
    }

    if version < 9 {
        conn.execute_batch(include_str!("../migrations/0009_frame_overlay_lesson_scoped.sql"))
            .map_err(|err| format!("migration 0009_frame_overlay_lesson_scoped failed: {err}"))?;
        conn.pragma_update(None, "user_version", 9)
            .map_err(|err| format!("could not update schema version: {err}"))?;
    }

    if version < 10 {
        conn.execute_batch(include_str!("../migrations/0010_frame_overlay_position.sql"))
            .map_err(|err| format!("migration 0010_frame_overlay_position failed: {err}"))?;
        conn.pragma_update(None, "user_version", 10)
            .map_err(|err| format!("could not update schema version: {err}"))?;
    }

    if version < 11 {
        conn.execute_batch(include_str!("../migrations/0011_video_transcript_source.sql"))
            .map_err(|err| format!("migration 0011_video_transcript_source failed: {err}"))?;
        conn.pragma_update(None, "user_version", 11)
            .map_err(|err| format!("could not update schema version: {err}"))?;
    }

    if version < 12 {
        conn.execute_batch(include_str!("../migrations/0012_lesson_regions.sql"))
            .map_err(|err| format!("migration 0012_lesson_regions failed: {err}"))?;
        conn.pragma_update(None, "user_version", 12)
            .map_err(|err| format!("could not update schema version: {err}"))?;
    }

    if version < 13 {
        conn.execute_batch(include_str!("../migrations/0013_lesson_slides.sql"))
            .map_err(|err| format!("migration 0013_lesson_slides failed: {err}"))?;
        conn.pragma_update(None, "user_version", 13)
            .map_err(|err| format!("could not update schema version: {err}"))?;
    }

    if version < 14 {
        conn.execute_batch(include_str!("../migrations/0014_transcript_words.sql"))
            .map_err(|err| format!("migration 0014_transcript_words failed: {err}"))?;
        conn.pragma_update(None, "user_version", 14)
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
        transcript_source: row.get("transcript_source")?,
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
            transcript_source: "whisper".to_string(),
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
            "SELECT id, project_id, file_path, duration, transcript_status, created_at, updated_at, audio_path, transcript_source
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
        "SELECT id, project_id, file_path, duration, transcript_status, created_at, updated_at, audio_path, transcript_source
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

/// Imports a WebVTT transcript file as `video_id`'s transcript, completely
/// bypassing Whisper — for videos where the user already has an accurate
/// transcript from the recording platform itself (e.g. a Zoom/Teams `.vtt`
/// export with real speaker names per cue), sidestepping Whisper's known
/// hallucination-on-silence failure mode entirely for that video. Local
/// file read + one DB transaction only — no network call, so this needs no
/// `coursecut-privacy-invariants` review (strictly reduces this video's
/// network exposure to zero, compared to the Whisper path).
///
/// Replaces this video's `transcript_segments` entirely (same
/// delete-then-insert-in-one-transaction pattern `openai.rs`'s
/// `run_transcription` uses for its own segments), all with `keep = 1` — no
/// hallucination flagging is run here (see `openai::flag_likely_hallucinations`),
/// since an imported ground-truth transcript has no Whisper-style
/// hallucination risk to flag. Sets `transcript_status = 'transcribed'`.
/// Available regardless of the video's current `transcript_status` — this
/// is always a valid way to (re)supply a transcript, including overriding
/// an already-completed Whisper transcription with the accurate ground
/// truth.
#[tauri::command(async)]
pub fn import_vtt_transcript(
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
    vtt_path: String,
) -> Result<Video, String> {
    let content = std::fs::read_to_string(&vtt_path)
        .map_err(|err| format!("could not read {vtt_path}: {err}"))?;
    // `parse_vtt` itself already errors rather than returning an empty
    // `Vec` for a file with no usable cues (see its own empty-cues check),
    // so `cues` is guaranteed non-empty here.
    let cues = crate::vtt::parse_vtt(&content)?;

    let now = chrono::Utc::now().to_rfc3339();
    {
        let mut guard = conn.0.lock().map_err(|err| err.to_string())?;
        let tx = guard.transaction().map_err(|err| err.to_string())?;

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

        tx.execute(
            "DELETE FROM transcript_segments WHERE video_id = ?1",
            params![video_id],
        )
        .map_err(|err| err.to_string())?;

        for cue in &cues {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO transcript_segments (id, video_id, start, end, text, keep)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                params![id, video_id, cue.start, cue.end, cue.text],
            )
            .map_err(|err| err.to_string())?;
        }
        // Word timestamps from an earlier Whisper pass stay: they time the
        // same audio, and save a Whisper call when the user edits by word.
        // Their removed flags followed the old segments' keep flags, which
        // are gone, so reset them to match the new all-kept segments.
        tx.execute(
            "UPDATE transcript_words SET removed = 0, suggested = NULL WHERE video_id = ?1",
            params![video_id],
        )
        .map_err(|err| err.to_string())?;
        tx.execute(
            "UPDATE videos SET transcript_status = 'transcribed', transcript_source = 'vtt', updated_at = ?1 WHERE id = ?2",
            params![now, video_id],
        )
        .map_err(|err| err.to_string())?;

        tx.commit().map_err(|err| err.to_string())?;
    }

    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    guard
        .query_row(
            "SELECT id, project_id, file_path, duration, transcript_status, created_at, updated_at, audio_path, transcript_source
             FROM videos WHERE id = ?1",
            params![video_id],
            row_to_video,
        )
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
    // One transaction: the segment's words must follow its keep flag
    // (`words.rs` invariant), or text editing would disagree with it.
    let tx = conn.unchecked_transaction().map_err(|err| err.to_string())?;
    let updated = tx
        .execute(
            "UPDATE transcript_segments SET keep = ?1 WHERE id = ?2",
            params![keep, id],
        )
        .map_err(|err| err.to_string())?;
    if updated == 0 {
        return Err(format!("transcript segment {id} does not exist"));
    }
    let row = tx
        .query_row(
            "SELECT id, video_id, start, end, text, keep FROM transcript_segments WHERE id = ?1",
            params![id],
            row_to_transcript_segment,
        )
        .map_err(|err| err.to_string())?;
    crate::words::set_removed_in_range(&tx, &row.video_id, row.start, row.end, !keep)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(row)
}

/// `pub(crate)` so `openai.rs`'s per-lesson AI edit commands (`preview_lesson_segment_edit`/
/// `apply_lesson_segment_edit`) can load a lesson's `video_id`/cached bounds without duplicating
/// this query.
pub(crate) fn query_lesson(conn: &Connection, id: &str) -> Result<LessonRow, String> {
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
/// `pub(crate)` so `openai.rs`'s `apply_lesson_segment_edit` can reuse this after rewriting a
/// lesson's `lesson_segments` rows, same as every in-module caller below.
pub(crate) fn recompute_lesson_bounds_tx(tx: &rusqlite::Transaction<'_>, lesson_id: &str) -> Result<(), String> {
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

/// Replaces a lesson's segments with `ranges`, in that order, in one
/// transaction (text editing: a Script-tab cut or restore, and undo/redo of
/// any segment edit, rewrite many rows at once and must not be left half
/// done by a crash or an error). Existing rows keep their ids, in order;
/// extra rows are deleted and missing ones inserted. Rejects an empty list
/// (deleting the lesson is a separate, explicit action) and any range with
/// `start >= end`.
fn replace_lesson_segments_tx(
    tx: &rusqlite::Transaction<'_>,
    lesson_id: &str,
    ranges: &[SegmentRange],
) -> Result<Vec<LessonSegmentRow>, String> {
    if ranges.is_empty() {
        return Err("a lesson needs at least one segment".to_string());
    }
    if let Some(bad) = ranges.iter().find(|range| !(range.start < range.end)) {
        return Err(format!(
            "invalid segment range: start ({}) must be before end ({})",
            bad.start, bad.end
        ));
    }
    let lesson = query_lesson(tx, lesson_id)?;
    let existing: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM lesson_segments WHERE lesson_id = ?1 ORDER BY sort_order, id")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![lesson_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())?
    };
    for (order, range) in ranges.iter().enumerate() {
        match existing.get(order) {
            Some(id) => tx.execute(
                "UPDATE lesson_segments SET start = ?1, end = ?2, sort_order = ?3 WHERE id = ?4",
                params![range.start, range.end, order as i64, id],
            ),
            None => tx.execute(
                "INSERT INTO lesson_segments (id, lesson_id, start, end, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![uuid::Uuid::new_v4().to_string(), lesson_id, range.start, range.end, order as i64],
            ),
        }
        .map_err(|err| err.to_string())?;
    }
    for id in existing.iter().skip(ranges.len()) {
        tx.execute("DELETE FROM lesson_segments WHERE id = ?1", params![id])
            .map_err(|err| err.to_string())?;
    }
    recompute_lesson_bounds_tx(tx, lesson_id)?;
    resequence_lessons(tx, &lesson.video_id)?;

    let mut stmt = tx
        .prepare(
            "SELECT id, lesson_id, start, end, sort_order FROM lesson_segments
             WHERE lesson_id = ?1 ORDER BY sort_order, id",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![lesson_id], row_to_lesson_segment)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn replace_lesson_segments(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
    ranges: Vec<SegmentRange>,
) -> Result<Vec<LessonSegmentRow>, String> {
    let mut conn = conn.0.lock().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let result = replace_lesson_segments_tx(&tx, &lesson_id, &ranges)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(result)
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

// ---------------------------------------------------------------------
// Frame overlays (0007_frame_overlays.sql, lesson-scoped since
// 0009_frame_overlay_lesson_scoped.sql): a still image composited over a
// lesson's existing frames for [start, end) during export only — never
// spliced into the timeline, never changes video
// duration/transcript_segments/audio. `start`/`end` are *virtual, stitched*
// seconds into this lesson's own final-video timeline (0 = the start of
// this lesson's output — same coordinate space as `LessonPreviewPlayer`'s
// scrubber and `segmentOffsets` there), not the source recording's raw
// seconds — deliberately lesson-scoped (not shareable across lessons of the
// same video) so a position picked against one lesson's Final-video preview
// can't silently land outside that lesson's own kept content. See
// `export.rs`'s `overlays_for_segment` for how a virtual range maps onto
// the lesson's actual `lesson_segments` at export time. `scale_percent`
// sizes the image relative to the main video (100 = fills the frame, lower
// shrinks it toward the center). `video_id` is still stored (derived from
// `lesson_id` at insert time, not taken from the caller) only to satisfy
// the original `NOT NULL` column from 0007 — not used by any query since
// the lesson-scoping pivot.
// ---------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct FrameOverlayRow {
    pub id: String,
    pub lesson_id: String,
    pub image_path: String,
    pub start: f64,
    pub end: f64,
    pub scale_percent: f64,
    /// 0-100: 0 = image's left edge at the frame's left edge, 100 = its
    /// right edge at the frame's right edge, 50 = centered (see
    /// `0010_frame_overlay_position.sql`).
    pub x_percent: f64,
    /// Same convention as `x_percent`, vertically (top/bottom edges).
    pub y_percent: f64,
    pub created_at: String,
}

fn row_to_frame_overlay(row: &rusqlite::Row<'_>) -> rusqlite::Result<FrameOverlayRow> {
    Ok(FrameOverlayRow {
        id: row.get("id")?,
        lesson_id: row.get("lesson_id")?,
        image_path: row.get("image_path")?,
        start: row.get("start")?,
        end: row.get("end")?,
        scale_percent: row.get("scale_percent")?,
        x_percent: row.get("x_percent")?,
        y_percent: row.get("y_percent")?,
        created_at: row.get("created_at")?,
    })
}

/// Read-only listing of a lesson's frame overlays, in start-time order.
#[tauri::command]
pub fn list_frame_overlays(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
) -> Result<Vec<FrameOverlayRow>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, lesson_id, image_path, start, end, scale_percent, x_percent, y_percent, created_at
             FROM frame_overlays WHERE lesson_id = ?1 ORDER BY start",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![lesson_id], row_to_frame_overlay)
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn validate_overlay_bounds(
    start: f64,
    end: f64,
    scale_percent: f64,
    x_percent: f64,
    y_percent: f64,
) -> Result<(), String> {
    if start < 0.0 {
        return Err(format!("invalid overlay start: {start} must be 0 or greater"));
    }
    if start >= end {
        return Err(format!(
            "invalid overlay range: start ({start}) must be before end ({end})"
        ));
    }
    if !(scale_percent > 0.0 && scale_percent <= 100.0) {
        return Err(format!(
            "invalid overlay scale: {scale_percent}% must be greater than 0 and at most 100"
        ));
    }
    if !(0.0..=100.0).contains(&x_percent) {
        return Err(format!("invalid overlay x position: {x_percent}% must be between 0 and 100"));
    }
    if !(0.0..=100.0).contains(&y_percent) {
        return Err(format!("invalid overlay y position: {y_percent}% must be between 0 and 100"));
    }
    Ok(())
}

#[tauri::command]
pub fn add_frame_overlay(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
    image_path: String,
    start: f64,
    end: f64,
    scale_percent: f64,
    x_percent: f64,
    y_percent: f64,
) -> Result<FrameOverlayRow, String> {
    validate_overlay_bounds(start, end, scale_percent, x_percent, y_percent)?;

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    let video_id: String = conn
        .query_row(
            "SELECT video_id FROM lessons WHERE id = ?1",
            params![lesson_id],
            |row| row.get(0),
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => format!("lesson {lesson_id} does not exist"),
            other => other.to_string(),
        })?;
    conn.execute(
        "INSERT INTO frame_overlays (id, video_id, lesson_id, image_path, start, end, scale_percent, x_percent, y_percent, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, video_id, lesson_id, image_path, start, end, scale_percent, x_percent, y_percent, now],
    )
    .map_err(|err| err.to_string())?;

    Ok(FrameOverlayRow {
        id,
        lesson_id,
        image_path,
        start,
        end,
        scale_percent,
        x_percent,
        y_percent,
        created_at: now,
    })
}

/// Updates an overlay's timing/size/position in place — unlike
/// `lesson_segments`, this *does* get a real update command (not delete-
/// and-re-add): editing an overlay is a routine, frequent action (nudging a
/// start time, tweaking scale or position) that deserves a proper in-place
/// edit in the UI rather than forcing a fresh id and losing the row's place
/// in the list on every tweak. `image_path`/`lesson_id` aren't editable
/// here — swapping the picture or moving an overlay to a different lesson
/// is a delete + re-add, same as before.
#[tauri::command]
pub fn update_frame_overlay(
    conn: tauri::State<'_, DbConnection>,
    id: String,
    start: f64,
    end: f64,
    scale_percent: f64,
    x_percent: f64,
    y_percent: f64,
) -> Result<FrameOverlayRow, String> {
    validate_overlay_bounds(start, end, scale_percent, x_percent, y_percent)?;

    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    let affected = conn
        .execute(
            "UPDATE frame_overlays SET start = ?1, end = ?2, scale_percent = ?3, x_percent = ?4, y_percent = ?5
             WHERE id = ?6",
            params![start, end, scale_percent, x_percent, y_percent, id],
        )
        .map_err(|err| err.to_string())?;
    if affected == 0 {
        return Err(format!("frame overlay {id} does not exist"));
    }

    conn.query_row(
        "SELECT id, lesson_id, image_path, start, end, scale_percent, x_percent, y_percent, created_at
         FROM frame_overlays WHERE id = ?1",
        params![id],
        row_to_frame_overlay,
    )
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn delete_frame_overlay(conn: tauri::State<'_, DbConnection>, id: String) -> Result<(), String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    conn.execute("DELETE FROM frame_overlays WHERE id = ?1", params![id])
        .map_err(|err| err.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------
// Lesson regions (0012_lesson_regions.sql): static shape layers (blurred or
// solid rect / rounded rect / ellipse) between two timestamps, export-only
// like frame overlays. `start`/`end` are on the same virtual lesson timeline
// as `frame_overlays`; see `export.rs::regions_for_segment` for the mapping
// onto lesson segments.
// ---------------------------------------------------------------------

/// Upper bound for `blur_strength` (boxblur radius in source pixels). The
/// export additionally caps it per rect so ffmpeg accepts it.
const MAX_BLUR_STRENGTH: i64 = 100;

const REGION_COLUMNS: &str = "id, lesson_id, start, end, x_percent, y_percent, w_percent, h_percent, \
     shape, fill, blur_strength, color, created_at";

#[derive(Debug, Clone, Serialize)]
pub struct LessonRegionRow {
    pub id: String,
    pub lesson_id: String,
    pub start: f64,
    pub end: f64,
    pub x_percent: f64,
    pub y_percent: f64,
    pub w_percent: f64,
    pub h_percent: f64,
    /// `"rect"`, `"rounded"` or `"ellipse"`.
    pub shape: String,
    /// `"blur"` or `"solid"`.
    pub fill: String,
    pub blur_strength: i64,
    /// `#rrggbb`, used when `fill` is `"solid"`.
    pub color: String,
    pub created_at: String,
}

/// The caller-editable fields of a region, shared by `add_lesson_region`
/// and `update_lesson_region`.
#[derive(Debug, Clone, Deserialize)]
pub struct RegionInput {
    pub start: f64,
    pub end: f64,
    pub x_percent: f64,
    pub y_percent: f64,
    pub w_percent: f64,
    pub h_percent: f64,
    pub shape: String,
    pub fill: String,
    pub blur_strength: i64,
    pub color: String,
}

fn row_to_lesson_region(row: &rusqlite::Row<'_>) -> rusqlite::Result<LessonRegionRow> {
    Ok(LessonRegionRow {
        id: row.get("id")?,
        lesson_id: row.get("lesson_id")?,
        start: row.get("start")?,
        end: row.get("end")?,
        x_percent: row.get("x_percent")?,
        y_percent: row.get("y_percent")?,
        w_percent: row.get("w_percent")?,
        h_percent: row.get("h_percent")?,
        shape: row.get("shape")?,
        fill: row.get("fill")?,
        blur_strength: row.get("blur_strength")?,
        color: row.get("color")?,
        created_at: row.get("created_at")?,
    })
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Field-level checks for a region's caller-editable fields.
fn validate_region(region: &RegionInput) -> Result<(), String> {
    if !region.start.is_finite() || region.start < 0.0 {
        return Err(format!("invalid region start: {} must be 0 or greater", region.start));
    }
    if !region.end.is_finite() || region.start >= region.end {
        return Err(format!(
            "invalid region range: start ({}) must be before end ({})",
            region.start, region.end
        ));
    }
    // Rounding slack for a rect dragged right up to the frame edge.
    let in_frame = |pos: f64, size: f64| pos.is_finite() && size.is_finite() && pos >= 0.0 && size > 0.0 && pos + size <= 100.0 + 1e-6;
    if !in_frame(region.x_percent, region.w_percent) || !in_frame(region.y_percent, region.h_percent) {
        return Err("invalid region rect: it must have a size and lie inside the frame (0-100%)".to_string());
    }
    if !matches!(region.shape.as_str(), "rect" | "rounded" | "ellipse") {
        return Err(format!(
            "invalid region shape {:?}: must be \"rect\", \"rounded\" or \"ellipse\"",
            region.shape
        ));
    }
    if !matches!(region.fill.as_str(), "blur" | "solid") {
        return Err(format!("invalid region fill {:?}: must be \"blur\" or \"solid\"", region.fill));
    }
    if !(1..=MAX_BLUR_STRENGTH).contains(&region.blur_strength) {
        return Err(format!(
            "invalid blur strength {}: must be between 1 and {MAX_BLUR_STRENGTH}",
            region.blur_strength
        ));
    }
    if !is_hex_color(&region.color) {
        return Err(format!("invalid region colour {:?}: must be #rrggbb", region.color));
    }
    Ok(())
}

/// Every region of `lesson_id`, in start-time order.
pub(crate) fn query_lesson_regions(conn: &Connection, lesson_id: &str) -> Result<Vec<LessonRegionRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {REGION_COLUMNS} FROM lesson_regions WHERE lesson_id = ?1 ORDER BY start, created_at, id"
        ))
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![lesson_id], row_to_lesson_region)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

fn query_lesson_region(conn: &Connection, id: &str) -> Result<LessonRegionRow, String> {
    conn.query_row(
        &format!("SELECT {REGION_COLUMNS} FROM lesson_regions WHERE id = ?1"),
        params![id],
        row_to_lesson_region,
    )
    .map_err(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => format!("region {id} does not exist"),
        other => other.to_string(),
    })
}

fn add_lesson_region_conn(conn: &Connection, lesson_id: &str, region: &RegionInput) -> Result<LessonRegionRow, String> {
    let lesson_exists: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM lessons WHERE id = ?1)", params![lesson_id], |row| {
            row.get(0)
        })
        .map_err(|err| err.to_string())?;
    if !lesson_exists {
        return Err(format!("lesson {lesson_id} does not exist"));
    }
    validate_region(region)?;

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO lesson_regions (id, lesson_id, start, end, x_percent, y_percent, w_percent, h_percent,
                                     shape, fill, blur_strength, color, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            lesson_id,
            region.start,
            region.end,
            region.x_percent,
            region.y_percent,
            region.w_percent,
            region.h_percent,
            region.shape,
            region.fill,
            region.blur_strength,
            region.color,
            now
        ],
    )
    .map_err(|err| err.to_string())?;
    query_lesson_region(conn, &id)
}

fn update_lesson_region_conn(conn: &Connection, id: &str, region: &RegionInput) -> Result<LessonRegionRow, String> {
    query_lesson_region(conn, id)?;
    validate_region(region)?;
    conn.execute(
        "UPDATE lesson_regions SET start = ?1, end = ?2, x_percent = ?3, y_percent = ?4, w_percent = ?5,
                h_percent = ?6, shape = ?7, fill = ?8, blur_strength = ?9, color = ?10
         WHERE id = ?11",
        params![
            region.start,
            region.end,
            region.x_percent,
            region.y_percent,
            region.w_percent,
            region.h_percent,
            region.shape,
            region.fill,
            region.blur_strength,
            region.color,
            id
        ],
    )
    .map_err(|err| err.to_string())?;
    query_lesson_region(conn, id)
}

#[tauri::command]
pub fn list_lesson_regions(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
) -> Result<Vec<LessonRegionRow>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    query_lesson_regions(&conn, &lesson_id)
}

#[tauri::command]
pub fn add_lesson_region(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
    region: RegionInput,
) -> Result<LessonRegionRow, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    add_lesson_region_conn(&conn, &lesson_id, &region)
}

#[tauri::command]
pub fn update_lesson_region(
    conn: tauri::State<'_, DbConnection>,
    id: String,
    region: RegionInput,
) -> Result<LessonRegionRow, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    update_lesson_region_conn(&conn, &id, &region)
}

#[tauri::command]
pub fn delete_lesson_region(conn: tauri::State<'_, DbConnection>, id: String) -> Result<(), String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    conn.execute("DELETE FROM lesson_regions WHERE id = ?1", params![id])
        .map_err(|err| err.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------
// Lesson slides (0013_lesson_slides.sql): at most one intro and one outro
// per lesson, each an image or a frontend-rendered title card, either
// inserted as its own piece of video or overlaid on the first/last seconds
// of the lesson. See `export.rs` for how each mode is exported.
// ---------------------------------------------------------------------

const SLIDE_COLUMNS: &str = "id, lesson_id, position, mode, duration, kind, image_path, title, subtitle, \
     bg_color, text_color, mute_audio, created_at";

#[derive(Debug, Clone, Serialize)]
pub struct LessonSlideRow {
    pub id: String,
    pub lesson_id: String,
    /// `"intro"` or `"outro"`.
    pub position: String,
    /// `"insert"` or `"overlay"`.
    pub mode: String,
    pub duration: f64,
    /// `"image"` or `"title"`.
    pub kind: String,
    pub image_path: String,
    pub title: String,
    pub subtitle: String,
    pub bg_color: String,
    pub text_color: String,
    pub mute_audio: bool,
    pub created_at: String,
}

/// The caller-editable fields of a slide. `position` is the upsert key: a
/// lesson has at most one slide per position.
#[derive(Debug, Clone, Deserialize)]
pub struct SlideInput {
    pub position: String,
    pub mode: String,
    pub duration: f64,
    pub kind: String,
    pub image_path: String,
    pub title: String,
    pub subtitle: String,
    pub bg_color: String,
    pub text_color: String,
    pub mute_audio: bool,
}

fn row_to_lesson_slide(row: &rusqlite::Row<'_>) -> rusqlite::Result<LessonSlideRow> {
    Ok(LessonSlideRow {
        id: row.get("id")?,
        lesson_id: row.get("lesson_id")?,
        position: row.get("position")?,
        mode: row.get("mode")?,
        duration: row.get("duration")?,
        kind: row.get("kind")?,
        image_path: row.get("image_path")?,
        title: row.get("title")?,
        subtitle: row.get("subtitle")?,
        bg_color: row.get("bg_color")?,
        text_color: row.get("text_color")?,
        mute_audio: row.get("mute_audio")?,
        created_at: row.get("created_at")?,
    })
}

fn validate_slide(slide: &SlideInput) -> Result<(), String> {
    if !matches!(slide.position.as_str(), "intro" | "outro") {
        return Err(format!("invalid slide position {:?}: must be \"intro\" or \"outro\"", slide.position));
    }
    if !matches!(slide.mode.as_str(), "insert" | "overlay") {
        return Err(format!("invalid slide mode {:?}: must be \"insert\" or \"overlay\"", slide.mode));
    }
    if !matches!(slide.kind.as_str(), "image" | "title") {
        return Err(format!("invalid slide kind {:?}: must be \"image\" or \"title\"", slide.kind));
    }
    if !slide.duration.is_finite() || slide.duration <= 0.0 {
        return Err(format!("invalid slide duration {}: must be greater than 0", slide.duration));
    }
    if slide.image_path.trim().is_empty() {
        return Err("a slide needs an image".to_string());
    }
    if slide.kind == "title" && slide.title.trim().is_empty() {
        return Err("a title card needs a title".to_string());
    }
    if !is_hex_color(&slide.bg_color) || !is_hex_color(&slide.text_color) {
        return Err(format!(
            "invalid slide colours {:?}/{:?}: must be #rrggbb",
            slide.bg_color, slide.text_color
        ));
    }
    Ok(())
}

/// Every slide of `lesson_id` (intro first).
pub(crate) fn query_lesson_slides(conn: &Connection, lesson_id: &str) -> Result<Vec<LessonSlideRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SLIDE_COLUMNS} FROM lesson_slides WHERE lesson_id = ?1
             ORDER BY CASE position WHEN 'intro' THEN 0 ELSE 1 END"
        ))
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![lesson_id], row_to_lesson_slide)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

/// Inserts the lesson's slide at `slide.position`, or replaces the fields of
/// the one already there (keeping its id).
fn upsert_lesson_slide_conn(conn: &Connection, lesson_id: &str, slide: &SlideInput) -> Result<LessonSlideRow, String> {
    let lesson_exists: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM lessons WHERE id = ?1)", params![lesson_id], |row| {
            row.get(0)
        })
        .map_err(|err| err.to_string())?;
    if !lesson_exists {
        return Err(format!("lesson {lesson_id} does not exist"));
    }
    validate_slide(slide)?;

    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM lesson_slides WHERE lesson_id = ?1 AND position = ?2",
            params![lesson_id, slide.position],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;

    let id = match existing {
        Some(id) => {
            conn.execute(
                "UPDATE lesson_slides SET mode = ?1, duration = ?2, kind = ?3, image_path = ?4, title = ?5,
                        subtitle = ?6, bg_color = ?7, text_color = ?8, mute_audio = ?9
                 WHERE id = ?10",
                params![
                    slide.mode,
                    slide.duration,
                    slide.kind,
                    slide.image_path,
                    slide.title,
                    slide.subtitle,
                    slide.bg_color,
                    slide.text_color,
                    slide.mute_audio,
                    id
                ],
            )
            .map_err(|err| err.to_string())?;
            id
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO lesson_slides (id, lesson_id, position, mode, duration, kind, image_path, title,
                                            subtitle, bg_color, text_color, mute_audio, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    id,
                    lesson_id,
                    slide.position,
                    slide.mode,
                    slide.duration,
                    slide.kind,
                    slide.image_path,
                    slide.title,
                    slide.subtitle,
                    slide.bg_color,
                    slide.text_color,
                    slide.mute_audio,
                    now
                ],
            )
            .map_err(|err| err.to_string())?;
            id
        }
    };

    conn.query_row(
        &format!("SELECT {SLIDE_COLUMNS} FROM lesson_slides WHERE id = ?1"),
        params![id],
        row_to_lesson_slide,
    )
    .map_err(|err| err.to_string())
}

/// Rendered title cards live in `<cache_dir>/slides/<uuid>.png`: inside the
/// asset-protocol scope (`$APPCACHE/**`), so the preview can show them.
fn slides_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("slides")
}

fn app_slides_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("could not resolve app cache dir: {err}"))?;
    Ok(slides_dir(&cache_dir))
}

/// Whether `path` is one of this app's own rendered title cards (a `.png`
/// directly inside `slides_dir`), as opposed to a user's own image, which
/// must never be deleted.
fn is_own_title_card(slides_dir: &Path, path: &str) -> bool {
    let candidate = Path::new(path);
    candidate.parent() == Some(slides_dir)
        && candidate
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
}

/// Startup cleanup: deletes every rendered title card no slide row points
/// at any more. This is the *only* place title cards are deleted: an edit
/// (which re-renders to a new file) or a delete leaves the old PNG on disk,
/// because an export that read the slide row before the edit may still be
/// about to encode from it (the outro piece is encoded last). No export is
/// running at startup (`reconcile_interrupted_exports` resets them), so
/// anything unreferenced here is safe to remove: replaced or deleted cards,
/// cards of deleted lessons (rows cascade, files don't), and a card saved by
/// `save_title_card_png` whose upsert then failed. Best-effort per file.
pub fn sweep_orphan_title_cards(conn: &Connection, cache_dir: &Path) -> Result<(), String> {
    let dir = slides_dir(cache_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(());
    };
    let mut stmt = conn
        .prepare("SELECT image_path FROM lesson_slides")
        .map_err(|err| err.to_string())?;
    let used: HashSet<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|err| err.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(path_str) = path.to_str() else { continue };
        if is_own_title_card(&dir, path_str) && !used.contains(path_str) {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

/// Re-allows every image slide's user-picked file in the asset-protocol
/// scope at startup, same reason as `allow_existing_video_playback`. Title
/// cards are in the app cache dir, which is always in scope.
pub fn allow_existing_slide_images(app: &AppHandle, conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT image_path FROM lesson_slides WHERE kind = 'image'")
        .map_err(|err| err.to_string())?;
    let paths = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;
    for path in paths {
        allow_video_playback(app, &path.map_err(|err| err.to_string())?);
    }
    Ok(())
}

/// Writes a title card PNG, rendered by the frontend's `<canvas>`, into the
/// app cache's `slides` dir and returns its path for the slide's
/// `image_path`. The bytes arrive as the raw IPC body, not JSON. Local only.
#[tauri::command]
pub fn save_title_card_png(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw PNG bytes".to_string());
    };
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("title card is not a PNG".to_string());
    }
    let dir = app_slides_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("could not create slides dir: {err}"))?;
    let path = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).map_err(|err| format!("could not save title card: {err}"))?;
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| "title card path is not valid UTF-8".to_string())
}

#[tauri::command]
pub fn list_lesson_slides(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
) -> Result<Vec<LessonSlideRow>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    query_lesson_slides(&conn, &lesson_id)
}

/// Creates or replaces the lesson's intro or outro (`slide.position`). A
/// replaced title card PNG is left on disk for a running export; see
/// `sweep_orphan_title_cards`.
#[tauri::command]
pub fn upsert_lesson_slide(
    app: AppHandle,
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
    slide: SlideInput,
) -> Result<LessonSlideRow, String> {
    let row = {
        let conn = conn.0.lock().map_err(|err| err.to_string())?;
        upsert_lesson_slide_conn(&conn, &lesson_id, &slide)?
    };
    if row.kind == "image" {
        allow_video_playback(&app, &row.image_path);
    }
    Ok(row)
}

/// Deletes a slide row. Its title card PNG, if any, is reclaimed by the next
/// startup's `sweep_orphan_title_cards`, not here.
#[tauri::command]
pub fn delete_lesson_slide(conn: tauri::State<'_, DbConnection>, id: String) -> Result<(), String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    conn.execute("DELETE FROM lesson_slides WHERE id = ?1", params![id])
        .map_err(|err| err.to_string())?;
    Ok(())
}

/// One `{start, end}` range. Originally just the frontend's Create Lesson
/// modal's input shape (already collapsed from a transcript-segment
/// checkbox selection into contiguous runs, see
/// `src/components/CreateLessonModal.tsx` — a non-contiguous checked
/// selection arrives here as more than one `SegmentRange`); also reused by
/// `openai.rs`'s per-lesson AI edit commands, which both take and return
/// this shape over IPC (hence `Serialize` too, not just `Deserialize`).
/// Plain IPC value, not a table row.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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
    fn replace_lesson_segments_splits_keeps_ids_and_rejects_empty() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();
        let range = |start: f64, end: f64| SegmentRange { start, end };
        let rows = replace_lesson_segments_tx(&tx, "l0", &[range(0.0, 4.0), range(5.0, 10.0)]).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "s0", "first row keeps its id");
        assert_eq!((rows[1].start, rows[1].end, rows[1].sort_order), (5.0, 10.0, 1));

        let rows = replace_lesson_segments_tx(&tx, "l0", &[range(0.0, 10.0)]).unwrap();
        assert_eq!(rows.len(), 1, "joining deletes the extra row");
        assert_eq!(rows[0].id, "s0");

        assert!(replace_lesson_segments_tx(&tx, "l0", &[]).is_err());
        assert!(replace_lesson_segments_tx(&tx, "l0", &[range(3.0, 3.0)]).is_err());
        let lesson = query_lesson(&tx, "l0").unwrap();
        assert_eq!((lesson.start, lesson.end), (0.0, 10.0), "bounds recomputed");
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

#[cfg(test)]
mod lesson_region_tests {
    use super::*;

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
        for id in ["l1", "l2"] {
            conn.execute(
                "INSERT INTO lessons (id, video_id, title, start, end) VALUES (?1, 'v1', 'Lesson', 0, 60)",
                params![id],
            )
            .unwrap();
        }
        conn
    }

    fn input(start: f64, end: f64) -> RegionInput {
        RegionInput {
            start,
            end,
            x_percent: 10.0,
            y_percent: 10.0,
            w_percent: 50.0,
            h_percent: 50.0,
            shape: "rect".into(),
            fill: "blur".into(),
            blur_strength: 20,
            color: "#000000".into(),
        }
    }

    #[test]
    fn add_and_list_round_trips_every_field() {
        let conn = seeded_conn();
        let mut region = input(1.0, 4.0);
        region.shape = "ellipse".into();
        region.fill = "solid".into();
        region.color = "#ff00AA".into();
        region.w_percent = 30.0;
        let added = add_lesson_region_conn(&conn, "l1", &region).unwrap();
        let listed = query_lesson_regions(&conn, "l1").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, added.id);
        assert_eq!(listed[0].shape, "ellipse");
        assert_eq!(listed[0].fill, "solid");
        assert_eq!(listed[0].color, "#ff00AA");
        assert_eq!(listed[0].w_percent, 30.0);
        assert_eq!(listed[0].h_percent, 50.0);
        assert!(query_lesson_regions(&conn, "l2").unwrap().is_empty());
    }

    #[test]
    fn overlapping_shapes_are_allowed() {
        let conn = seeded_conn();
        add_lesson_region_conn(&conn, "l1", &input(5.0, 10.0)).unwrap();
        add_lesson_region_conn(&conn, "l1", &input(6.0, 9.0)).unwrap();
        add_lesson_region_conn(&conn, "l1", &input(6.0, 9.0)).unwrap();
        assert_eq!(query_lesson_regions(&conn, "l1").unwrap().len(), 3);
    }

    #[test]
    fn update_changes_fields_and_validates() {
        let conn = seeded_conn();
        let first = add_lesson_region_conn(&conn, "l1", &input(0.0, 5.0)).unwrap();
        let updated = update_lesson_region_conn(
            &conn,
            &first.id,
            &RegionInput { shape: "rounded".into(), w_percent: 20.0, ..input(1.0, 6.0) },
        )
        .unwrap();
        assert_eq!(updated.start, 1.0);
        assert_eq!(updated.shape, "rounded");
        assert_eq!(updated.w_percent, 20.0);
        assert!(update_lesson_region_conn(&conn, &first.id, &input(6.0, 1.0)).is_err());
        assert!(update_lesson_region_conn(&conn, "missing", &input(0.0, 1.0)).is_err());
    }

    #[test]
    fn invalid_fields_are_rejected() {
        let conn = seeded_conn();
        let cases: Vec<RegionInput> = vec![
            input(5.0, 5.0),
            input(-1.0, 5.0),
            RegionInput { x_percent: 60.0, ..input(0.0, 1.0) },
            RegionInput { w_percent: 0.0, ..input(0.0, 1.0) },
            RegionInput { shape: "star".into(), ..input(0.0, 1.0) },
            RegionInput { fill: "pixelate".into(), ..input(0.0, 1.0) },
            RegionInput { blur_strength: 0, ..input(0.0, 1.0) },
            RegionInput { color: "red".into(), ..input(0.0, 1.0) },
        ];
        for region in cases {
            assert!(
                add_lesson_region_conn(&conn, "l1", &region).is_err(),
                "expected rejection for {region:?}"
            );
        }
        assert!(add_lesson_region_conn(&conn, "missing", &input(0.0, 1.0)).is_err());
        assert!(query_lesson_regions(&conn, "l1").unwrap().is_empty());
    }

    #[test]
    fn deleting_the_lesson_cascades_to_its_regions() {
        let conn = seeded_conn();
        add_lesson_region_conn(&conn, "l1", &input(0.0, 1.0)).unwrap();
        conn.execute("DELETE FROM lessons WHERE id = 'l1'", []).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM lesson_regions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}

/// Test-only access to the validated insert, for other modules' tests.
#[cfg(test)]
pub(crate) fn add_lesson_region_for_test(
    conn: &Connection,
    lesson_id: &str,
    region: &RegionInput,
) -> Result<LessonRegionRow, String> {
    add_lesson_region_conn(conn, lesson_id, region)
}

#[cfg(test)]
mod lesson_slide_tests {
    use super::*;

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
        for id in ["l1", "l2"] {
            conn.execute(
                "INSERT INTO lessons (id, video_id, title, start, end) VALUES (?1, 'v1', 'Lesson', 0, 60)",
                params![id],
            )
            .unwrap();
        }
        conn
    }

    fn input(position: &str) -> SlideInput {
        SlideInput {
            position: position.into(),
            mode: "insert".into(),
            duration: 4.0,
            kind: "image".into(),
            image_path: "/tmp/slide.png".into(),
            title: String::new(),
            subtitle: String::new(),
            bg_color: "#111827".into(),
            text_color: "#ffffff".into(),
            mute_audio: false,
        }
    }

    #[test]
    fn upsert_inserts_then_replaces_by_position() {
        let conn = seeded_conn();
        let intro = upsert_lesson_slide_conn(&conn, "l1", &input("intro")).unwrap();
        let outro = upsert_lesson_slide_conn(&conn, "l1", &input("outro")).unwrap();
        assert_ne!(intro.id, outro.id);

        let edited = SlideInput {
            mode: "overlay".into(),
            duration: 2.5,
            kind: "title".into(),
            image_path: "/cache/slides/new.png".into(),
            title: "Welcome".into(),
            subtitle: "Module 1".into(),
            mute_audio: true,
            ..input("intro")
        };
        let updated = upsert_lesson_slide_conn(&conn, "l1", &edited).unwrap();
        assert_eq!(updated.id, intro.id, "same position keeps the row");
        assert_eq!(updated.image_path, "/cache/slides/new.png");
        assert_eq!(
            (updated.mode.as_str(), updated.duration, updated.kind.as_str(), updated.mute_audio),
            ("overlay", 2.5, "title", true)
        );
        assert_eq!((updated.title.as_str(), updated.subtitle.as_str()), ("Welcome", "Module 1"));

        let listed = query_lesson_slides(&conn, "l1").unwrap();
        assert_eq!(
            listed.iter().map(|slide| slide.position.as_str()).collect::<Vec<_>>(),
            ["intro", "outro"]
        );
        assert!(query_lesson_slides(&conn, "l2").unwrap().is_empty());
    }

    #[test]
    fn the_database_enforces_one_slide_per_position() {
        let conn = seeded_conn();
        upsert_lesson_slide_conn(&conn, "l1", &input("intro")).unwrap();
        let duplicate = conn.execute(
            "INSERT INTO lesson_slides (id, lesson_id, position, mode, duration, kind, image_path, created_at)
             VALUES ('dup', 'l1', 'intro', 'insert', 3, 'image', '/tmp/x.png', 't')",
            [],
        );
        assert!(duplicate.is_err());
        // The other lesson may have its own intro.
        upsert_lesson_slide_conn(&conn, "l2", &input("intro")).unwrap();
    }

    #[test]
    fn invalid_fields_are_rejected() {
        let conn = seeded_conn();
        let cases = vec![
            SlideInput { position: "middle".into(), ..input("intro") },
            SlideInput { mode: "replace".into(), ..input("intro") },
            SlideInput { kind: "video".into(), ..input("intro") },
            SlideInput { duration: 0.0, ..input("intro") },
            SlideInput { duration: -1.0, ..input("intro") },
            SlideInput { duration: f64::NAN, ..input("intro") },
            SlideInput { image_path: " ".into(), ..input("intro") },
            SlideInput { kind: "title".into(), title: " ".into(), ..input("intro") },
            SlideInput { bg_color: "black".into(), ..input("intro") },
            SlideInput { text_color: "#fff".into(), ..input("intro") },
            SlideInput { text_color: "#gggggg".into(), ..input("intro") },
        ];
        for slide in cases {
            assert!(
                upsert_lesson_slide_conn(&conn, "l1", &slide).is_err(),
                "expected rejection for {slide:?}"
            );
        }
        assert!(upsert_lesson_slide_conn(&conn, "missing", &input("intro")).is_err());
        assert!(query_lesson_slides(&conn, "l1").unwrap().is_empty());
    }

    #[test]
    fn deleting_the_lesson_cascades_to_its_slides() {
        let conn = seeded_conn();
        upsert_lesson_slide_conn(&conn, "l1", &input("outro")).unwrap();
        conn.execute("DELETE FROM lessons WHERE id = 'l1'", []).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM lesson_slides", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    /// Replacing or deleting a title card leaves its PNG on disk (an export
    /// may still be about to read it); the startup sweep reclaims it once
    /// no row points at it, and keeps the one still in use.
    #[test]
    fn replaced_title_cards_stay_until_the_startup_sweep() {
        let cache_dir = std::env::temp_dir().join(format!("coursecut-slides-test-{}", uuid::Uuid::new_v4()));
        let dir = slides_dir(&cache_dir);
        std::fs::create_dir_all(&dir).unwrap();
        let used = dir.join("used.png");
        let orphan = dir.join("orphan.png");
        let other = dir.join("notes.txt");
        for path in [&used, &orphan, &other] {
            std::fs::write(path, b"x").unwrap();
        }

        assert!(is_own_title_card(&dir, used.to_str().unwrap()));
        assert!(!is_own_title_card(&dir, other.to_str().unwrap()));
        assert!(!is_own_title_card(&dir, "/Users/someone/Desktop/slide.png"));
        assert!(!is_own_title_card(&dir, dir.join("nested/x.png").to_str().unwrap()));

        let conn = seeded_conn();
        let card = |path: &std::path::Path| SlideInput {
            kind: "title".into(),
            title: "Hi".into(),
            image_path: path.to_str().unwrap().into(),
            ..input("intro")
        };
        // The intro was the "orphan" card, then got re-rendered to `used`.
        upsert_lesson_slide_conn(&conn, "l1", &card(&orphan)).unwrap();
        upsert_lesson_slide_conn(&conn, "l1", &card(&used)).unwrap();
        assert!(orphan.exists(), "an edit doesn't delete the old card");
        // An outro card, then the outro deleted.
        let gone = dir.join("deleted-outro.png");
        std::fs::write(&gone, b"x").unwrap();
        let outro = upsert_lesson_slide_conn(&conn, "l1", &SlideInput { position: "outro".into(), ..card(&gone) }).unwrap();
        conn.execute("DELETE FROM lesson_slides WHERE id = ?1", params![outro.id]).unwrap();
        assert!(gone.exists(), "a delete doesn't delete the card");

        sweep_orphan_title_cards(&conn, &cache_dir).unwrap();
        assert!(used.exists());
        assert!(!orphan.exists());
        assert!(!gone.exists());
        assert!(other.exists(), "only PNGs are swept");

        // A missing slides dir is fine.
        sweep_orphan_title_cards(&conn, &cache_dir.join("nope")).unwrap();
        let _ = std::fs::remove_dir_all(&cache_dir);
    }
}
