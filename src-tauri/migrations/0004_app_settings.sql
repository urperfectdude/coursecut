-- Generic key-value table for small app-wide settings that don't warrant
-- their own single-purpose table (e.g. the analysis-instructions free text,
-- PRD §7.5). Not for secrets — the OpenAI API key stays in the OS keychain
-- (see `src-tauri/src/settings.rs`), never here.

CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
