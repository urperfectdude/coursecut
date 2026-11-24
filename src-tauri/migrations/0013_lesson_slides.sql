-- Intro and outro slides (docs/hcm-improvements-plan.md, "1. Intro and
-- outro: overlay or insert"). At most one intro and one outro per lesson.
--
-- `mode` = 'insert': the slide is its own piece of video before (intro) or
-- after (outro) the lecture, with silent audio. It adds time to the export
-- and takes no time on the virtual timeline, so overlays and shape layers
-- stay where they are.
-- `mode` = 'overlay': the slide covers the first (intro) or last (outro)
-- `duration` seconds of the lesson's virtual timeline, full-frame, on top
-- of shapes and image overlays. `mute_audio` silences the lecture audio in
-- that window. Only meaningful for overlay mode.
--
-- `kind` = 'image': `image_path` is a user-picked PNG/JPG.
-- `kind` = 'title': `image_path` is a PNG the frontend rendered from
-- `title`/`subtitle`/`bg_color`/`text_color` at the video's resolution and
-- saved under the app cache dir (`<app_cache_dir>/slides/`).
CREATE TABLE lesson_slides (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    position TEXT NOT NULL CHECK (position IN ('intro', 'outro')),
    mode TEXT NOT NULL DEFAULT 'insert' CHECK (mode IN ('insert', 'overlay')),
    duration REAL NOT NULL CHECK (duration > 0),
    kind TEXT NOT NULL CHECK (kind IN ('image', 'title')),
    image_path TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    subtitle TEXT NOT NULL DEFAULT '',
    bg_color TEXT NOT NULL DEFAULT '#111827',
    text_color TEXT NOT NULL DEFAULT '#ffffff',
    mute_audio INTEGER NOT NULL DEFAULT 0 CHECK (mute_audio IN (0, 1)),
    created_at TEXT NOT NULL,
    UNIQUE (lesson_id, position)
);
