//! Small, non-secret app-wide settings backed by the `app_settings`
//! key-value table (`0004_app_settings.sql`). Distinct from
//! `src-tauri/src/settings.rs`, which stores the OpenAI API key — a secret,
//! kept in the OS keychain, never in SQLite. This module is for plain user
//! text, so SQLite is the right place for it.
//!
//! Only one key exists today (`analysis_instructions`, PRD §7.5 — free text
//! the user can supply to steer GPT-5.5's lesson-boundary analysis). The
//! table itself is generic so future simple settings don't each need a new
//! migration/table, but the commands here are deliberately specific to this
//! one key rather than a generic "get/set any key" IPC surface.

use rusqlite::{params, OptionalExtension};

use crate::db::DbConnection;

const ANALYSIS_INSTRUCTIONS_KEY: &str = "analysis_instructions";

/// Reads the stored analysis instructions directly against an already-held
/// connection, for callers (e.g. `openai.rs`'s `analyze_video`) that already
/// hold the `DbConnection` lock and shouldn't re-acquire it through the
/// `#[tauri::command]` wrapper below. Returns `None` if no row exists.
pub(crate) fn read_analysis_instructions(
    conn: &rusqlite::Connection,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![ANALYSIS_INSTRUCTIONS_KEY],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

/// Saves the user's free-text analysis instructions (PRD §7.5). Trims the
/// input first; if empty after trimming, deletes any existing row instead of
/// storing an empty string, so clearing the field means "no instructions"
/// rather than an empty-string row sitting around.
#[tauri::command]
pub fn save_analysis_instructions(
    conn: tauri::State<'_, DbConnection>,
    instructions: String,
) -> Result<(), String> {
    let instructions = instructions.trim().to_string();
    let guard = conn.0.lock().map_err(|err| err.to_string())?;

    if instructions.is_empty() {
        guard
            .execute(
                "DELETE FROM app_settings WHERE key = ?1",
                params![ANALYSIS_INSTRUCTIONS_KEY],
            )
            .map_err(|err| err.to_string())?;
        return Ok(());
    }

    let now = chrono::Utc::now().to_rfc3339();
    guard
        .execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![ANALYSIS_INSTRUCTIONS_KEY, instructions, now],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_analysis_instructions(
    conn: tauri::State<'_, DbConnection>,
) -> Result<Option<String>, String> {
    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    read_analysis_instructions(&guard)
}
