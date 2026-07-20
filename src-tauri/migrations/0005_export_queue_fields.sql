-- Adds progress tracking and error messaging to the export queue (PRD
-- §10-11, Milestone 7). `progress` is a fraction in [0,1] of the lesson's
-- known duration (end - start), updated as ffmpeg's own `-progress
-- pipe:1` output streams in (see `src-tauri/src/export.rs`). `error` is
-- only ever populated when `status = 'failed'`. `status` gains new values
-- beyond the schema default `'pending'`: 'queued', 'paused', 'running',
-- 'done', 'failed', 'cancelled' — no CHECK constraint is added, consistent
-- with `kind`/`source` on `lessons`, which are also plain unconstrained
-- TEXT columns.

ALTER TABLE exports ADD COLUMN progress REAL NOT NULL DEFAULT 0;
ALTER TABLE exports ADD COLUMN error TEXT;
