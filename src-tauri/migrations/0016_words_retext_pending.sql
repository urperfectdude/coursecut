-- An imported transcript (VTT) replaces `transcript_segments` at once,
-- but the lesson editor's words (`transcript_words`) only take its text
-- when the user next clicks Analyze, so the Script and AI voice tabs don't
-- change under them before then. Set by `import_vtt_transcript`, cleared
-- by `analyze_video` (which rewrites the words) and by a Whisper
-- transcription (which replaces them).
ALTER TABLE videos ADD COLUMN words_retext_pending INTEGER NOT NULL DEFAULT 0;
