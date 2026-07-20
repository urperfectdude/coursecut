-- Adds local audio-extraction cache fields to `videos` (PRD §7.3/§7.4).
-- `content_hash` is a SHA-256 of the source video's bytes, used to key
-- extracted audio so unchanged videos are never re-extracted (and, later,
-- never re-transcribed). `audio_path` points at the cached extracted audio
-- file on disk. Both are nullable: unset until `extract_audio_for_video`
-- runs for a given video.

ALTER TABLE videos ADD COLUMN content_hash TEXT;
ALTER TABLE videos ADD COLUMN audio_path TEXT;
