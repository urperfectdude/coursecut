-- Adds GPT-5.5 lesson-analysis fields to `lessons` (PRD §7.5). `confidence`
-- is the model's confidence in a suggestion (0-1, nullable for any
-- pre-existing/manually-created rows). `kind` categorizes a suggestion per
-- PRD §7.5 (lesson/qna/discussion/break/silence/duplicate), defaulting to
-- 'lesson'. `source` distinguishes AI-suggested rows ('ai') from future
-- user-created/edited ones, so re-running analysis can safely replace only
-- the AI-sourced rows for a video without touching manual edits.

ALTER TABLE lessons ADD COLUMN confidence REAL;
ALTER TABLE lessons ADD COLUMN kind TEXT NOT NULL DEFAULT 'lesson';
ALTER TABLE lessons ADD COLUMN source TEXT NOT NULL DEFAULT 'ai';
