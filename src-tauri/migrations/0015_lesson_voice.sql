-- AI voice V2 (docs/hcm-improvements-plan.md §4): the voice track made
-- for a lesson, so the editor finds it again and exports can use it.
--
-- One row per lesson. `track_json` is the `VoiceTrack` returned by
-- `generate_lesson_voice` (its WAV lives in the app cache; a missing file
-- reads as "no voice"). `signature` is the editor's own script+voice
-- signature (stale check in the UI); `script_hash` is the Rust-side hash
-- of the lesson's segments and words, which an export checks so it never
-- lays an out-of-sync voice on an edited lesson.
CREATE TABLE lesson_voice (
    lesson_id TEXT PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
    use_in_export INTEGER NOT NULL DEFAULT 1,
    signature TEXT NOT NULL,
    script_hash TEXT NOT NULL,
    track_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
