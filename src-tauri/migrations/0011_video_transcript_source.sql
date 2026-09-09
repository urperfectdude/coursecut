-- Tracks whether a video's current transcript came from Whisper
-- (openai.rs's transcribe_video/retranscribe_chunk) or was imported
-- wholesale from an accurate external file (db.rs's import_vtt_transcript,
-- e.g. a Zoom/Teams VTT export) -- surfaced in the UI (TranscriptStageView)
-- to hide the Whisper-chunk re-transcribe sidebar for an imported
-- transcript, since there's no Whisper chunking behind it to retry.
ALTER TABLE videos ADD COLUMN transcript_source TEXT NOT NULL DEFAULT 'whisper';
