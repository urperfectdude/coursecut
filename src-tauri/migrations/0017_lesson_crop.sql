-- Crop for a lesson's export: one setting per lesson, not time-ranged.
--
-- The rect is top-left + size, each 0-100 percent of the SOURCE frame
-- (before cropping; shape layers from 0012 use the same frame and are
-- applied first). When `enabled`, the export cuts that rect out, scales it
-- to fit inside the frame minus `padding_percent` (percent of the frame's
-- shorter side, on every edge) keeping its own aspect, centres it on a
-- `bg_color` ('#rrggbb') background of the source's own size, and, when
-- `shadow_enabled`, draws a drop shadow under it (`shadow_blur` and
-- `shadow_offset_y` in source pixels, `shadow_opacity` 0-1). See
-- `ffmpeg.rs::resolve_crop`. Image overlays and overlay-mode slides then go
-- on top of the composed frame. No row, or `enabled` = 0, exports exactly
-- as before.
CREATE TABLE lesson_crop (
    lesson_id TEXT PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    x_percent REAL NOT NULL,
    y_percent REAL NOT NULL,
    w_percent REAL NOT NULL,
    h_percent REAL NOT NULL,
    bg_color TEXT NOT NULL DEFAULT '#0B1F3A',
    padding_percent REAL NOT NULL DEFAULT 6,
    shadow_enabled INTEGER NOT NULL DEFAULT 1 CHECK (shadow_enabled IN (0, 1)),
    shadow_blur INTEGER NOT NULL DEFAULT 24,
    shadow_opacity REAL NOT NULL DEFAULT 0.5,
    shadow_offset_y INTEGER NOT NULL DEFAULT 8,
    updated_at TEXT NOT NULL
);
