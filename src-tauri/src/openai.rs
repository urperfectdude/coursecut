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

use regex::Regex;
use rusqlite::{params, OptionalExtension};
use tauri::AppHandle;

use crate::app_settings;
use crate::db::{self, DbConnection, LessonRow, LessonSegmentRow, TranscriptSegmentRow, Video};
use crate::progress::{self, Stage};
use crate::settings;
use crate::wav;

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

/// Whisper's documented upload cap is 25MB. This is kept comfortably under
/// that (a ~1MB margin) so header overhead/rounding never pushes a
/// "just under the limit" file over the real cap.
const SAFE_UPLOAD_BYTES: u64 = 24_000_000;

/// Target size for each chunk when splitting oversized audio. At
/// `extract_audio`'s fixed mono/16kHz/16-bit output (32 KB/s), this is
/// exactly 10 minutes of audio (~18.3MB) — comfortably under
/// `SAFE_UPLOAD_BYTES` even after the silence-seeking boundary picker
/// nudges a cut a few tens of seconds away from this target in either
/// direction.
const CHUNK_TARGET_BYTES: usize = 19_200_000;

/// Uploads the local file at `audio_path` to OpenAI's Whisper API
/// (`POST /v1/audio/transcriptions`, `model=whisper-1`,
/// `response_format=verbose_json` for segment-level timestamps) and parses
/// the response into `TranscriptSegment`s.
///
/// Whisper caps uploads at 25MB (`SAFE_UPLOAD_BYTES` is a safe margin
/// under that). Audio extracted by `ffmpeg.rs` is mono 16kHz WAV; most
/// recordings are short enough to stay under the cap and go up in a
/// single request (unchanged from before chunking existed). Anything
/// longer is split via `wav.rs` into sub-cap WAV chunks, each uploaded in
/// its own sequential request, with every returned segment's timestamps
/// offset back onto the full recording's timeline before merging — see
/// `merge_chunk_segments`. Either way, only the already-extracted local
/// audio bytes ever leave the process, now possibly in several pieces
/// instead of one. Never touches the source video.
pub async fn transcribe_audio(
    app: &AppHandle,
    video_id: &str,
    attempt: u32,
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

    if audio_bytes.len() as u64 <= SAFE_UPLOAD_BYTES {
        progress::emit(app, video_id, Stage::Transcribing, None, None, attempt);
        return upload_chunk(audio_bytes, file_name, api_key).await;
    }

    let chunks = wav::split_into_chunks(&audio_bytes, CHUNK_TARGET_BYTES)?;
    let total = chunks.len();
    progress::emit(app, video_id, Stage::Transcribing, None, None, attempt);

    let mut chunk_results: Vec<(Vec<TranscriptSegment>, f64)> = Vec::with_capacity(total);
    for (index, (chunk_bytes, start_offset_secs)) in chunks.into_iter().enumerate() {
        progress::emit(
            app,
            video_id,
            Stage::Transcribing,
            Some((index + 1) as f64 / total as f64),
            Some(format!("chunk {} of {}", index + 1, total)),
            attempt,
        );
        // A chunk's own upload failing fails the whole transcription — the
        // `?` here propagates up through `run_transcription`'s existing
        // `mark_error` path, so no partial/ambiguous transcript is ever
        // written.
        let chunk_name = format!("chunk-{index:03}-{file_name}");
        let segments = upload_chunk(chunk_bytes, chunk_name, api_key).await?;
        chunk_results.push((segments, start_offset_secs));
    }

    Ok(merge_chunk_segments(chunk_results))
}

/// Uploads a single already-in-memory WAV file (a whole recording, or one
/// chunk of one) to Whisper and parses the response into
/// `TranscriptSegment`s, with timestamps relative to the start of
/// `audio_bytes` (i.e. not yet offset for its position in a longer
/// recording — see `merge_chunk_segments` for that).
async fn upload_chunk(
    audio_bytes: Vec<u8>,
    file_name: String,
    api_key: &str,
) -> Result<Vec<TranscriptSegment>, String> {
    let file_part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(file_name)
        .mime_str("audio/wav")
        .map_err(|err| format!("could not set audio part mime type: {err}"))?;

    let form = reqwest::multipart::Form::new()
        .text("model", "whisper-1")
        .text("response_format", "verbose_json")
        .part("file", file_part);

    // Transcription of a full lecture recording (or a ~10-minute chunk of
    // one) can take a while server-side; a generous timeout avoids failing
    // long (but within-limit) audio prematurely.
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

/// Offsets each chunk's Whisper-returned segment timestamps by that
/// chunk's `start_offset_secs` (its position in the full recording) and
/// concatenates them, in chunk order, into one merged timeline. Pure/no
/// network — exercised directly in `chunk_merge_tests`, below.
fn merge_chunk_segments(chunks: Vec<(Vec<TranscriptSegment>, f64)>) -> Vec<TranscriptSegment> {
    chunks
        .into_iter()
        .flat_map(|(segments, offset)| {
            segments.into_iter().map(move |segment| TranscriptSegment {
                start: segment.start + offset,
                end: segment.end + offset,
                text: segment.text,
            })
        })
        .collect()
}

#[cfg(test)]
mod chunk_merge_tests {
    use super::{merge_chunk_segments, TranscriptSegment};

    fn seg(start: f64, end: f64, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            start,
            end,
            text: text.to_string(),
        }
    }

    #[test]
    fn offsets_and_concatenates_chunks_in_order() {
        let chunks = vec![
            (vec![seg(0.0, 5.0, "hello"), seg(5.0, 9.5, "world")], 0.0),
            (vec![seg(0.0, 3.0, "second"), seg(3.0, 7.2, "chunk")], 600.0),
            (vec![seg(0.0, 2.0, "third")], 1180.0),
        ];

        let merged = merge_chunk_segments(chunks);

        assert_eq!(merged.len(), 5);
        assert_eq!(merged[0].start, 0.0);
        assert_eq!(merged[0].end, 5.0);
        assert_eq!(merged[1].start, 5.0);
        assert_eq!(
            merged[2].start, 600.0,
            "second chunk's segments should be offset by its start_offset_secs"
        );
        assert_eq!(merged[2].end, 603.0);
        assert_eq!(merged[2].text, "second");
        assert_eq!(merged[3].text, "chunk");
        assert_eq!(merged[3].start, 603.0);
        assert_eq!(merged[3].end, 607.2);
        assert_eq!(merged[4].start, 1180.0);
        assert_eq!(merged[4].end, 1182.0);
    }

    #[test]
    fn empty_chunk_list_produces_no_segments() {
        assert!(merge_chunk_segments(Vec::new()).is_empty());
    }

    #[test]
    fn a_chunk_with_no_segments_contributes_nothing_but_others_still_merge() {
        let chunks = vec![
            (vec![seg(0.0, 1.0, "a")], 0.0),
            (Vec::new(), 60.0),
            (vec![seg(0.0, 1.0, "b")], 120.0),
        ];
        let merged = merge_chunk_segments(chunks);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].start, 0.0);
        assert_eq!(merged[1].start, 120.0);
        assert_eq!(merged[1].text, "b");
    }
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
    app: AppHandle,
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
    attempt: u32,
) -> Result<Video, String> {
    match run_transcription(&app, &conn, &video_id, attempt).await {
        Ok(video) => Ok(video),
        Err(message) => {
            let _ = mark_error(&conn, &video_id);
            Err(message)
        }
    }
}

