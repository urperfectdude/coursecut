-- Explicit X/Y placement for frame_overlays, alongside the existing
-- scale_percent sizing control. `x_percent`/`y_percent` are 0-100: 0 means
-- the image's left/top edge touches the frame's left/top edge, 100 means
-- its right/bottom edge touches the frame's right/bottom edge, 50 means
-- centered on that axis -- the only placement earlier versions supported,
-- hence the default here so every existing row keeps its current centered
-- appearance. See `build_overlay_filter_complex` in ffmpeg.rs for the
-- `overlay` filter expression this drives.
ALTER TABLE frame_overlays ADD COLUMN x_percent REAL NOT NULL DEFAULT 50;
ALTER TABLE frame_overlays ADD COLUMN y_percent REAL NOT NULL DEFAULT 50;
