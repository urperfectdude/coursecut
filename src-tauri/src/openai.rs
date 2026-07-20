//! Whisper transcription (PRD §7.4/§9) and GPT-5.5 lesson analysis (PRD
//! §7.5). This is the first place in coursecut that sends real user content
//! off-device: per `coursecut-privacy-invariants`, only the already-
//! extracted local audio file (see `ffmpeg.rs`, `videos.audio_path`) is ever
//! uploaded to Whisper, and only transcript **text** (never audio, never
//! video) is ever sent to GPT-5.5 — no other SQLite content beyond what's
//! needed to locate/identify those, and to store the result.
//!
//! Transcript caching (PRD §7.4, continued from `ffmpeg.rs`'s audio cache):
//! before calling Whisper, `transcribe_video` checks whether any other video
//! row sharing this video's `content_hash` has already finished transcription
//! (`transcript_status = 'transcribed'`), and copies its segments instead of
//! re-calling the API.

use std::path::Path;

use rusqlite::{params, OptionalExtension};

use crate::app_settings;
use crate::db::{self, DbConnection, LessonRow, TranscriptSegmentRow, Video};
use crate::settings;

/// A single transcript segment as returned by Whisper — timestamps in
/// seconds relative to the start of the audio.
#[derive(Debug, Clone)]
pub struct TranscriptSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(serde::Deserialize)]
struct WhisperResponse {
    #[serde(default)]
    segments: Vec<WhisperSegment>,
}

#[derive(serde::Deserialize)]
struct WhisperSegment {
    start: f64,
    end: f64,
    text: String,
}

