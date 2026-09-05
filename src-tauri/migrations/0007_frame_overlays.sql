-- Still-image overlays composited over a video's existing frames during
-- export (docs discussion: frame overlay v1). This does NOT splice or
-- shift the timeline -- video duration, transcript_segments, and audio are
-- untouched; the image is composited on top of the existing frames for
-- [start, end) during export only.
--
-- `start`/`end` are video-scoped absolute seconds (REAL), matching the
-- `transcript_segments.start`/`.end` and `lesson_segments.start`/`.end`
-- convention -- not lesson-scoped, since the same video can back multiple
-- lessons/segments and the overlay should apply wherever that time range
-- is exported.
--
-- Per-overlay sizing (`scale_percent`) was added later, once this table had
-- already been applied to dev databases -- see `0008_frame_overlay_scale_percent.sql`
-- rather than a column here.

CREATE TABLE frame_overlays (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    image_path TEXT NOT NULL,
    start REAL NOT NULL,
    end REAL NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_frame_overlays_video_id ON frame_overlays(video_id);
