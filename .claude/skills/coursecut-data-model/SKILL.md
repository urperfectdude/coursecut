---
name: coursecut-data-model
description: The actual coursecut SQLite schema (projects, videos, transcript_segments, lessons, exports) and field names. Read before writing any query, migration, or Rust/TS type that touches the database, instead of guessing column names from the PRD's simplified model.
metadata:
  type: data-model
---

Schema lives in `src-tauri/migrations/0001_init.sql` — that file is the source of truth; this is a navigable summary. PRD §13 lists the model conceptually but omits housekeeping columns that exist in the real schema (timestamps, `status`, `sort_order`, defaults) — use this skill or the migration file, not §13 directly, when writing code.

## Tables

* **projects**(`id`, `name`, `created_at`, `updated_at`)
* **videos**(`id`, `project_id` → projects, `file_path`, `duration`, `transcript_status` default `'pending'`, `created_at`, `updated_at`)
* **transcript_segments**(`id`, `video_id` → videos, `start`, `end`, `text`, `keep` default `1`) — one row per sentence/word-group; `keep` is the transcript-mode delete flag (PRD §8.1), not a row delete.
* **lessons**(`id`, `video_id` → videos, `title`, `summary`, `start`, `end`, `sort_order` default `0`)
* **exports**(`id`, `lesson_id` → lessons, `output_path`, `status` default `'pending'`, `created_at`)

## Conventions

* All `id` columns are app-generated TEXT UUIDs, not autoincrement integers.
* All foreign keys cascade on delete (`ON DELETE CASCADE`) — deleting a project deletes its videos, transcript segments, lessons, and exports. This is intentional; don't add app-level cascade logic that duplicates it.
* Timestamps are ISO-8601 strings, not Unix epoch integers.
* A new migration is a new `NNNN_description.sql` file plus a new entry in the `migrations()` vec in `src-tauri/src/lib.rs` — never edit `0001_init.sql` in place once it's shipped to a user.
* Multi-lesson reordering uses `lessons.sort_order`, not implicit row order.