/// Uploads the local file at `audio_path` to OpenAI's Whisper API
/// (`POST /v1/audio/transcriptions`, `model=whisper-1`,
/// `response_format=verbose_json` for segment-level timestamps) and parses
/// the response into `TranscriptSegment`s.
///
/// Reads the whole file into memory to build the multipart body — audio
/// extracted by `ffmpeg.rs` is mono 16kHz WAV, and Whisper itself caps
/// uploads at 25MB, so this stays bounded. Never touches the source video.
pub async fn transcribe_audio(
    audio_path: &str,
    api_key: &str,
) -> Result<Vec<TranscriptSegment>, String> {
    let audio_bytes = tokio::fs::read(audio_path)
        .await
        .map_err(|err| format!("could not read audio file {audio_path}: {err}"))?;

    let file_name = Path::new(audio_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio.wav")
        .to_string();

    let file_part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(file_name)
        .mime_str("audio/wav")
        .map_err(|err| format!("could not set audio part mime type: {err}"))?;

    let form = reqwest::multipart::Form::new()
        .text("model", "whisper-1")
        .text("response_format", "verbose_json")
        .part("file", file_part);

    // Transcription of a full lecture recording can take a while
    // server-side; a generous timeout avoids failing long (but
    // within-25MB-limit) audio prematurely.
    const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

    let client = reqwest::Client::new();
    let request = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .bearer_auth(api_key)
        .multipart(form)
        .send();

    let response = match tokio::time::timeout(REQUEST_TIMEOUT, request).await {
        Ok(Ok(response)) => response,
        Ok(Err(err)) => return Err(format!("Whisper request failed: {err}")),
        Err(_) => return Err("Whisper request timed out".to_string()),
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(300).collect();
        return Err(format!("Whisper returned {status}: {snippet}"));
    }

    let parsed: WhisperResponse = response
        .json()
        .await
        .map_err(|err| format!("could not parse Whisper response: {err}"))?;

    Ok(parsed
        .segments
        .into_iter()
        .map(|segment| TranscriptSegment {
            start: segment.start,
            end: segment.end,
            text: segment.text,
        })
        .collect())
}

/// Sets `transcript_status = 'error'` on a video row after a failed
/// transcription attempt. Mirrors `ffmpeg.rs`'s `mark_error` (same
/// best-effort pattern: if this update itself fails, the original error is
/// still what's returned to the caller).
fn mark_error(conn: &DbConnection, video_id: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    guard
        .execute(
            "UPDATE videos SET transcript_status = 'error', updated_at = ?1 WHERE id = ?2",
            params![now, video_id],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

/// Transcribes `video_id`'s already-extracted audio via Whisper (or, if
/// another video shares its `content_hash` and already has transcript
/// segments, copies those instead — see module docs), storing the result in
/// `transcript_segments` and updating `transcript_status`.
#[tauri::command(async)]
pub async fn transcribe_video(
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
) -> Result<Video, String> {
    match run_transcription(&conn, &video_id).await {
        Ok(video) => Ok(video),
        Err(message) => {
            let _ = mark_error(&conn, &video_id);
            Err(message)
        }
    }
}

async fn run_transcription(
    conn: &tauri::State<'_, DbConnection>,
    video_id: &str,
) -> Result<Video, String> {
    let (audio_path, content_hash): (Option<String>, Option<String>) = {
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        guard
            .query_row(
                "SELECT audio_path, content_hash FROM videos WHERE id = ?1",
                params![video_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .map_err(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => {
                    format!("video {video_id} does not exist")
                }
                other => other.to_string(),
            })?
    };

    let audio_path =
        audio_path.ok_or_else(|| "audio not extracted yet for this video".to_string())?;

    // Cache check (PRD §7.4): if another video row shares this content hash
    // and has already finished transcription, copy its segments rather than
    // re-calling Whisper.
    let cached_segments: Vec<(f64, f64, String)> = match &content_hash {
        Some(hash) => {
            let guard = conn.0.lock().map_err(|err| err.to_string())?;
            let source_video_id: Option<String> = guard
                .query_row(
                    "SELECT v.id FROM videos v
                     JOIN transcript_segments ts ON ts.video_id = v.id
                     WHERE v.content_hash = ?1 AND v.id != ?2
                     AND v.transcript_status = 'transcribed'
                     LIMIT 1",
                    params![hash, video_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|err| err.to_string())?;

            match source_video_id {
                Some(source_id) => {
                    let mut stmt = guard
                        .prepare(
                            "SELECT start, end, text FROM transcript_segments
                             WHERE video_id = ?1 ORDER BY start, id",
                        )
                        .map_err(|err| err.to_string())?;
                    let rows = stmt
                        .query_map(params![source_id], |row| {
                            Ok((
                                row.get::<_, f64>(0)?,
                                row.get::<_, f64>(1)?,
                                row.get::<_, String>(2)?,
                            ))
                        })
                        .map_err(|err| err.to_string())?;
                    rows.collect::<Result<Vec<_>, _>>()
                        .map_err(|err| err.to_string())?
                }
                None => Vec::new(),
            }
        }
        None => Vec::new(),
    };

    let segments: Vec<TranscriptSegment> = if !cached_segments.is_empty() {
        cached_segments
            .into_iter()
            .map(|(start, end, text)| TranscriptSegment { start, end, text })
            .collect()
    } else {
        let api_key = settings::read_stored_key()?
            .ok_or_else(|| "No OpenAI API key saved — add one in Settings".to_string())?;
        transcribe_audio(&audio_path, &api_key).await?
    };

    let now = chrono::Utc::now().to_rfc3339();
    {
        let mut guard = conn.0.lock().map_err(|err| err.to_string())?;
        // One transaction so a crash mid-insert can't orphan a partial
        // segment set, and re-running transcription on the same video_id
        // (e.g. a future retry action) replaces cleanly instead of
        // duplicating rows alongside any leftovers.
        let tx = guard.transaction().map_err(|err| err.to_string())?;

        tx.execute(
            "DELETE FROM transcript_segments WHERE video_id = ?1",
            params![video_id],
        )
        .map_err(|err| err.to_string())?;

        for segment in &segments {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO transcript_segments (id, video_id, start, end, text, keep)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                params![id, video_id, segment.start, segment.end, segment.text],
            )
            .map_err(|err| err.to_string())?;
        }
        tx.execute(
            "UPDATE videos SET transcript_status = 'transcribed', updated_at = ?1 WHERE id = ?2",
            params![now, video_id],
        )
        .map_err(|err| err.to_string())?;

        tx.commit().map_err(|err| err.to_string())?;
    }

    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    guard
        .query_row(
            "SELECT id, project_id, file_path, duration, transcript_status, created_at, updated_at, audio_path
             FROM videos WHERE id = ?1",
            params![video_id],
            db::row_to_video,
        )
        .map_err(|err| err.to_string())
}

// ---------------------------------------------------------------------
// GPT-5.5 lesson analysis (PRD §7.5)
// ---------------------------------------------------------------------

/// A single lesson-boundary suggestion returned by GPT-5.5's analysis of a
/// video's transcript. `kind` is always one of `ALLOWED_KINDS`;
/// `confidence` is always within `[0, 1]` — both are validated/clamped in
/// `analyze_transcript` before this type is constructed, so nothing
/// downstream needs to re-check them.
#[derive(Debug, Clone)]
pub struct LessonSuggestion {
    pub start: f64,
    pub end: f64,
    pub title: String,
    pub summary: String,
    pub kind: String,
    pub confidence: f64,
}

/// The `kind` values PRD §7.5 asks GPT-5.5 to distinguish. Any suggestion
/// whose `kind` isn't one of these (or is missing) falls back to `"lesson"`
/// rather than failing the whole batch — see `analyze_transcript`.
const ALLOWED_KINDS: &[&str] = &["lesson", "qna", "discussion", "break", "silence", "duplicate"];

const ANALYSIS_SYSTEM_PROMPT: &str = "You are an assistant that analyzes lecture transcripts \
for a video editing tool, to propose lesson boundaries. You are given a transcript as a \
sequence of timestamped segments (in seconds). Respond with a single JSON object of the exact \
shape {\"lessons\": [{\"start\": number, \"end\": number, \"title\": string, \"summary\": \
string, \"kind\": string, \"confidence\": number}, ...]} and nothing else — no prose, no \
markdown fences. Cover the whole transcript by tagging each proposed segment with exactly one \
`kind`: \"lesson\" (a coherent, teachable segment — give it a short title and a one- or \
two-sentence summary), \"qna\" (a question-and-answer exchange), \"discussion\" (open \
discussion or back-and-forth not structured as a single lesson), \"break\" (an off-topic break \
or pause in instruction), \"silence\" (a long stretch with no substantive spoken content), or \
\"duplicate\" (a segment that re-explains something already covered earlier in this same \
transcript). `start` and `end` must be real timestamps in seconds, drawn from (or falling \
between) the given segment boundaries, with `start` < `end`. Every suggestion must include a \
`confidence` between 0 and 1 reflecting how sure you are about that suggestion's boundaries and \
kind.";

#[derive(serde::Deserialize)]
struct ChatCompletionResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

#[derive(serde::Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(serde::Deserialize)]
struct ChatMessage {
    #[serde(default)]
    content: Option<String>,
}

/// Best-effort extraction of a finite `f64` from a JSON value that should be
/// numeric — GPT-5.5 is asked for numbers, but this also accepts a numeric
/// string (e.g. `"12.5"`) rather than discarding an otherwise-usable
/// suggestion over a formatting slip.
fn value_as_f64(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.trim().parse::<f64>().ok()))
        .filter(|n| n.is_finite())
}

/// Sends transcript **text only** (timestamps + words — never audio, never
/// video) to GPT-5.5 chat completions and parses the response into
/// validated `LessonSuggestion`s (PRD §7.5). Malformed or out-of-range
/// individual suggestions are dropped rather than failing the whole
/// response; `kind` falls back to `"lesson"` and `confidence` is clamped to
/// `[0, 1]` for anything the model returns outside the expected shape.
///
/// `instructions` is the user's optional free-text analysis preferences
/// (Settings → Analysis instructions, PRD §7.5, e.g. "always split out Q&A
/// sections separately"). When present (non-empty after trimming) it's
/// appended to `ANALYSIS_SYSTEM_PROMPT` as an additional paragraph — it
/// steers the analysis, but never replaces the structural JSON-shape
/// requirements already in that prompt. `None`/empty produces the exact
/// same system prompt as before this parameter existed.
pub async fn analyze_transcript(
    segments: &[TranscriptSegmentRow],
    api_key: &str,
    instructions: Option<&str>,
) -> Result<Vec<LessonSuggestion>, String> {
    if segments.is_empty() {
        return Err("no transcript segments to analyze".to_string());
    }

    let transcript_start = segments
        .iter()
        .map(|segment| segment.start)
        .fold(f64::INFINITY, f64::min);
    let transcript_end = segments
        .iter()
        .map(|segment| segment.end)
        .fold(f64::NEG_INFINITY, f64::max);

    let transcript_text = segments
        .iter()
        .map(|segment| format!("[{:.2}-{:.2}] {}", segment.start, segment.end, segment.text))
        .collect::<Vec<_>>()
        .join("\n");

    let user_prompt =
        format!("Transcript (timestamps in seconds):\n\n{transcript_text}");

    let system_prompt = match instructions.map(str::trim) {
        Some(instructions) if !instructions.is_empty() => format!(
            "{ANALYSIS_SYSTEM_PROMPT}\n\nAdditional user requirements for this analysis: \
             {instructions}"
        ),
        _ => ANALYSIS_SYSTEM_PROMPT.to_string(),
    };

    let request_body = serde_json::json!({
        "model": "gpt-5.5",
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    });

    // Analysis is a single text-only completion (no file upload), but a
    // full-lecture transcript plus the model's own generation time can
    // still take a while.
    const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

    let client = reqwest::Client::new();
    let request = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&request_body)
        .send();

    let response = match tokio::time::timeout(REQUEST_TIMEOUT, request).await {
        Ok(Ok(response)) => response,
        Ok(Err(err)) => return Err(format!("GPT-5.5 request failed: {err}")),
        Err(_) => return Err("GPT-5.5 request timed out".to_string()),
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(300).collect();
        return Err(format!("GPT-5.5 returned {status}: {snippet}"));
    }

    let parsed: ChatCompletionResponse = response
        .json()
        .await
        .map_err(|err| format!("could not parse GPT-5.5 response: {err}"))?;

    let content = parsed
        .choices
        .into_iter()
        .next()
        .and_then(|choice| choice.message.content)
        .ok_or_else(|| "GPT-5.5 response had no message content".to_string())?;

    parse_lesson_suggestions(&content, transcript_start, transcript_end)
}

/// Parses a chat-completion message's JSON `content` string (expected shape:
/// `{"lessons": [...]}`, per `ANALYSIS_SYSTEM_PROMPT`) into validated
/// `LessonSuggestion`s. Split out from `analyze_transcript` so this parsing
/// logic — the part with no network dependency — can be exercised directly
/// against a realistic sample response.
fn parse_lesson_suggestions(
    content: &str,
    transcript_start: f64,
    transcript_end: f64,
) -> Result<Vec<LessonSuggestion>, String> {
    let payload: serde_json::Value = serde_json::from_str(content)
        .map_err(|err| format!("could not parse GPT-5.5 JSON payload: {err}"))?;

    let raw_lessons = payload
        .get("lessons")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "GPT-5.5 JSON payload is missing a \"lessons\" array".to_string())?;

    let mut suggestions = Vec::new();
    for raw in raw_lessons {
        let (Some(start), Some(end)) = (
            raw.get("start").and_then(value_as_f64),
            raw.get("end").and_then(value_as_f64),
        ) else {
            continue;
        };
        // Reject suggestions whose boundaries aren't real timestamps within
        // (a small tolerance around) the transcript's own time range.
        if end <= start || start < transcript_start - 1.0 || end > transcript_end + 1.0 {
            continue;
        }

        let title = raw
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("Untitled lesson")
            .to_string();
        let summary = raw
            .get("summary")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let kind = raw
            .get("kind")
            .and_then(|value| value.as_str())
            .filter(|kind| ALLOWED_KINDS.contains(kind))
            .unwrap_or("lesson")
            .to_string();
        let confidence = raw
            .get("confidence")
            .and_then(value_as_f64)
            .unwrap_or(0.5)
            .clamp(0.0, 1.0);

        suggestions.push(LessonSuggestion {
            start,
            end,
            title,
            summary,
            kind,
            confidence,
        });
    }

    Ok(suggestions)
}

