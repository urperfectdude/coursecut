-- Multi-segment lessons (docs/lesson-segments-plan.md). A lesson can now be
-- built from multiple, possibly non-contiguous and overlapping segments of
-- its source video, instead of a single [start, end) range. No overlap
-- constraint is added anywhere (segment-vs-segment within a lesson, or
-- lesson-vs-lesson) -- that's intentional, see the plan doc.
--
-- `start`/`end` are REAL (decimal seconds), matching the existing
-- `lessons.start`/`.end` and `transcript_segments.start`/`.end` convention
-- (see 0001_init.sql) -- the "timestamps are ISO-8601 strings" convention
-- from the data-model skill applies only to `created_at`/`updated_at`, not
-- to these numeric second-offset columns.
--
-- `lessons.start`/`lessons.end` are untouched here (still REAL) but change
-- meaning going forward: they become a cached derived bound (min segment
-- start, max segment end across the lesson's segments), recomputed by Rust
-- after every segment write (see `recompute_lesson_bounds_tx` in db.rs) --
-- not maintained by a SQL trigger.

CREATE TABLE lesson_segments (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    start REAL NOT NULL,
    end REAL NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_lesson_segments_lesson_id ON lesson_segments(lesson_id);

-- Backfill: one segment per existing lesson, copying its current start/end.
-- The generated id is dashed 8-4-4-4-12 hex (visually consistent with the
-- app's usual `uuid::Uuid::new_v4()` ids elsewhere) though not a strict
-- UUIDv4 -- version/variant nibbles aren't fixed up, which raw SQL can't
-- easily do. That's fine: ids are opaque TEXT everywhere they're used,
-- never parsed/validated as UUIDs.
INSERT INTO lesson_segments (id, lesson_id, start, end, sort_order)
SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(6))),
    id, start, end, 0
FROM lessons;
