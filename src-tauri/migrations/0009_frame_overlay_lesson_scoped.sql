-- Pivots `frame_overlays` from video-scoped/raw-recording-time to
-- lesson-scoped/final-video-time. Testing revealed the original design
-- (start/end as absolute seconds into the source recording, shared across
-- every lesson built from that video) didn't match how anyone actually
-- thinks about "insert this image at this point in MY video": a position
-- picked while looking at a lesson's own Final-video preview could silently
-- land outside that lesson's kept segments (no marker, no live preview, and
-- it would never appear in that lesson's export), and "0" in the Final
-- video's own clock never meant the stored `start` was 0 too.
--
-- `start`/`end` now mean seconds into the *virtual, stitched* timeline
-- `LessonPreviewPlayer`'s scrubber already shows (0 = the start of this
-- lesson's own final output) -- see `segmentOffsets` there, and
-- `export.rs`'s `overlays_for_segment`, which maps a virtual range onto
-- whichever of the lesson's `lesson_segments` it falls in.
--
-- Existing rows predate this and use the old (incompatible) coordinate
-- system -- there's no lossy-free way to reinterpret an absolute source
-- second as a virtual lesson second, so this clears them rather than
-- attempting a backfill (this is early/dev-stage data, not a production
-- migration concern).
DELETE FROM frame_overlays;

ALTER TABLE frame_overlays ADD COLUMN lesson_id TEXT REFERENCES lessons(id) ON DELETE CASCADE;

CREATE INDEX idx_frame_overlays_lesson_id ON frame_overlays(lesson_id);