#[cfg(test)]
mod parse_lesson_suggestions_tests {
    use super::parse_lesson_suggestions;

    // Transcript span used by every case below: [0, 100].
    const START: f64 = 0.0;
    const END: f64 = 100.0;

    #[test]
    fn keeps_valid_suggestions_and_clamps_confidence() {
        let content = serde_json::json!({
            "lessons": [
                {"start": 0.0, "end": 10.0, "title": "Intro", "summary": "Welcome", "kind": "lesson", "confidence": 0.9},
                // confidence out of [0,1] on both ends should be clamped, not dropped.
                {"start": 10.0, "end": 20.0, "title": "Q&A", "summary": "", "kind": "qna", "confidence": 5.0},
                {"start": 20.0, "end": 30.0, "title": "Silence", "summary": "", "kind": "silence", "confidence": -1.0},
                // timestamps as numeric strings should still parse.
                {"start": "30.0", "end": "40.0", "title": "String timestamps", "summary": "", "kind": "break", "confidence": 0.4},
            ]
        })
        .to_string();

        let suggestions = parse_lesson_suggestions(&content, START, END).unwrap();

        assert_eq!(suggestions.len(), 4);
        assert_eq!(suggestions[1].confidence, 1.0, "confidence > 1 should clamp to 1.0");
        assert_eq!(suggestions[2].confidence, 0.0, "confidence < 0 should clamp to 0.0");
        assert_eq!(suggestions[3].start, 30.0, "numeric-string timestamps should parse");
        assert_eq!(suggestions[3].end, 40.0);
    }

