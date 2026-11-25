//! Word-level transcript storage for text-based editing
//! (`docs/text-editing-plan.md` §7, Phase 1).
//!
//! Words are stored per video in `transcript_words` (`0014`), on the same
//! source timeline as `transcript_segments`. A word belongs to the segment
//! whose `[start, end)` contains the word's `start`. Words in a gap between
//! segments belong to none.
//!
//! The invariant kept here: a segment's `keep` flag and the `removed` flag
//! of its words agree. Today the only writers are transcription (which
//! marks words in hallucination-flagged segments removed) and the
//! Transcript page's segment keep/drop toggle (`db::update_transcript_segment`,
//! which calls `set_removed_in_range`). Phase 2's word edits will write in
//! the other direction.
//!
//! No network here. Whisper is called from `openai.rs`.

use crate::db::DbConnection;
use rusqlite::{params, Connection};
use serde::Serialize;

/// One word as transcription produces it, before it's stored.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptWord {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// A stored `transcript_words` row, as sent to the frontend.
#[derive(Debug, Serialize)]
pub struct TranscriptWordRow {
    pub id: String,
    pub video_id: String,
    pub idx: i64,
    pub text: String,
    pub original_text: Option<String>,
    pub start: f64,
    pub end: f64,
    pub removed: bool,
    pub suggested: Option<String>,
}

fn row_to_word(row: &rusqlite::Row<'_>) -> rusqlite::Result<TranscriptWordRow> {
    Ok(TranscriptWordRow {
        id: row.get("id")?,
        video_id: row.get("video_id")?,
        idx: row.get("idx")?,
        text: row.get("text")?,
        original_text: row.get("original_text")?,
        start: row.get("start")?,
        end: row.get("end")?,
        removed: row.get("removed")?,
        suggested: row.get("suggested")?,
    })
}

pub(crate) fn query_words(conn: &Connection, video_id: &str) -> Result<Vec<TranscriptWordRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, video_id, idx, text, original_text, start, end, removed, suggested
             FROM transcript_words WHERE video_id = ?1 ORDER BY idx",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![video_id], row_to_word)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

/// A sibling video's words for the transcript cache: timing and the
/// transcribed text only. Corrections and removals are edit state and are
/// never copied, so `original_text` (the Whisper text, when corrected) wins
/// over `text`.
pub(crate) fn query_source_words(conn: &Connection, video_id: &str) -> Result<Vec<TranscriptWord>, String> {
    Ok(query_words(conn, video_id)?
        .into_iter()
        .map(|row| TranscriptWord {
            start: row.start,
            end: row.end,
            text: row.original_text.unwrap_or(row.text),
        })
        .collect())
}

/// Replaces `video_id`'s words, either all of them (`range = None`) or only
/// those whose `start` falls in `[range.0, range.1)` (a re-transcribed
/// chunk), then renumbers `idx` by time and marks words inside `keep = 0`
/// segments of the replaced range as removed. Call inside the same
/// transaction that writes the segments, after the segments are written.
///
/// `flag_reason` is stored in `suggested` for words removed this way, so
/// the UI can say why (`"hallucination"` after transcription). `None`
/// leaves `suggested` empty, for segments the user dropped themselves.
pub(crate) fn replace_words(
    conn: &Connection,
    video_id: &str,
    range: Option<(f64, f64)>,
    words: &[TranscriptWord],
    flag_reason: Option<&str>,
) -> Result<(), String> {
    let (from, to) = range.unwrap_or((f64::MIN, f64::MAX));

    conn.execute(
        "DELETE FROM transcript_words WHERE video_id = ?1 AND start >= ?2 AND start < ?3",
        params![video_id, from, to],
    )
    .map_err(|err| err.to_string())?;

    {
        let mut insert = conn
            .prepare(
                "INSERT INTO transcript_words (id, video_id, idx, text, start, end, removed)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
            )
            .map_err(|err| err.to_string())?;
        for (position, word) in words.iter().enumerate() {
            if word.start < from || word.start >= to {
                continue;
            }
            let id = uuid::Uuid::new_v4().to_string();
            insert
                .execute(params![id, video_id, position as i64, word.text, word.start, word.end])
                .map_err(|err| err.to_string())?;
        }
    }

    renumber(conn, video_id)?;

    conn.execute(
        "UPDATE transcript_words SET removed = 1, suggested = ?4
         WHERE video_id = ?1 AND start >= ?2 AND start < ?3
         AND EXISTS (
             SELECT 1 FROM transcript_segments s
             WHERE s.video_id = ?1 AND s.keep = 0
             AND transcript_words.start >= s.start AND transcript_words.start < s.end
         )",
        params![video_id, from, to, flag_reason],
    )
    .map_err(|err| err.to_string())?;

    Ok(())
}