async fn run_transcription(
    app: &AppHandle,
    conn: &tauri::State<'_, DbConnection>,
    video_id: &str,
    attempt: u32,
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
        transcribe_audio(app, video_id, attempt, &audio_path, &api_key).await?
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

/// A single lesson suggestion returned by GPT-5.5's analysis of a video's
/// transcript. `segments` is one or more `(start, end)` ranges (in seconds)
/// that together make up the lesson — always non-empty and each individually
/// valid (`start < end`, within the transcript's time range); a lesson can be
/// assembled from non-contiguous parts, and lessons may have gaps or overlap
/// between them. `kind` is always one of `ALLOWED_KINDS`; `confidence` is
/// always within `[0, 1]` — both are validated/clamped in
/// `analyze_transcript` before this type is constructed, so nothing
/// downstream needs to re-check them.
#[derive(Debug, Clone)]
pub struct LessonSuggestion {
    pub segments: Vec<(f64, f64)>,
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
shape {\"lessons\": [{\"segments\": [{\"start\": number, \"end\": number}, ...], \"title\": \
string, \"summary\": string, \"kind\": string, \"confidence\": number}, ...]} and nothing else \
— no prose, no markdown fences. Only propose lessons for material that actually belongs in one \
— do not force coverage of the whole transcript. It is fine, and expected, for there to be gaps \
between lessons (e.g. dead air, an off-topic tangent, or a break that doesn't deserve its own \
entry), and it is fine for two lessons' segments to overlap where the content justifies it (for \
example, a duplicate explanation might overlap the original it repeats). Each lesson's \
`segments` array lists the one or more timestamp ranges that make up that lesson — most lessons \
will have exactly one, but a lesson may be assembled from multiple non-contiguous ranges when \
the same material is split across the transcript. Tag each proposed lesson with exactly one \
`kind`: \"lesson\" (a coherent, teachable segment — give it a short title and a one- or \
two-sentence summary), \"qna\" (a question-and-answer exchange), \"discussion\" (open \
discussion or back-and-forth not structured as a single lesson), \"break\" (an off-topic break \
or pause in instruction), \"silence\" (a long stretch with no substantive spoken content), or \
\"duplicate\" (a segment that re-explains something already covered earlier in this same \
transcript). Each `start` and `end` must be a real timestamp in seconds, drawn from (or falling \
between) the given segment boundaries, with `start` < `end`. Every lesson must include a \
`confidence` between 0 and 1 reflecting how sure you are about that lesson's boundaries and \
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

/// Validates and parses a JSON `segments` array (`[{"start": number, "end": number}, ...]`,
/// numeric-or-numeric-string per `value_as_f64`) into `(f64, f64)` ranges, silently dropping
/// (never erroring on) any individual entry that isn't well-formed: non-numeric bounds,
/// `start >= end`, or bounds outside `[range_start - 1.0, range_end + 1.0]` (a small tolerance
/// around the transcript context actually given — mirrors both system prompts telling the model
/// to draw ranges from within it). Returns an empty `Vec` (not an error) if `value` isn't a JSON
/// array at all, or every entry in it was invalid. Shared by `parse_lesson_suggestions` (whole-
/// video analysis) and `parse_edit_segments` (per-lesson AI edit, below) rather than duplicating
/// this validation loop.
fn parse_segment_array(value: &serde_json::Value, range_start: f64, range_end: f64) -> Vec<(f64, f64)> {
    let Some(raw_segments) = value.as_array() else {
        return Vec::new();
    };

    let mut segments = Vec::new();
    for raw_segment in raw_segments {
        let (Some(start), Some(end)) = (
            raw_segment.get("start").and_then(value_as_f64),
            raw_segment.get("end").and_then(value_as_f64),
        ) else {
            continue;
        };
        // Reject segments whose boundaries aren't real timestamps within
        // (a small tolerance around) the given range.
        if end <= start || start < range_start - 1.0 || end > range_end + 1.0 {
            continue;
        }
        segments.push((start, end));
    }
    segments
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
        // Missing/non-array `segments`, or every entry in it invalid, both
        // fall out of `parse_segment_array` as an empty `Vec` — drop the
        // lesson in either case, but this isn't an error for the whole
        // batch (a partially-valid lesson keeps its valid segments).
        let segments = match raw.get("segments") {
            Some(value) => parse_segment_array(value, transcript_start, transcript_end),
            None => Vec::new(),
        };

        if segments.is_empty() {
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
            segments,
            title,
            summary,
            kind,
            confidence,
        });
    }

    Ok(suggestions)
}

/// Gap-detection threshold for trimming lesson segment boundaries against
/// dead air (`docs/ux-overhaul-plan.md`, Phase 5b / M6). Gaps between
/// consecutive kept transcript segments longer than this are treated as
/// silence and trimmed from the edges of any lesson segment that overlaps
/// them.
const SILENCE_GAP_THRESHOLD_SECS: f64 = 2.0;

/// Computes dead-air gaps from `segments` — the kept transcript segments for
/// a video, already sorted by `start` (the same ordering `analyze_video`
/// loads them in and passes to `analyze_transcript`). For each adjacent pair,
/// the gap between the end of one and the start of the next is reported only
/// if it exceeds `threshold_secs`. Because `segments` only contains
/// `keep = 1` rows to begin with, a reported gap here is either genuine
/// silence or content the user already marked for removal — both are fair
/// game to trim lesson boundaries toward.
fn silence_gaps(segments: &[TranscriptSegmentRow], threshold_secs: f64) -> Vec<(f64, f64)> {
    segments
        .windows(2)
        .filter_map(|pair| {
            let (prev, next) = (&pair[0], &pair[1]);
            let gap = next.start - prev.end;
            (gap > threshold_secs).then_some((prev.end, next.start))
        })
        .collect()
}

/// Trims a single segment's own boundaries against any `gaps` that overlap
/// them: a gap overlapping the segment's leading edge pushes `start` forward
/// to the gap's end; a gap overlapping the trailing edge pulls `end` back to
/// the gap's start. A gap fully inside the segment (touching neither
/// boundary) is left alone — this trims edges, it never splits a segment
/// into two. Returns `None` if trimming consumes the entire segment (i.e.
/// the resulting `start >= end`), such as when a single gap covers the whole
/// segment.
fn trim_segment_against_gaps(segment: (f64, f64), gaps: &[(f64, f64)]) -> Option<(f64, f64)> {
    let (mut start, mut end) = segment;
    for &(gap_start, gap_end) in gaps {
        let (pre_start, pre_end) = (start, end);
        // Leading silence: the gap overlaps the segment's current start.
        if gap_start <= pre_start && gap_end > pre_start {
            start = start.max(gap_end);
        }
        // Trailing silence: the gap overlaps the segment's current end.
        if gap_end >= pre_end && gap_start < pre_end {
            end = end.min(gap_start);
        }
    }
    (start < end).then_some((start, end))
}

/// Applies `trim_segment_against_gaps` to every segment of every suggestion
/// against the same `gaps` list. A segment trimmed to nothing is dropped; a
/// suggestion is dropped entirely only if *all* of its segments were
/// consumed by silence — mirroring `parse_lesson_suggestions`'s existing
/// rule of dropping a lesson only when every one of its segments is invalid.
/// Trimming happens before `replace_ai_lessons_tx` persists these segments,
/// so whatever survives here is exactly what `lesson_segments` stores and
/// what `LessonCard` plays back — the trim is visible in the segment list,
/// never a silent adjustment.
fn trim_silence_from_suggestions(
    suggestions: Vec<LessonSuggestion>,
    gaps: &[(f64, f64)],
) -> Vec<LessonSuggestion> {
    suggestions
        .into_iter()
        .filter_map(|suggestion| {
            let segments: Vec<(f64, f64)> = suggestion
                .segments
                .iter()
                .filter_map(|&segment| trim_segment_against_gaps(segment, gaps))
                .collect();
            if segments.is_empty() {
                return None;
            }
            Some(LessonSuggestion {
                segments,
                ..suggestion
            })
        })
        .collect()
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
                {"segments": [{"start": 0.0, "end": 10.0}], "title": "Intro", "summary": "Welcome", "kind": "lesson", "confidence": 0.9},
                // confidence out of [0,1] on both ends should be clamped, not dropped.
                {"segments": [{"start": 10.0, "end": 20.0}], "title": "Q&A", "summary": "", "kind": "qna", "confidence": 5.0},
                {"segments": [{"start": 20.0, "end": 30.0}], "title": "Silence", "summary": "", "kind": "silence", "confidence": -1.0},
                // timestamps as numeric strings should still parse.
                {"segments": [{"start": "30.0", "end": "40.0"}], "title": "String timestamps", "summary": "", "kind": "break", "confidence": 0.4},
            ]
        })
        .to_string();

        let suggestions = parse_lesson_suggestions(&content, START, END).unwrap();

        assert_eq!(suggestions.len(), 4);
        assert_eq!(suggestions[1].confidence, 1.0, "confidence > 1 should clamp to 1.0");
        assert_eq!(suggestions[2].confidence, 0.0, "confidence < 0 should clamp to 0.0");
        assert_eq!(
            suggestions[3].segments,
            vec![(30.0, 40.0)],
            "numeric-string timestamps should parse"
        );
    }

    #[test]
    fn falls_back_to_lesson_kind_for_unrecognized_or_missing_kind() {
        let content = serde_json::json!({
            "lessons": [
                {"segments": [{"start": 0.0, "end": 10.0}], "title": "Weird kind", "summary": "", "kind": "made_up_category", "confidence": 0.5},
                {"segments": [{"start": 10.0, "end": 20.0}], "title": "No kind at all", "summary": ""},
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
                {"segments": [{"start": 0.0, "end": 10.0}], "title": "Valid", "summary": "", "kind": "lesson", "confidence": 0.8},
                // end <= start.
                {"segments": [{"start": 20.0, "end": 15.0}], "title": "Backwards", "summary": "", "kind": "lesson", "confidence": 0.5},
                // non-numeric, non-numeric-string timestamp.
                {"segments": [{"start": "not-a-number", "end": 30.0}], "title": "Bad start", "summary": "", "kind": "lesson", "confidence": 0.5},
                // wildly out of the transcript's own time range.
                {"segments": [{"start": 500.0, "end": 600.0}], "title": "Out of range", "summary": "", "kind": "lesson", "confidence": 0.5},
                // missing segments entirely.
                {"title": "No segments", "summary": "", "kind": "lesson", "confidence": 0.5},
            ]
        })
        .to_string();

        let suggestions = parse_lesson_suggestions(&content, START, END).unwrap();

        assert_eq!(suggestions.len(), 1, "only the single valid suggestion should survive");
        assert_eq!(suggestions[0].title, "Valid");
    }

    #[test]
    fn multi_segment_lesson_keeps_all_non_contiguous_segments() {
        let content = serde_json::json!({
            "lessons": [
                {
                    "segments": [
                        {"start": 0.0, "end": 10.0},
                        {"start": 50.0, "end": 60.0},
                    ],
                    "title": "Split lesson",
                    "summary": "",
                    "kind": "lesson",
                    "confidence": 0.7,
                },
            ]
        })
        .to_string();

        let suggestions = parse_lesson_suggestions(&content, START, END).unwrap();

        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].segments, vec![(0.0, 10.0), (50.0, 60.0)]);
    }

    #[test]
    fn drops_only_the_invalid_segments_of_a_partially_valid_lesson() {
        let content = serde_json::json!({
            "lessons": [
                {
                    "segments": [
                        {"start": 0.0, "end": 10.0},
                        // end <= start — dropped.
                        {"start": 20.0, "end": 15.0},
                        // out of transcript range — dropped.
                        {"start": 500.0, "end": 600.0},
                        {"start": 50.0, "end": 60.0},
                    ],
                    "title": "Partially valid",
                    "summary": "",
                    "kind": "lesson",
                    "confidence": 0.6,
                },
            ]
        })
        .to_string();

        let suggestions = parse_lesson_suggestions(&content, START, END).unwrap();

        assert_eq!(suggestions.len(), 1, "the lesson survives since some segments are valid");
        assert_eq!(suggestions[0].segments, vec![(0.0, 10.0), (50.0, 60.0)]);
    }

    #[test]
    fn drops_the_whole_lesson_when_all_segments_are_invalid() {
        let content = serde_json::json!({
            "lessons": [
                {
                    "segments": [
                        {"start": 20.0, "end": 15.0},
                        {"start": 500.0, "end": 600.0},
                    ],
                    "title": "All invalid",
                    "summary": "",
                    "kind": "lesson",
                    "confidence": 0.5,
                },
                // control: a fully valid lesson in the same batch should still survive.
                {"segments": [{"start": 0.0, "end": 10.0}], "title": "Valid", "summary": "", "kind": "lesson", "confidence": 0.5},
            ]
        })
        .to_string();

        let suggestions = parse_lesson_suggestions(&content, START, END).unwrap();

        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].title, "Valid");
    }

    #[test]
    fn drops_lesson_with_missing_or_non_array_segments_key() {
        let content = serde_json::json!({
            "lessons": [
                {"title": "Missing segments key", "summary": "", "kind": "lesson", "confidence": 0.5},
                {"segments": "not an array", "title": "Segments not an array", "summary": "", "kind": "lesson", "confidence": 0.5},
                {"segments": [{"start": 0.0, "end": 10.0}], "title": "Valid", "summary": "", "kind": "lesson", "confidence": 0.5},
            ]
        })
        .to_string();

        let suggestions = parse_lesson_suggestions(&content, START, END).unwrap();

        assert_eq!(suggestions.len(), 1, "not an error for the batch, just dropped lessons");
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

#[cfg(test)]
mod silence_trimming_tests {
    use super::{
        silence_gaps, trim_segment_against_gaps, trim_silence_from_suggestions, LessonSuggestion,
        TranscriptSegmentRow,
    };

    /// Minimal kept-transcript-segment fixture — only `start`/`end` matter to
    /// `silence_gaps`.
    fn segment(start: f64, end: f64) -> TranscriptSegmentRow {
        TranscriptSegmentRow {
            id: "seg".to_string(),
            video_id: "video".to_string(),
            start,
            end,
            text: "text".to_string(),
            keep: true,
        }
    }

    fn suggestion(segments: Vec<(f64, f64)>) -> LessonSuggestion {
        LessonSuggestion {
            segments,
            title: "Lesson".to_string(),
            summary: String::new(),
            kind: "lesson".to_string(),
            confidence: 0.5,
        }
    }

    // --- silence_gaps ---

    #[test]
    fn small_gap_below_threshold_is_not_reported() {
        let segments = vec![segment(0.0, 10.0), segment(11.0, 20.0)];
        assert!(silence_gaps(&segments, 2.0).is_empty());
    }

    #[test]
    fn gap_above_threshold_is_reported_with_correct_bounds() {
        let segments = vec![segment(0.0, 10.0), segment(15.0, 20.0)];
        assert_eq!(silence_gaps(&segments, 2.0), vec![(10.0, 15.0)]);
    }

    #[test]
    fn multiple_gaps_are_all_found() {
        let segments = vec![
            segment(0.0, 10.0),
            segment(15.0, 20.0),
            segment(21.0, 30.0),
            segment(40.0, 50.0),
        ];
        // (10,15) above threshold, (20,21) below threshold, (30,40) above threshold.
        assert_eq!(silence_gaps(&segments, 2.0), vec![(10.0, 15.0), (30.0, 40.0)]);
    }

    #[test]
    fn no_segments_or_single_segment_produces_no_gaps() {
        assert!(silence_gaps(&[], 2.0).is_empty());
        assert!(silence_gaps(&[segment(0.0, 10.0)], 2.0).is_empty());
    }

    // --- trim_segment_against_gaps ---

    #[test]
    fn start_landing_inside_a_gap_advances_to_gap_end() {
        let trimmed = trim_segment_against_gaps((5.0, 20.0), &[(3.0, 8.0)]);
        assert_eq!(trimmed, Some((8.0, 20.0)));
    }

    #[test]
    fn end_landing_inside_a_gap_pulls_back_to_gap_start() {
        let trimmed = trim_segment_against_gaps((5.0, 20.0), &[(15.0, 25.0)]);
        assert_eq!(trimmed, Some((5.0, 15.0)));
    }

    #[test]
    fn segment_with_no_overlapping_gap_is_unchanged() {
        let trimmed = trim_segment_against_gaps((5.0, 20.0), &[(100.0, 110.0)]);
        assert_eq!(trimmed, Some((5.0, 20.0)));
    }

    #[test]
    fn segment_entirely_inside_a_gap_returns_none() {
        let trimmed = trim_segment_against_gaps((10.0, 15.0), &[(5.0, 20.0)]);
        assert_eq!(trimmed, None);
    }

    #[test]
    fn interior_gap_is_left_unchanged_not_split() {
        let trimmed = trim_segment_against_gaps((0.0, 100.0), &[(40.0, 50.0)]);
        assert_eq!(trimmed, Some((0.0, 100.0)));
    }

    #[test]
    fn segment_trimmed_on_both_edges_by_two_non_adjacent_gaps() {
        // Leading gap overlaps `start`, trailing gap overlaps `end`, in one call.
        let trimmed = trim_segment_against_gaps((0.0, 100.0), &[(-5.0, 10.0), (90.0, 105.0)]);
        assert_eq!(trimmed, Some((10.0, 90.0)));

        // Order of gaps in the slice shouldn't matter.
        let trimmed_reversed =
            trim_segment_against_gaps((0.0, 100.0), &[(90.0, 105.0), (-5.0, 10.0)]);
        assert_eq!(trimmed_reversed, Some((10.0, 90.0)));
    }

    #[test]
    fn two_adjacent_gaps_together_fully_consume_a_segment() {
        // (5,15) trims `start` up to 15; (15,25) trims `end` down to 15 —
        // together they swallow the segment even though neither gap alone
        // covers the whole thing.
        let trimmed = trim_segment_against_gaps((10.0, 20.0), &[(5.0, 15.0), (15.0, 25.0)]);
        assert_eq!(trimmed, None);
    }

    // --- trim_silence_from_suggestions ---

    #[test]
    fn one_segment_trimmed_away_but_another_survives_keeps_the_lesson() {
        let suggestions = vec![suggestion(vec![(10.0, 15.0), (50.0, 60.0)])];
        // First segment is entirely inside the gap and is dropped; second
        // segment doesn't overlap any gap and survives untouched.
        let gaps = vec![(5.0, 20.0)];

        let trimmed = trim_silence_from_suggestions(suggestions, &gaps);

        assert_eq!(trimmed.len(), 1);
        assert_eq!(trimmed[0].segments, vec![(50.0, 60.0)]);
    }

    #[test]
    fn suggestion_with_all_segments_consumed_by_silence_is_dropped() {
        let suggestions = vec![suggestion(vec![(10.0, 15.0), (52.0, 58.0)])];
        let gaps = vec![(5.0, 20.0), (50.0, 60.0)];

        let trimmed = trim_silence_from_suggestions(suggestions, &gaps);

        assert!(trimmed.is_empty());
    }

    #[test]
    fn suggestion_with_no_overlapping_gaps_passes_through_unchanged() {
        let suggestions = vec![suggestion(vec![(5.0, 20.0)])];
        let gaps = vec![(100.0, 110.0)];

        let trimmed = trim_silence_from_suggestions(suggestions, &gaps);

        assert_eq!(trimmed.len(), 1);
        assert_eq!(trimmed[0].segments, vec![(5.0, 20.0)]);
    }
}

/// Deletes `video_id`'s existing `source = 'ai'` lessons and inserts one
/// fresh `lessons` row per `suggestion`, in the order given (`sort_order` is
/// assigned by that order, so callers should sort `suggestions` by their
/// minimum segment start first). Each inserted lesson also gets one
/// `lesson_segments` row per entry in `suggestion.segments` (sorted by
/// `start`, with `sort_order` assigned by that sorted order), and the
/// lesson's cached `start`/`end` bounds are the min segment start / max
/// segment end across those rows — this is a fresh INSERT-only path (the
/// lesson doesn't exist yet), so it computes bounds and writes
/// `lesson_segments` directly rather than going through
/// `db::add_lesson_segment_tx`/`recompute_lesson_bounds_tx`, which assume the
/// lesson already exists with prior segments to recompute cached bounds
/// from. Manually created/edited lessons (`source != 'ai'`) are left
/// untouched. Caller owns the transaction and commits it.
fn replace_ai_lessons_tx(
    tx: &rusqlite::Transaction<'_>,
    video_id: &str,
    suggestions: &[LessonSuggestion],
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM lessons WHERE video_id = ?1 AND source = 'ai'",
        params![video_id],
    )
    .map_err(|err| err.to_string())?;

    for (index, suggestion) in suggestions.iter().enumerate() {
        let mut segments = suggestion.segments.clone();
        segments.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

        let lesson_start = segments
            .iter()
            .map(|(start, _)| *start)
            .fold(f64::INFINITY, f64::min);
        let lesson_end = segments
            .iter()
            .map(|(_, end)| *end)
            .fold(f64::NEG_INFINITY, f64::max);

        let id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO lessons (id, video_id, title, summary, start, end, sort_order, confidence, kind, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'ai')",
            params![
                id,
                video_id,
                suggestion.title,
                suggestion.summary,
                lesson_start,
                lesson_end,
                index as i64,
                suggestion.confidence,
                suggestion.kind,
            ],
        )
        .map_err(|err| err.to_string())?;

        for (segment_index, (start, end)) in segments.iter().enumerate() {
            let segment_id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO lesson_segments (id, lesson_id, start, end, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![segment_id, id, start, end, segment_index as i64],
            )
            .map_err(|err| err.to_string())?;
        }
    }

    Ok(())
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
    app: AppHandle,
    conn: tauri::State<'_, DbConnection>,
    video_id: String,
    attempt: u32,
) -> Result<Vec<LessonRow>, String> {
    progress::emit(&app, &video_id, Stage::Analyzing, None, None, attempt);

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

    let suggestions = analyze_transcript(&segments, &api_key, instructions.as_deref()).await?;

    // Trim lesson segment boundaries against dead air before persisting —
    // gaps are computed from the same kept transcript segments already sent
    // to GPT-5.5 above, so trimming stays self-consistent with what the
    // model saw and what `parse_lesson_suggestions` validated segments
    // against (`docs/ux-overhaul-plan.md`, M6).
    let gaps = silence_gaps(&segments, SILENCE_GAP_THRESHOLD_SECS);
    let mut suggestions = trim_silence_from_suggestions(suggestions, &gaps);
    // `trim_silence_from_suggestions` (like `parse_lesson_suggestions` before
    // it) guarantees every returned suggestion has at least one segment, so
    // `min_start` below always has a value.
    suggestions.sort_by(|a, b| {
        let min_start = |suggestion: &LessonSuggestion| {
            suggestion
                .segments
                .iter()
                .map(|(start, _)| *start)
                .fold(f64::INFINITY, f64::min)
        };
        min_start(a)
            .partial_cmp(&min_start(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    {
        let mut guard = conn.0.lock().map_err(|err| err.to_string())?;
        // One transaction so re-running analysis on the same video replaces
        // its AI-sourced lessons cleanly instead of accumulating duplicates
        // — only `source = 'ai'` rows are cleared, so any future manually
        // created/edited lessons (source != 'ai') are left untouched.
        let tx = guard.transaction().map_err(|err| err.to_string())?;
        replace_ai_lessons_tx(&tx, &video_id, &suggestions)?;
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

#[cfg(test)]
mod replace_ai_lessons_tx_tests {
    use super::{replace_ai_lessons_tx, LessonSuggestion};
    use rusqlite::{params, Connection};

    /// In-memory DB with migrations applied plus one project/video — mirrors
    /// `db::lesson_editing_tests::seeded_conn`'s setup style.
    fn seeded_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::migrate(&conn).unwrap();

        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Test', 't', 't')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO videos (id, project_id, file_path, created_at, updated_at)
             VALUES ('v1', 'p1', '/tmp/video.mp4', 't', 't')",
            [],
        )
        .unwrap();

        conn
    }

    fn suggestion(start: f64, end: f64, title: &str) -> LessonSuggestion {
        multi_segment_suggestion(vec![(start, end)], title)
    }

    fn multi_segment_suggestion(segments: Vec<(f64, f64)>, title: &str) -> LessonSuggestion {
        LessonSuggestion {
            segments,
            title: title.to_string(),
            summary: String::new(),
            kind: "lesson".to_string(),
            confidence: 0.8,
        }
    }

    #[test]
    fn each_inserted_lesson_gets_exactly_one_matching_segment_row() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        let suggestions = vec![
            suggestion(0.0, 10.0, "First"),
            suggestion(20.0, 30.0, "Second"),
        ];
        replace_ai_lessons_tx(&tx, "v1", &suggestions).unwrap();
        tx.commit().unwrap();

        let lesson_ids: Vec<String> = conn
            .prepare("SELECT id FROM lessons WHERE video_id = 'v1' ORDER BY sort_order")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(lesson_ids.len(), 2, "one lesson row per suggestion");

        for lesson_id in &lesson_ids {
            let segments: Vec<(f64, f64, i64)> = conn
                .prepare(
                    "SELECT start, end, sort_order FROM lesson_segments WHERE lesson_id = ?1",
                )
                .unwrap()
                .query_map(params![lesson_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(
                segments.len(),
                1,
                "lesson {lesson_id} should have exactly one segment"
            );

            let (segment_start, segment_end, sort_order) = segments[0];
            let (lesson_start, lesson_end): (f64, f64) = conn
                .query_row(
                    "SELECT start, end FROM lessons WHERE id = ?1",
                    params![lesson_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(segment_start, lesson_start);
            assert_eq!(segment_end, lesson_end);
            assert_eq!(sort_order, 0);
        }
    }

    #[test]
    fn rerunning_replaces_ai_lessons_and_their_segments_without_accumulating() {
        let mut conn = seeded_conn();

        {
            let tx = conn.transaction().unwrap();
            replace_ai_lessons_tx(&tx, "v1", &[suggestion(0.0, 10.0, "First")]).unwrap();
            tx.commit().unwrap();
        }
        {
            let tx = conn.transaction().unwrap();
            replace_ai_lessons_tx(&tx, "v1", &[suggestion(5.0, 15.0, "Replaced")]).unwrap();
            tx.commit().unwrap();
        }

        let lesson_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM lessons WHERE video_id = 'v1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(lesson_count, 1, "re-analysis should replace, not accumulate");

        let segment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM lesson_segments WHERE lesson_id IN (SELECT id FROM lessons WHERE video_id = 'v1')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(segment_count, 1, "old segment should be gone via cascade, not left orphaned");
    }

    #[test]
    fn multi_segment_suggestion_inserts_all_segments_sorted_with_correct_bounds() {
        let mut conn = seeded_conn();
        let tx = conn.transaction().unwrap();

        // Segments given out of start-order on purpose, to confirm
        // `replace_ai_lessons_tx` sorts them before assigning `sort_order`.
        let suggestions = vec![multi_segment_suggestion(
            vec![(50.0, 60.0), (0.0, 10.0), (20.0, 25.0)],
            "Split lesson",
        )];
        replace_ai_lessons_tx(&tx, "v1", &suggestions).unwrap();
        tx.commit().unwrap();

        let lesson_id: String = conn
            .query_row(
                "SELECT id FROM lessons WHERE video_id = 'v1'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        let segments: Vec<(f64, f64, i64)> = conn
            .prepare(
                "SELECT start, end, sort_order FROM lesson_segments WHERE lesson_id = ?1 ORDER BY sort_order",
            )
            .unwrap()
            .query_map(params![lesson_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(
            segments,
            vec![(0.0, 10.0, 0), (20.0, 25.0, 1), (50.0, 60.0, 2)],
            "segments should be sorted by start with sort_order assigned in that order"
        );

        let (lesson_start, lesson_end): (f64, f64) = conn
            .query_row(
                "SELECT start, end FROM lessons WHERE id = ?1",
                params![lesson_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(lesson_start, 0.0, "lesson start should be the min segment start");
        assert_eq!(lesson_end, 60.0, "lesson end should be the max segment end");
    }
}

// ---------------------------------------------------------------------
// Per-lesson AI segment edit (`docs/lesson-ai-edit-plan.md`) — a free-text
// prompt box on `LessonSegmentsView.tsx` that proposes a revised segment
// list for one already-created lesson (never other lessons, never
// `transcript_segments.keep`). Same shape as `analyze_video` above (text-
// only GPT-5.5 chat completion, `{"segments": [...]}` reply), but scoped to
// one lesson and gated behind an explicit review step: `preview_lesson_
// segment_edit` never writes to the database, and `apply_lesson_segment_
// edit` never calls OpenAI — the frontend's old-vs-new popup is the seam
// between them.
// ---------------------------------------------------------------------

/// Scans `text` (the raw instruction string — unmodified before or after
/// this call, still what's actually sent to the model) for `mm:ss` /
/// `h:mm:ss` / `hh:mm:ss:fff`-shaped substrings and converts each to total
/// seconds. Deliberately loose matching (no required zero-padding, no
/// required milliseconds) — unlike `LessonSegmentsView.tsx`'s own strict
/// `hh:mm:ss:fff`-only `parseTimestamp`, a user typing into a free-text
/// prompt box won't reliably zero-pad or include a milliseconds component.
/// Doesn't validate or clamp anything against a lesson/video's real bounds
/// — purely "what timestamps, if any, did the user type," used by
/// `preview_lesson_segment_edit` to widen the transcript context window it
/// loads. No timestamps found is a valid, empty result, not an error.
fn extract_timestamps_seconds(text: &str) -> Vec<f64> {
    // 2 to 4 colon-separated groups of 1-3 digits: `mm:ss`, `h:mm:ss`, or
    // `hh:mm:ss:fff`. `\b` on both ends keeps this from matching in the
    // middle of a longer digit run (e.g. a 5+ digit id string).
    let pattern = Regex::new(r"\b\d{1,3}(?::\d{1,3}){1,3}\b").expect("static regex is valid");

    pattern
        .find_iter(text)
        .filter_map(|matched| {
            let parts: Vec<f64> = matched
                .as_str()
                .split(':')
                .map(|part| part.parse::<f64>().ok())
                .collect::<Option<Vec<f64>>>()?;

            match parts.as_slice() {
                [minutes, seconds] => Some(minutes * 60.0 + seconds),
                [hours, minutes, seconds] => Some(hours * 3600.0 + minutes * 60.0 + seconds),
                [hours, minutes, seconds, millis] => {
                    Some(hours * 3600.0 + minutes * 60.0 + seconds + millis / 1000.0)
                }
                _ => None,
            }
        })
        .collect()
}

const LESSON_EDIT_SYSTEM_PROMPT: &str = "You are an assistant that revises a single lesson's \
segment list for a video editing tool, per a user's free-text instruction. You are given: the \
lesson's current segment ranges (start/end, in seconds, in order), a window of the underlying \
video's transcript as timestamped segments (also in seconds, via `[start-end]` prefixes, on the \
same timeline as the lesson's segment ranges), and the user's instruction. Respond with a single \
JSON object of the exact shape {\"segments\": [{\"start\": number, \"end\": number}, ...]} and \
nothing else — no prose, no markdown fences. Revise the lesson's segments per the instruction: \
you may split a segment into more ranges than were given, merge or remove segments (returning \
fewer ranges, or none at all if the instruction amounts to removing everything from this \
lesson), or trim a segment's start/end. Every returned range must come from within the \
transcript context given, with `start` < `end`. The instruction may contain literal timestamps \
(for example \"cut from 2:15 to 3:40\", \"split at 12:03\", \"trim everything after 4:15\") on \
this same source video timeline — the same seconds-based timeline every transcript line's \
`[start-end]` prefix, and every given segment range, already use. Treat any such timestamp as a \
precise, authoritative boundary: convert it to seconds and use it directly, rather than \
approximating it from nearby transcript wording. Use the transcript content/wording only for \
whatever the instruction doesn't pin to a specific time.";

/// Parses a chat-completion message's JSON `content` string (expected
/// shape: `{"segments": [...]}`, per `LESSON_EDIT_SYSTEM_PROMPT`) into a
/// validated `Vec<(f64, f64)>` via the shared `parse_segment_array`. Split
/// out from `edit_lesson_segments_via_ai` so this parsing logic — the part
/// with no network dependency — can be exercised directly, mirroring
/// `parse_lesson_suggestions`. A well-formed but empty `segments` array is
/// `Ok(vec![])`, not an error — an empty proposal (e.g. "delete this whole
/// lesson") is valid at this stage; nothing is written to the database
/// until the user reviews and applies it (see `apply_lesson_segment_edit`).
fn parse_edit_segments(
    content: &str,
    range_start: f64,
    range_end: f64,
) -> Result<Vec<(f64, f64)>, String> {
    let payload: serde_json::Value = serde_json::from_str(content)
        .map_err(|err| format!("could not parse GPT-5.5 JSON payload: {err}"))?;

    let segments_value = payload
        .get("segments")
        .ok_or_else(|| "GPT-5.5 JSON payload is missing a \"segments\" array".to_string())?;

    Ok(parse_segment_array(segments_value, range_start, range_end))
}

/// Sends `baseline_segments` (the lesson's current ranges, or — for a
/// refinement — the popup's not-yet-applied proposal), a windowed slice of
/// the underlying video's transcript, and the user's free-text
/// `instruction` to GPT-5.5 chat completions, and parses the response into
/// a revised `Vec<(f64, f64)>` of segment ranges. Only transcript **text**
/// and `instruction` (also text) are ever sent — never audio, never video,
/// per `coursecut-privacy-invariants`. An empty result is a valid proposal
/// (see `parse_edit_segments`); this function never touches the database.
pub async fn edit_lesson_segments_via_ai(
    baseline_segments: &[(f64, f64)],
    transcript_segments: &[TranscriptSegmentRow],
    instruction: &str,
    api_key: &str,
) -> Result<Vec<(f64, f64)>, String> {
    let baseline_text = if baseline_segments.is_empty() {
        "(none — this lesson currently has no segments)".to_string()
    } else {
        baseline_segments
            .iter()
            .map(|(start, end)| format!("[{start:.2}-{end:.2}]"))
            .collect::<Vec<_>>()
            .join(", ")
    };

    let transcript_text = transcript_segments
        .iter()
        .map(|segment| format!("[{:.2}-{:.2}] {}", segment.start, segment.end, segment.text))
        .collect::<Vec<_>>()
        .join("\n");

    let user_prompt = format!(
        "Current lesson segments (seconds): {baseline_text}\n\n\
         Transcript context (timestamps in seconds):\n\n{transcript_text}\n\n\
         Instruction: {instruction}"
    );

    let request_body = serde_json::json!({
        "model": "gpt-5.5",
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": LESSON_EDIT_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    });

    // Same shape as `analyze_transcript`'s request: one text-only
    // completion, but a full-window transcript plus the model's own
    // generation time can still take a while.
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

    // Validate returned ranges against the transcript context's own span —
    // mirrors `analyze_transcript`'s "must be within the transcript given"
    // rule. If the window came back with no kept transcript at all (a rare
    // edge case — e.g. a lesson sitting in a stretch of the video that's
    // all `keep = 0`), there's nothing to bound against; skip the range
    // check entirely rather than rejecting every proposed segment against
    // an `(Infinity, -Infinity)` empty span.
    let (range_start, range_end) = if transcript_segments.is_empty() {
        (f64::NEG_INFINITY, f64::INFINITY)
    } else {
        let start = transcript_segments
            .iter()
            .map(|segment| segment.start)
            .fold(f64::INFINITY, f64::min);
        let end = transcript_segments
            .iter()
            .map(|segment| segment.end)
            .fold(f64::NEG_INFINITY, f64::max);
        (start, end)
    };

    parse_edit_segments(&content, range_start, range_end)
}

/// Padding (seconds, each side) around a lesson's own current span used to
/// size the transcript context sent to `edit_lesson_segments_via_ai` —
/// enough surrounding text for the model to see context around a lesson's
/// current edges ("remove the tangent right before the demo starts")
/// without shipping the whole video's transcript for a scoped edit. Also
/// the per-side pad folded in around any timestamp the instruction pins to
/// a specific point (see `preview_lesson_segment_edit`).
const LESSON_EDIT_CONTEXT_PAD_SECS: f64 = 60.0;

/// Proposes a revised segment list for `lesson_id` per `instruction`,
/// without writing anything to the database — see `apply_lesson_segment_
/// edit` for the write side of this two-step, review-gated flow
/// (`docs/lesson-ai-edit-plan.md`).
///
/// `baseline` is `None` for the main prompt box's initial submission (this
/// loads the lesson's current `lesson_segments` from the DB as the
/// baseline) or `Some` for a refinement typed inside the review popup —
/// exactly the *previous, not-yet-applied* proposal the popup was showing,
/// not the DB rows, since nothing has been written yet. Either way, the
/// transcript context window is always sized from the lesson's own real,
/// current `lesson_segments` (never the resolved baseline) — a
/// refinement's context window doesn't drift just because the hypothetical
/// proposal being refined has moved away from the lesson's real footprint.
///
/// Only transcript **text** and `instruction` (also text) ever reach
/// OpenAI here — never audio, never video, never any other SQLite content
/// beyond what locates the right rows. See `coursecut-privacy-invariants`.
#[tauri::command(async)]
pub async fn preview_lesson_segment_edit(
    _app: AppHandle,
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
    instruction: String,
    baseline: Option<Vec<db::SegmentRange>>,
) -> Result<Vec<db::SegmentRange>, String> {
    if instruction.trim().is_empty() {
        return Err("Describe the change you want before previewing it.".to_string());
    }

    // `db::SegmentRange` is this command's IPC boundary shape (`{start,
    // end}`, matching the frontend's `LessonSegmentRange`); everything
    // below works in the plain `(f64, f64)` tuples the rest of this
    // module's segment-editing/validation logic already uses.
    let baseline: Option<Vec<(f64, f64)>> = baseline
        .map(|ranges| ranges.into_iter().map(|range| (range.start, range.end)).collect());

    let (video_id, own_segments) = {
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        let lesson = db::query_lesson(&guard, &lesson_id)?;

        let mut stmt = guard
            .prepare(
                "SELECT start, end FROM lesson_segments WHERE lesson_id = ?1
                 ORDER BY sort_order, id",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![lesson_id], |row| {
                Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?))
            })
            .map_err(|err| err.to_string())?;
        let own_segments: Vec<(f64, f64)> =
            rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())?;

        (lesson.video_id, own_segments)
    };

    let baseline_segments = baseline.unwrap_or_else(|| own_segments.clone());

    // Window base: the lesson's own real footprint (never the resolved
    // baseline — see docs above), padded on each side. A lesson always has
    // at least one segment while it exists (deleting the last one deletes
    // the lesson itself, see `db::delete_lesson_segment_tx`), so the
    // `lesson.start`/`lesson.end` fallback below is defense-in-depth, not
    // an expected path.
    let (mut window_start, mut window_end) = if own_segments.is_empty() {
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        let lesson = db::query_lesson(&guard, &lesson_id)?;
        (lesson.start, lesson.end)
    } else {
        let start = own_segments
            .iter()
            .map(|(start, _)| *start)
            .fold(f64::INFINITY, f64::min);
        let end = own_segments
            .iter()
            .map(|(_, end)| *end)
            .fold(f64::NEG_INFINITY, f64::max);
        (start, end)
    };
    window_start -= LESSON_EDIT_CONTEXT_PAD_SECS;
    window_end += LESSON_EDIT_CONTEXT_PAD_SECS;

    // Widen further to cover every timestamp the instruction pins to a
    // specific point, each ± the same pad — so a timestamp reaching outside
    // the lesson's own current span still has real transcript text behind
    // it, rather than the model being asked about a time range it was
    // never shown anything for.
    for timestamp in extract_timestamps_seconds(&instruction) {
        window_start = window_start.min(timestamp - LESSON_EDIT_CONTEXT_PAD_SECS);
        window_end = window_end.max(timestamp + LESSON_EDIT_CONTEXT_PAD_SECS);
    }

    let transcript_segments: Vec<TranscriptSegmentRow> = {
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        let mut stmt = guard
            .prepare(
                "SELECT id, video_id, start, end, text, keep FROM transcript_segments
                 WHERE video_id = ?1 AND keep = 1 AND end >= ?2 AND start <= ?3
                 ORDER BY start, id",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![video_id, window_start, window_end], |row| {
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
        rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())?
    };

    let api_key = settings::read_stored_key()?
        .ok_or_else(|| "No OpenAI API key saved — add one in Settings".to_string())?;

    let result =
        edit_lesson_segments_via_ai(&baseline_segments, &transcript_segments, &instruction, &api_key)
            .await?;

    Ok(result
        .into_iter()
        .map(|(start, end)| db::SegmentRange { start, end })
        .collect())
}

/// Commits `segments` — exactly the array `preview_lesson_segment_edit`
/// returned and the frontend's review popup displayed — as `lesson_id`'s
/// new `lesson_segments`, replacing whatever was there before. Synchronous,
/// no network call: `preview_lesson_segment_edit` is the only place this
/// feature's AI output exists before the user has seen and accepted it (see
/// its own docs), so by the time this runs there's nothing left to decide,
/// just a transaction to commit. Re-validates `start < end` per range
/// defensively, even though the frontend shouldn't be able to send anything
/// `preview` didn't already produce.
///
/// Rejects an empty `segments` array outright, without touching the
/// database — this path never deletes a lesson as a side effect of an AI
/// proposal (even one the user has reviewed and confirmed); whole-lesson
/// deletion already has its own explicit, confirmed affordance elsewhere on
/// this page. Contrast with `db::delete_lesson_segment`'s "last segment
/// gone deletes the lesson" rule, which fires from an explicit, unambiguous
/// per-segment delete click, not a free-text instruction's AI-authored
/// interpretation.
#[tauri::command]
pub fn apply_lesson_segment_edit(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
    segments: Vec<db::SegmentRange>,
) -> Result<Vec<LessonSegmentRow>, String> {
    if segments.is_empty() {
        return Err(
            "That would remove every segment in this lesson — to delete the whole lesson, use \
             Delete Lesson instead."
                .to_string(),
        );
    }
    // Same IPC boundary shape (`db::SegmentRange`) as `preview_lesson_segment_edit`'s baseline/
    // return value — converted to plain tuples here since the rest of this function's
    // validate/sort/insert logic already works in that shape.
    let segments: Vec<(f64, f64)> = segments
        .into_iter()
        .map(|range| (range.start, range.end))
        .collect();
    for (start, end) in &segments {
        if !(start < end) {
            return Err(format!(
                "invalid segment range: start ({start}) must be before end ({end})"
            ));
        }
    }

    let mut sorted_segments = segments;
    sorted_segments.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    {
        let mut guard = conn.0.lock().map_err(|err| err.to_string())?;
        let tx = guard.transaction().map_err(|err| err.to_string())?;

        tx.execute(
            "DELETE FROM lesson_segments WHERE lesson_id = ?1",
            params![lesson_id],
        )
        .map_err(|err| err.to_string())?;

        for (index, (start, end)) in sorted_segments.iter().enumerate() {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO lesson_segments (id, lesson_id, start, end, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, lesson_id, start, end, index as i64],
            )
            .map_err(|err| err.to_string())?;
        }

        db::recompute_lesson_bounds_tx(&tx, &lesson_id)?;
        tx.commit().map_err(|err| err.to_string())?;
    }

    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    let mut stmt = guard
        .prepare(
            "SELECT id, lesson_id, start, end, sort_order FROM lesson_segments
             WHERE lesson_id = ?1 ORDER BY sort_order, id",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![lesson_id], |row| {
            Ok(LessonSegmentRow {
                id: row.get("id")?,
                lesson_id: row.get("lesson_id")?,
                start: row.get("start")?,
                end: row.get("end")?,
                sort_order: row.get("sort_order")?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

#[cfg(test)]
mod extract_timestamps_tests {
    use super::extract_timestamps_seconds;

    #[test]
    fn plain_m_ss() {
        assert_eq!(extract_timestamps_seconds("split at 12:30"), vec![750.0]);
    }

    #[test]
    fn h_mm_ss() {
        assert_eq!(
            extract_timestamps_seconds("cut everything after 1:02:03"),
            vec![3723.0]
        );
    }

    #[test]
    fn hh_mm_ss_fff() {
        assert_eq!(extract_timestamps_seconds("trim to 00:01:02:500"), vec![62.5]);
    }

    #[test]
    fn multiple_timestamps_in_one_string() {
        assert_eq!(
            extract_timestamps_seconds("cut from 2:15 to 3:40"),
            vec![135.0, 220.0]
        );
    }

    #[test]
    fn no_timestamps_is_an_empty_result_not_an_error() {
        assert!(extract_timestamps_seconds("cut the part about pricing").is_empty());
    }
}

#[cfg(test)]
mod parse_edit_segments_tests {
    use super::parse_edit_segments;

    #[test]
    fn parses_valid_segments_within_range() {
        let content = serde_json::json!({
            "segments": [{"start": 10.0, "end": 20.0}, {"start": 30.0, "end": 40.0}]
        })
        .to_string();

        let segments = parse_edit_segments(&content, 0.0, 100.0).unwrap();
        assert_eq!(segments, vec![(10.0, 20.0), (30.0, 40.0)]);
    }

    #[test]
    fn empty_segments_array_is_ok_with_no_segments() {
        let content = serde_json::json!({"segments": []}).to_string();
        let segments = parse_edit_segments(&content, 0.0, 100.0).unwrap();
        assert!(segments.is_empty());
    }

    #[test]
    fn drops_out_of_range_or_backwards_segments_without_failing() {
        let content = serde_json::json!({
            "segments": [
                {"start": 10.0, "end": 20.0},
                {"start": 20.0, "end": 15.0},
                {"start": 500.0, "end": 600.0},
            ]
        })
        .to_string();

        let segments = parse_edit_segments(&content, 0.0, 100.0).unwrap();
        assert_eq!(segments, vec![(10.0, 20.0)]);
    }

    #[test]
    fn missing_segments_key_is_an_error() {
        let content = serde_json::json!({"not_segments": []}).to_string();
        assert!(parse_edit_segments(&content, 0.0, 100.0).is_err());
    }

    #[test]
    fn non_json_content_is_an_error_not_a_panic() {
        assert!(parse_edit_segments("not json", 0.0, 100.0).is_err());
    }
}
