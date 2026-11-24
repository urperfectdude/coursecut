-- Shape layers applied to a lesson's export between two timestamps
-- (docs/hcm-improvements-plan.md, "2. Shape layers (blur / solid cover)").
--
-- `start`/`end` are virtual-timeline seconds, exactly like
-- `frame_overlays` (0009): 0 = the start of this lesson's own output,
-- mapped onto each exported segment by `export.rs::regions_for_segment`.
--
-- The rect is top-left + size, each 0-100 percent of the output frame.
-- Each row is a static 'rect' | 'rounded' | 'ellipse' that is either
-- blurred (`fill` = 'blur', `blur_strength` = boxblur radius in source
-- pixels, capped at export time) or filled with `color` (`fill` =
-- 'solid', '#rrggbb').
CREATE TABLE lesson_regions (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    start REAL NOT NULL,
    end REAL NOT NULL,
    x_percent REAL NOT NULL,
    y_percent REAL NOT NULL,
    w_percent REAL NOT NULL,
    h_percent REAL NOT NULL,
    shape TEXT NOT NULL DEFAULT 'rect',
    fill TEXT NOT NULL DEFAULT 'blur',
    blur_strength INTEGER NOT NULL DEFAULT 20,
    color TEXT NOT NULL DEFAULT '#000000',
    created_at TEXT NOT NULL
);

CREATE INDEX idx_lesson_regions_lesson_id ON lesson_regions(lesson_id);