/// Reassigns `idx` as 0..n in time order (ties keep their previous order).
/// Needed after a chunk's words are replaced in the middle of the list.
fn renumber(conn: &Connection, video_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE transcript_words SET idx = (
             SELECT ranked.rn FROM (
                 SELECT id, ROW_NUMBER() OVER (ORDER BY start, idx, id) - 1 AS rn
                 FROM transcript_words WHERE video_id = ?1
             ) AS ranked
             WHERE ranked.id = transcript_words.id
         )
         WHERE video_id = ?1",
        params![video_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// Marks every word of `video_id` whose `start` is in `[start, end)` as
/// removed or restored, clearing `suggested` (the user has now decided).
/// Used by the segment keep/drop toggle so segments and words agree.
///
/// Whisper segments can overlap slightly, so a word can sit inside two
/// segments. Restoring one segment leaves a word alone if another
/// segment containing it is still dropped: a word is kept only when every
/// segment containing it is kept, matching `replace_words`.
pub(crate) fn set_removed_in_range(
    conn: &Connection,
    video_id: &str,
    start: f64,
    end: f64,
    removed: bool,
) -> Result<(), String> {
    conn.execute(
        "UPDATE transcript_words SET removed = ?4, suggested = NULL
         WHERE video_id = ?1 AND start >= ?2 AND start < ?3
         AND (?4 = 1 OR NOT EXISTS (
             SELECT 1 FROM transcript_segments s
             WHERE s.video_id = ?1 AND s.keep = 0
             AND transcript_words.start >= s.start AND transcript_words.start < s.end
         ))",
        params![video_id, start, end, removed],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// Read-only listing of a video's words, in order. Empty for a video
/// transcribed before words were stored, or one with an imported VTT and
/// no Whisper pass yet; the frontend offers `openai::fetch_word_timestamps`
/// for those.
#[tauri::command]
pub fn list_transcript_words(
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
) -> Result<Vec<TranscriptWordRow>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    query_words(&conn, &video_id)
}

/// One word's new `removed` flag, from the Transcript page's word editor.
#[derive(Debug, serde::Deserialize)]
pub struct WordRemovedChange {
    pub id: String,
    pub removed: bool,
}

/// The user's decision on the pause after a word (`transcript_pauses`).
/// `action` is `"shorten"`, `"remove"` or `"keep"`; `None` in a change
/// clears the decision (back to untouched).
#[derive(Debug, Serialize, serde::Deserialize)]
pub struct PauseDecision {
    pub after_word_id: String,
    pub action: Option<String>,
}

const PAUSE_ACTIONS: [&str; 3] = ["shorten", "remove", "keep"];

#[tauri::command]
pub fn list_transcript_pauses(
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
) -> Result<Vec<PauseDecision>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    query_pauses(&conn, &video_id)
}

pub(crate) fn query_pauses(conn: &Connection, video_id: &str) -> Result<Vec<PauseDecision>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.after_word_id, p.action FROM transcript_pauses p
             JOIN transcript_words w ON w.id = p.after_word_id
             WHERE w.video_id = ?1 ORDER BY w.idx",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![video_id], |row| {
            Ok(PauseDecision {
                after_word_id: row.get(0)?,
                action: row.get(1)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

/// Re-derives `keep` for the segments containing word `word_id`: kept if
/// at least one of the segment's words is not removed. Only segments
/// touched by an edit are re-derived, so a keep/drop choice made on the
/// Transcript page for other segments isn't overwritten by unrelated word
/// or pause edits.
pub(crate) fn sync_segment_keep_for_word(conn: &Connection, video_id: &str, word_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE transcript_segments SET keep = EXISTS (
             SELECT 1 FROM transcript_words w
             WHERE w.video_id = ?1 AND w.removed = 0
             AND w.start >= transcript_segments.start AND w.start < transcript_segments.end
         )
         WHERE video_id = ?1 AND EXISTS (
             SELECT 1 FROM transcript_words changed
             WHERE changed.id = ?2 AND changed.video_id = ?1
             AND changed.start >= transcript_segments.start AND changed.start < transcript_segments.end
         )",
        params![video_id, word_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// Saves a batch of word removals/restores and pause decisions (debounced
/// from the frontend, so one drag-select or one Clean up is one call),
/// clears `suggested` on each changed word (the user has decided), and
/// re-derives segment `keep` flags in the same transaction. Returns the
/// video's segments so the caller sees the new flags. Pure DB, no network.
#[tauri::command]
pub fn update_transcript_words(
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
    changes: Vec<WordRemovedChange>,
    pauses: Option<Vec<PauseDecision>>,
) -> Result<Vec<crate::db::TranscriptSegmentRow>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    apply_word_changes(&conn, &video_id, &changes, pauses.as_deref().unwrap_or(&[]))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, video_id, start, end, text, keep FROM transcript_segments
             WHERE video_id = ?1 ORDER BY start, id",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![video_id], crate::db::row_to_transcript_segment)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

fn apply_word_changes(
    conn: &Connection,
    video_id: &str,
    changes: &[WordRemovedChange],
    pauses: &[PauseDecision],
) -> Result<(), String> {
    for pause in pauses {
        if let Some(action) = &pause.action {
            if !PAUSE_ACTIONS.contains(&action.as_str()) {
                return Err(format!("unknown pause action {action:?}"));
            }
        }
    }
    let tx = conn.unchecked_transaction().map_err(|err| err.to_string())?;
    for pause in pauses {
        match &pause.action {
            // Only for a word of this video: the subquery yields no row
            // otherwise, so nothing is inserted.
            Some(action) => tx.execute(
                "INSERT INTO transcript_pauses (after_word_id, action)
                 SELECT id, ?2 FROM transcript_words WHERE id = ?1 AND video_id = ?3
                 ON CONFLICT(after_word_id) DO UPDATE SET action = excluded.action",
                params![pause.after_word_id, action, video_id],
            ),
            None => tx.execute(
                "DELETE FROM transcript_pauses WHERE after_word_id = ?1
                 AND after_word_id IN (SELECT id FROM transcript_words WHERE video_id = ?2)",
                params![pause.after_word_id, video_id],
            ),
        }
        .map_err(|err| err.to_string())?;
    }
    {
        let mut update = tx
            .prepare(
                "UPDATE transcript_words SET removed = ?1, suggested = NULL
                 WHERE id = ?2 AND video_id = ?3",
            )
            .map_err(|err| err.to_string())?;
        for change in changes {
            update
                .execute(params![change.removed, change.id, video_id])
                .map_err(|err| err.to_string())?;
        }
    }
    for change in changes {
        sync_segment_keep_for_word(&tx, video_id, &change.id)?;
    }
    tx.commit().map_err(|err| err.to_string())
}

/// One word's corrected text, from the lesson editor's Edit option
/// (`docs/text-editing-plan.md` §6.4). The word keeps its timing; only its
/// text changes. Empty text is allowed: when an edit has fewer words than
/// it replaces, the leftover words carry no text (they still time audio).
#[derive(Debug, serde::Deserialize)]
pub struct WordTextChange {
    pub id: String,
    /// `None` puts Whisper's text back (an undo of a first edit). A text
    /// equal to Whisper's still counts as an edit: the shown word may carry
    /// the sentence's punctuation and casing, which the user removed.
    pub text: Option<String>,
}

/// Longest text one word may hold (an edit can put several words on one).
const MAX_WORD_TEXT_LEN: usize = 500;

/// Saves corrected word texts in one transaction and returns the changed
/// rows. `original_text` keeps Whisper's text the first time a word is
/// changed, and is cleared only by an explicit revert, so
/// `original_text IS NOT NULL` always means "corrected". Pure DB, no
/// network.
#[tauri::command]
pub fn set_transcript_word_texts(
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
    changes: Vec<WordTextChange>,
) -> Result<Vec<TranscriptWordRow>, String> {
    let conn = conn.0.lock().map_err(|err| err.to_string())?;
    apply_word_texts(&conn, &video_id, &changes)
}

pub(crate) fn apply_word_texts(
    conn: &Connection,
    video_id: &str,
    changes: &[WordTextChange],
) -> Result<Vec<TranscriptWordRow>, String> {
    for change in changes {
        if change.text.as_deref().unwrap_or("").chars().count() > MAX_WORD_TEXT_LEN {
            return Err(format!("A word's text can be at most {MAX_WORD_TEXT_LEN} characters."));
        }
    }
    let tx = conn.unchecked_transaction().map_err(|err| err.to_string())?;
    {
        // Right-hand sides read the row's values from before this UPDATE.
        let mut update = tx
            .prepare(
                "UPDATE transcript_words SET original_text = COALESCE(original_text, text), text = ?1
                 WHERE id = ?2 AND video_id = ?3",
            )
            .map_err(|err| err.to_string())?;
        let mut revert = tx
            .prepare(
                "UPDATE transcript_words SET text = COALESCE(original_text, text), original_text = NULL
                 WHERE id = ?1 AND video_id = ?2",
            )
            .map_err(|err| err.to_string())?;
        for change in changes {
            match &change.text {
                Some(text) => {
                    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
                    update.execute(params![text, change.id, video_id])
                }
                None => revert.execute(params![change.id, video_id]),
            }
            .map_err(|err| err.to_string())?;
        }
    }
    tx.commit().map_err(|err| err.to_string())?;
    let ids: std::collections::HashSet<&str> = changes.iter().map(|c| c.id.as_str()).collect();
    Ok(query_words(conn, video_id)?
        .into_iter()
        .filter(|row| ids.contains(row.id.as_str()))
        .collect())
}

/// Rewrites `video_id`'s word texts from its transcript sentences, after an
/// imported transcript replaced them. Words keep their timing; each
/// sentence's text is spread over the words it contains, in order (like
/// the editor's `spreadEditedText`). Clears every past text edit
/// (`original_text`), since it was a fix to the old transcript's wording.
/// Words outside every sentence go back to Whisper's text.
pub(crate) fn retext_words_from_segments(conn: &Connection, video_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE transcript_words SET text = COALESCE(original_text, text), original_text = NULL
         WHERE video_id = ?1",
        params![video_id],
    )
    .map_err(|err| err.to_string())?;

    let segments: Vec<(f64, f64, String)> = {
        let mut stmt = conn
            .prepare("SELECT start, end, text FROM transcript_segments WHERE video_id = ?1 ORDER BY start")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![video_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|err| err.to_string())?
    };
    let mut select = conn
        .prepare("SELECT id FROM transcript_words WHERE video_id = ?1 AND start >= ?2 AND start < ?3 ORDER BY idx")
        .map_err(|err| err.to_string())?;
    let mut update = conn
        .prepare("UPDATE transcript_words SET text = ?1 WHERE id = ?2")
        .map_err(|err| err.to_string())?;
    for (start, end, text) in &segments {
        let ids: Vec<String> = select
            .query_map(params![video_id, start, end], |row| row.get(0))
            .map_err(|err| err.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|err| err.to_string())?;
        for (id, part) in ids.iter().zip(spread_text(ids.len(), text)) {
            update.execute(params![part, id]).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

/// Applies a transcript imported since the last Analyze to the words
/// (`retext_words_from_segments`), once, and clears the mark.
pub(crate) fn apply_pending_retext(conn: &Connection, video_id: &str) -> Result<(), String> {
    let pending: bool = conn
        .query_row(
            "SELECT words_retext_pending FROM videos WHERE id = ?1",
            params![video_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if pending {
        retext_words_from_segments(conn, video_id)?;
        conn.execute(
            "UPDATE videos SET words_retext_pending = 0 WHERE id = ?1",
            params![video_id],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// `text`'s tokens spread over `count` words in order (the Rust twin of
/// `spreadEditedText` in `src/lib/transcript-words.ts`).
fn spread_text(count: usize, text: &str) -> Vec<String> {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    (0..count)
        .map(|i| {
            let from = (i * tokens.len()).div_ceil(count);
            let to = ((i + 1) * tokens.len()).div_ceil(count);
            tokens[from..to].join(" ")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn retext_spreads_sentence_text_and_clears_edits() {
        let conn = setup();
        replace_words(&conn, "v", None, &[w(1.0, "helo"), w(1.5, "wrld"), w(2.5, "x"), w(9.0, "out")], None).unwrap();
        conn.execute(
            "UPDATE transcript_words SET original_text = text, text = 'edited' WHERE text IN ('x', 'out')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO transcript_segments (id, video_id, start, end, text, keep) VALUES
             ('a', 'v', 0.0, 2.0, 'Hello, world.', 1), ('b', 'v', 2.0, 4.0, 'Three new words.', 1)",
            [],
        )
        .unwrap();
        retext_words_from_segments(&conn, "v").unwrap();
        assert_eq!(texts(&conn), vec!["Hello,", "world.", "Three new words.", "out"]);
        let edited: i64 = conn
            .query_row("SELECT COUNT(*) FROM transcript_words WHERE original_text IS NOT NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(edited, 0);
        assert_eq!(spread_text(3, "a b"), vec!["a", "b", ""]);
    }

    #[test]
    fn pending_retext_applies_once_then_clears() {
        let conn = setup();
        replace_words(&conn, "v", None, &[w(1.0, "old")], None).unwrap();
        conn.execute(
            "INSERT INTO transcript_segments (id, video_id, start, end, text, keep) VALUES ('a', 'v', 0.0, 2.0, 'New.', 1)",
            [],
        )
        .unwrap();
        apply_pending_retext(&conn, "v").unwrap();
        assert_eq!(texts(&conn), vec!["old"]);
        conn.execute("UPDATE videos SET words_retext_pending = 1", []).unwrap();
        apply_pending_retext(&conn, "v").unwrap();
        assert_eq!(texts(&conn), vec!["New."]);
        let pending: bool = conn
            .query_row("SELECT words_retext_pending FROM videos", [], |r| r.get(0))
            .unwrap();
        assert!(!pending);
    }

    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p', 'P', 'now', 'now')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO videos (id, project_id, file_path, created_at, updated_at)
             VALUES ('v', 'p', '/x.mp4', 'now', 'now')",
            [],
        )
        .unwrap();
        conn
    }

    fn segment(conn: &Connection, id: &str, start: f64, end: f64, keep: bool) {
        conn.execute(
            "INSERT INTO transcript_segments (id, video_id, start, end, text, keep)
             VALUES (?1, 'v', ?2, ?3, 't', ?4)",
            params![id, start, end, keep],
        )
        .unwrap();
    }

    fn w(start: f64, text: &str) -> TranscriptWord {
        TranscriptWord {
            start,
            end: start + 0.4,
            text: text.to_string(),
        }
    }

    fn texts(conn: &Connection) -> Vec<String> {
        query_words(conn, "v").unwrap().into_iter().map(|row| row.text).collect()
    }

    #[test]
    fn stores_words_in_time_order_with_contiguous_idx() {
        let conn = setup();
        replace_words(&conn, "v", None, &[w(2.0, "b"), w(1.0, "a"), w(3.0, "c")], None).unwrap();
        let rows = query_words(&conn, "v").unwrap();
        assert_eq!(texts(&conn), ["a", "b", "c"]);
        assert_eq!(rows.iter().map(|row| row.idx).collect::<Vec<_>>(), [0, 1, 2]);
        assert!(rows.iter().all(|row| !row.removed && row.suggested.is_none()));
    }

    #[test]
    fn words_in_dropped_segments_are_removed_with_reason() {
        let conn = setup();
        segment(&conn, "s1", 0.0, 5.0, true);
        segment(&conn, "s2", 5.0, 10.0, false);
        replace_words(&conn, "v", None, &[w(1.0, "keep"), w(6.0, "thanks"), w(11.0, "gap")], Some("hallucination"))
            .unwrap();
        let rows = query_words(&conn, "v").unwrap();
        assert!(!rows[0].removed);
        assert!(rows[1].removed);
        assert_eq!(rows[1].suggested.as_deref(), Some("hallucination"));
        assert!(!rows[2].removed, "a word between segments belongs to none");
    }

    #[test]
    fn chunk_replacement_keeps_words_outside_the_range() {
        let conn = setup();
        replace_words(&conn, "v", None, &[w(1.0, "a"), w(601.0, "old"), w(1201.0, "z")], None).unwrap();
        replace_words(&conn, "v", Some((600.0, 1200.0)), &[w(601.0, "new1"), w(602.0, "new2")], None).unwrap();
        assert_eq!(texts(&conn), ["a", "new1", "new2", "z"]);
        let idx: Vec<i64> = query_words(&conn, "v").unwrap().into_iter().map(|row| row.idx).collect();
        assert_eq!(idx, [0, 1, 2, 3]);
    }

    #[test]
    fn chunk_replacement_ignores_words_outside_its_range() {
        let conn = setup();
        replace_words(&conn, "v", Some((0.0, 10.0)), &[w(1.0, "in"), w(12.0, "out")], None).unwrap();
        assert_eq!(texts(&conn), ["in"]);
    }

    #[test]
    fn segment_toggle_moves_its_words_and_clears_reason() {
        let conn = setup();
        segment(&conn, "s1", 0.0, 5.0, false);
        replace_words(&conn, "v", None, &[w(1.0, "a"), w(6.0, "b")], Some("hallucination")).unwrap();
        // As in `db::update_transcript_segment`: the segment flips first.
        conn.execute("UPDATE transcript_segments SET keep = 1 WHERE id = 's1'", []).unwrap();
        set_removed_in_range(&conn, "v", 0.0, 5.0, false).unwrap();
        let rows = query_words(&conn, "v").unwrap();
        assert!(!rows[0].removed && rows[0].suggested.is_none());
        conn.execute("UPDATE transcript_segments SET keep = 0 WHERE id = 's1'", []).unwrap();
        set_removed_in_range(&conn, "v", 0.0, 5.0, true).unwrap();
        let rows = query_words(&conn, "v").unwrap();
        assert!(rows[0].removed && rows[0].suggested.is_none());
        assert!(!rows[1].removed);
    }

    #[test]
    fn restoring_one_overlapping_segment_keeps_a_word_the_other_dropped() {
        let conn = setup();
        segment(&conn, "s1", 0.0, 5.2, false);
        segment(&conn, "s2", 5.0, 10.0, false);
        replace_words(&conn, "v", None, &[w(5.1, "overlap"), w(7.0, "b")], Some("hallucination")).unwrap();
        conn.execute("UPDATE transcript_segments SET keep = 1 WHERE id = 's2'", []).unwrap();
        set_removed_in_range(&conn, "v", 5.0, 10.0, false).unwrap();
        let rows = query_words(&conn, "v").unwrap();
        assert!(rows[0].removed, "still inside dropped s1");
        assert!(!rows[1].removed);
    }

    #[test]
    fn word_changes_rederive_segment_keep() {
        let conn = setup();
        segment(&conn, "s1", 0.0, 5.0, true);
        segment(&conn, "s2", 5.0, 10.0, true);
        segment(&conn, "s3", 10.0, 15.0, true); // no words: left alone
        replace_words(&conn, "v", None, &[w(1.0, "a"), w(2.0, "b"), w(6.0, "c")], None).unwrap();
        let ids: Vec<String> = query_words(&conn, "v").unwrap().into_iter().map(|row| row.id).collect();
        let change = |i: usize, removed| WordRemovedChange { id: ids[i].clone(), removed };

        apply_word_changes(&conn, "v", &[change(0, true), change(2, true)], &[]).unwrap();
        let keep = |id: &str| -> bool {
            conn.query_row("SELECT keep FROM transcript_segments WHERE id = ?1", params![id], |row| row.get(0))
                .unwrap()
        };
        assert!(keep("s1"), "s1 still has 'b'");
        assert!(!keep("s2"), "all of s2's words removed");
        assert!(keep("s3"));

        apply_word_changes(&conn, "v", &[change(2, false)], &[]).unwrap();
        assert!(keep("s2"));
    }

    #[test]
    fn word_changes_leave_other_segments_keep_alone() {
        let conn = setup();
        segment(&conn, "s1", 0.0, 5.0, true);
        segment(&conn, "s2", 5.0, 10.0, false); // dropped on the Transcript page
        replace_words(&conn, "v", None, &[w(1.0, "a"), w(6.0, "b")], None).unwrap();
        // The dropped segment's word is still marked kept (say, toggled
        // before words existed); an edit in s1 must not flip s2 back.
        conn.execute("UPDATE transcript_words SET removed = 0", []).unwrap();
        let ids: Vec<String> = query_words(&conn, "v").unwrap().into_iter().map(|row| row.id).collect();
        apply_word_changes(&conn, "v", &[WordRemovedChange { id: ids[0].clone(), removed: true }], &[]).unwrap();
        let keep = |id: &str| -> bool {
            conn.query_row("SELECT keep FROM transcript_segments WHERE id = ?1", params![id], |row| row.get(0))
                .unwrap()
        };
        assert!(!keep("s1"), "s1's only word removed");
        assert!(!keep("s2"), "s2 untouched by an edit elsewhere");
    }

    #[test]
    fn word_changes_ignore_other_videos_words() {
        let conn = setup();
        replace_words(&conn, "v", None, &[w(1.0, "a")], None).unwrap();
        let id = query_words(&conn, "v").unwrap()[0].id.clone();
        apply_word_changes(&conn, "other", &[WordRemovedChange { id, removed: true }], &[]).unwrap();
        assert!(!query_words(&conn, "v").unwrap()[0].removed);
    }

    #[test]
    fn pause_decisions_upsert_clear_and_stay_in_their_video() {
        let conn = setup();
        replace_words(&conn, "v", None, &[w(1.0, "a"), w(4.0, "b")], None).unwrap();
        let id = query_words(&conn, "v").unwrap()[0].id.clone();
        let decide = |action: Option<&str>| PauseDecision {
            after_word_id: id.clone(),
            action: action.map(str::to_string),
        };
        apply_word_changes(&conn, "v", &[], &[decide(Some("shorten"))]).unwrap();
        apply_word_changes(&conn, "v", &[], &[decide(Some("remove"))]).unwrap();
        let pauses = query_pauses(&conn, "v").unwrap();
        assert_eq!(pauses.len(), 1);
        assert_eq!(pauses[0].action.as_deref(), Some("remove"));

        apply_word_changes(&conn, "other", &[], &[decide(None)]).unwrap();
        assert_eq!(query_pauses(&conn, "v").unwrap().len(), 1, "other video can't clear it");
        apply_word_changes(&conn, "v", &[], &[decide(None)]).unwrap();
        assert!(query_pauses(&conn, "v").unwrap().is_empty());

        assert!(apply_word_changes(&conn, "v", &[], &[decide(Some("explode"))]).is_err());
    }

    #[test]
    fn pause_decisions_go_when_words_are_replaced() {
        let conn = setup();
        conn.execute("PRAGMA foreign_keys = ON", []).unwrap();
        replace_words(&conn, "v", None, &[w(1.0, "a"), w(4.0, "b")], None).unwrap();
        let id = query_words(&conn, "v").unwrap()[0].id.clone();
        apply_word_changes(
            &conn,
            "v",
            &[],
            &[PauseDecision {
                after_word_id: id,
                action: Some("shorten".into()),
            }],
        )
        .unwrap();
        replace_words(&conn, "v", None, &[w(1.0, "a"), w(4.0, "b")], None).unwrap();
        assert!(query_pauses(&conn, "v").unwrap().is_empty());
    }

    #[test]
    fn cache_copy_uses_original_text_not_corrections() {
        let conn = setup();
        replace_words(&conn, "v", None, &[w(1.0, "smallroll")], None).unwrap();
        conn.execute(
            "UPDATE transcript_words SET original_text = text, text = 'smallworld', removed = 1",
            [],
        )
        .unwrap();
        let copied = query_source_words(&conn, "v").unwrap();
        assert_eq!(copied, vec![w(1.0, "smallroll")]);
    }

    #[test]
    fn deleting_the_video_deletes_its_words() {
        let conn = setup();
        conn.execute("PRAGMA foreign_keys = ON", []).unwrap();
        replace_words(&conn, "v", None, &[w(1.0, "a")], None).unwrap();
        conn.execute("DELETE FROM videos WHERE id = 'v'", []).unwrap();
        assert!(texts(&conn).is_empty());
    }

    #[test]
    fn word_text_edits_keep_whisper_text_and_clear_on_revert() {
        let conn = setup();
        replace_words(&conn, "v", None, &[w(0.0, "hello"), w(1.0, "wrold")], None).unwrap();
        let rows = query_words(&conn, "v").unwrap();
        let id = rows[1].id.clone();
        let changed = apply_word_texts(
            &conn,
            "v",
            &[WordTextChange { id: id.clone(), text: Some("  world, ".into()) }],
        )
        .unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].text, "world,");
        assert_eq!(changed[0].original_text.as_deref(), Some("wrold"));
        // A second edit keeps the first original.
        let changed = apply_word_texts(&conn, "v", &[WordTextChange { id: id.clone(), text: Some("World".into()) }]).unwrap();
        assert_eq!(changed[0].original_text.as_deref(), Some("wrold"));
        // Typing Whisper's own text is still an edit (it drops the
        // sentence's punctuation from the shown word).
        let changed = apply_word_texts(&conn, "v", &[WordTextChange { id: id.clone(), text: Some("wrold".into()) }]).unwrap();
        assert_eq!(changed[0].original_text.as_deref(), Some("wrold"));
        // A revert puts Whisper's text back: no longer corrected.
        let changed = apply_word_texts(&conn, "v", &[WordTextChange { id: id.clone(), text: None }]).unwrap();
        assert_eq!(changed[0].text, "wrold");
        assert_eq!(changed[0].original_text, None);
        // Other videos' ids are ignored.
        let changed = apply_word_texts(&conn, "other", &[WordTextChange { id, text: Some("x".into()) }]).unwrap();
        assert!(changed.is_empty());
    }
}