    #[test]
    fn falls_back_to_lesson_kind_for_unrecognized_or_missing_kind() {
        let content = serde_json::json!({
            "lessons": [
                {"start": 0.0, "end": 10.0, "title": "Weird kind", "summary": "", "kind": "made_up_category", "confidence": 0.5},
                {"start": 10.0, "end": 20.0, "title": "No kind at all", "summary": ""},
            ]
        })
        .to_string();

        let suggestions = parse_lesson_suggestions(&content, START, END).unwrap();

        assert_eq!(suggestions.len(), 2);
        assert_eq!(suggestions[0].kind, "lesson");
        assert_eq!(suggestions[1].kind, "lesson");
    }

    #[test]
    fn drops_malformed_or_out_of_range_suggestions_without_failing_the_batch() {
        let content = serde_json::json!({
            "lessons": [
                // valid, should survive.
                {"start": 0.0, "end": 10.0, "title": "Valid", "summary": "", "kind": "lesson", "confidence": 0.8},
                // end <= start.
                {"start": 20.0, "end": 15.0, "title": "Backwards", "summary": "", "kind": "lesson", "confidence": 0.5},
                // non-numeric, non-numeric-string timestamp.
                {"start": "not-a-number", "end": 30.0, "title": "Bad start", "summary": "", "kind": "lesson", "confidence": 0.5},
                // wildly out of the transcript's own time range.
                {"start": 500.0, "end": 600.0, "title": "Out of range", "summary": "", "kind": "lesson", "confidence": 0.5},
                // missing start/end entirely.
                {"title": "No timestamps", "summary": "", "kind": "lesson", "confidence": 0.5},
            ]
        })
        .to_string();

        let suggestions = parse_lesson_suggestions(&content, START, END).unwrap();

        assert_eq!(suggestions.len(), 1, "only the single valid suggestion should survive");
        assert_eq!(suggestions[0].title, "Valid");
    }

