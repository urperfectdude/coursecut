-- Per-overlay sizing for `frame_overlays` (0007_frame_overlays.sql), added
-- after that table shipped to dev databases -- hence a separate ALTER here
-- instead of a column on the original CREATE TABLE.
--
-- `scale_percent` is the image's size as a percentage of the main video's
-- own dimensions at export time (100 = fills the frame, matching the
-- original v1 behavior for every row that predates this column; below 100
-- shrinks the image toward the center, leaving the underlying video visible
-- around it -- see `build_overlay_filter_complex` in ffmpeg.rs).

ALTER TABLE frame_overlays ADD COLUMN scale_percent REAL NOT NULL DEFAULT 100;
