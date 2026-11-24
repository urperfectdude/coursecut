-- Word-level transcript for text-based editing
-- (docs/text-editing-plan.md §7.1). Filled by Whisper word timestamps
-- (`timestamp_granularities[]=word`) alongside `transcript_segments`.
--
-- Times are source-video seconds, like `transcript_segments`. A word
-- belongs to the segment whose [start, end) contains its `start`.
-- `removed` is the edit flag: cuts are derived from it, never stored.
-- A segment's `keep` is kept in agreement with its words (see words.rs).
--
-- `idx` is the order within the video, renumbered 0..n by time after a
-- chunk re-transcription. Not UNIQUE, so renumbering can't collide
-- mid-update.
--
-- No data migration: videos transcribed before this have no words. They
-- get them from "Listen again" (`fetch_word_timestamps`), never
-- automatically, so no Whisper call happens without the user asking.
CREATE TABLE transcript_words (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    text TEXT NOT NULL,              -- display text (corrected, if fixed)
    original_text TEXT,              -- Whisper's text, set when corrected
    start REAL NOT NULL,
    end REAL NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0,
    suggested TEXT                   -- NULL | 'filler' | 'hallucination'
);

CREATE INDEX idx_transcript_words_video_idx ON transcript_words(video_id, idx);
CREATE INDEX idx_transcript_words_video_start ON transcript_words(video_id, start);

-- The user's decision on a pause: the gap after word `after_word_id`.
-- Pauses themselves are derived from word gaps and not stored. Keyed by
-- word id rather than idx, since idx is renumbered. Re-transcribing
-- replaces the words, so their pause decisions go with them (cascade).
CREATE TABLE transcript_pauses (
    after_word_id TEXT PRIMARY KEY REFERENCES transcript_words(id) ON DELETE CASCADE,
    action TEXT NOT NULL             -- 'shorten' | 'remove' | 'keep'
);