    #[test]
    fn missing_lessons_array_is_an_error() {
        let content = serde_json::json!({"not_lessons": []}).to_string();
        assert!(parse_lesson_suggestions(&content, START, END).is_err());
    }

    #[test]
    fn non_json_content_is_an_error_not_a_panic() {
        assert!(parse_lesson_suggestions("this is not json", START, END).is_err());
    }

    #[test]
    fn empty_lessons_array_is_ok_with_no_suggestions() {
        let content = serde_json::json!({"lessons": []}).to_string();
        let suggestions = parse_lesson_suggestions(&content, START, END).unwrap();
        assert!(suggestions.is_empty());
    }
}

/// Loads `video_id`'s kept transcript segments, sends them to GPT-5.5 via
/// `analyze_transcript`, and replaces that video's AI-sourced lessons with
/// the result.
///
/// Idempotency (mirrors `transcribe_video`'s pattern): a single transaction
/// deletes only this video's `source = 'ai'` lessons — never any future
/// user-created/edited ones — then inserts the fresh suggestions with new
/// ids and `sort_order` assigned by sorted start time, then commits. So
/// re-running Analyze on the same video is a clean replace, not an
/// accumulation.
#[tauri::command(async)]
pub async fn analyze_video(
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
) -> Result<Vec<LessonRow>, String> {
    let segments: Vec<TranscriptSegmentRow> = {
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        let mut stmt = guard
            .prepare(
                "SELECT id, video_id, start, end, text, keep FROM transcript_segments
                 WHERE video_id = ?1 AND keep = 1 ORDER BY start, id",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![video_id], |row| {
                Ok(TranscriptSegmentRow {
                    id: row.get("id")?,
                    video_id: row.get("video_id")?,
                    start: row.get("start")?,
                    end: row.get("end")?,
                    text: row.get("text")?,
                    keep: row.get("keep")?,
                })
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    if segments.is_empty() {
        return Err(
            "This video has no transcript yet — transcribe it before analyzing.".to_string(),
        );
    }

    let instructions: Option<String> = {
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        app_settings::read_analysis_instructions(&guard)?
    };

    let api_key = settings::read_stored_key()?
        .ok_or_else(|| "No OpenAI API key saved — add one in Settings".to_string())?;

    let mut suggestions =
        analyze_transcript(&segments, &api_key, instructions.as_deref()).await?;
    suggestions.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

    {
        let mut guard = conn.0.lock().map_err(|err| err.to_string())?;
        // One transaction so re-running analysis on the same video replaces
        // its AI-sourced lessons cleanly instead of accumulating duplicates
        // — only `source = 'ai'` rows are cleared, so any future manually
        // created/edited lessons (source != 'ai') are left untouched.
        let tx = guard.transaction().map_err(|err| err.to_string())?;

        tx.execute(
            "DELETE FROM lessons WHERE video_id = ?1 AND source = 'ai'",
            params![video_id],
        )
        .map_err(|err| err.to_string())?;

        for (index, suggestion) in suggestions.iter().enumerate() {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO lessons (id, video_id, title, summary, start, end, sort_order, confidence, kind, source)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'ai')",
                params![
                    id,
                    video_id,
                    suggestion.title,
                    suggestion.summary,
                    suggestion.start,
                    suggestion.end,
                    index as i64,
                    suggestion.confidence,
                    suggestion.kind,
                ],
            )
            .map_err(|err| err.to_string())?;
        }

        tx.commit().map_err(|err| err.to_string())?;
    }

    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    let mut stmt = guard
        .prepare(
            "SELECT id, video_id, title, summary, start, end, sort_order, confidence, kind, source
             FROM lessons WHERE video_id = ?1 ORDER BY sort_order, id",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![video_id], db::row_to_lesson)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}
