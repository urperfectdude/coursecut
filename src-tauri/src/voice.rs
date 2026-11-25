//! AI studio voice (HCM feature 4, `docs/hcm-improvements-plan.md` §4):
//! reads a lesson's corrected script aloud with an OpenAI stock voice and
//! lays the clips on the lesson's own timeline as one voice track.
//!
//! Privacy (`coursecut-privacy-invariants`): this is the one place that
//! sends transcript text to OpenAI's speech endpoint. Only the text of each
//! line, the voice name and the user's optional speaking instructions
//! leave the device, and only after the user has turned AI voice on in
//! Settings (`ai_voice_enabled`, checked here on every call, not just in the
//! UI). No audio or video is uploaded. Text is never logged.
//!
//! Clips are cached by a hash of everything that shapes them (model, voice,
//! instructions, text) in `$APPCACHE/tts`, so regenerating after an edit
//! only pays for the lines that changed. The track is rebuilt locally each
//! time from the cached clips.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;

use crate::db::DbConnection;

const TTS_MODEL: &str = "gpt-4o-mini-tts";
/// OpenAI's `pcm` output: raw signed 16-bit little-endian mono at 24 kHz.
const SAMPLE_RATE: u32 = 24_000;
/// The speech endpoint's input limit is 4096 characters.
const MAX_LINE_CHARS: usize = 4000;
/// Most a clip is sped up to fit its slot. Past this the voice sounds
/// rushed, so the clip runs long and later lines start late instead.
pub(crate) const MAX_SPEEDUP: f64 = 1.25;
/// A line that starts later than this behind its words is out of sync.
const LATE_TOLERANCE_S: f64 = 0.3;
/// Lines sent to the speech endpoint at once.
const PARALLEL_REQUESTS: usize = 4;

pub(crate) const VOICES: [&str; 11] = [
    "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse",
];
const DEFAULT_VOICE: &str = "coral";

const ENABLED_KEY: &str = "ai_voice_enabled";
const VOICE_KEY: &str = "ai_voice_name";
const INSTRUCTIONS_KEY: &str = "ai_voice_instructions";
const MAX_INSTRUCTIONS_CHARS: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VoiceSettings {
    /// The privacy opt-in: false until the user turns AI voice on.
    pub enabled: bool,
    pub voice: String,
    /// Optional speaking style ("calm, friendly corporate trainer").
    pub instructions: String,
}

fn read_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM app_settings WHERE key = ?1", params![key], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .map_err(|err| err.to_string())
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn read_voice_settings(conn: &Connection) -> Result<VoiceSettings, String> {
    let voice = read_setting(conn, VOICE_KEY)?
        .filter(|voice| VOICES.contains(&voice.as_str()))
        .unwrap_or_else(|| DEFAULT_VOICE.to_string());
    Ok(VoiceSettings {
        enabled: read_setting(conn, ENABLED_KEY)?.as_deref() == Some("1"),
        voice,
        instructions: read_setting(conn, INSTRUCTIONS_KEY)?.unwrap_or_default(),
    })
}

pub(crate) fn write_voice_settings(conn: &Connection, settings: &VoiceSettings) -> Result<VoiceSettings, String> {
    if !VOICES.contains(&settings.voice.as_str()) {
        return Err(format!("unknown voice {:?}", settings.voice));
    }
    let instructions = settings.instructions.trim();
    if instructions.chars().count() > MAX_INSTRUCTIONS_CHARS {
        return Err(format!("Speaking style can be at most {MAX_INSTRUCTIONS_CHARS} characters."));
    }
    write_setting(conn, ENABLED_KEY, if settings.enabled { "1" } else { "0" })?;
    write_setting(conn, VOICE_KEY, &settings.voice)?;
    write_setting(conn, INSTRUCTIONS_KEY, instructions)?;
    read_voice_settings(conn)
}

#[tauri::command]
pub fn get_voice_settings(conn: tauri::State<'_, DbConnection>) -> Result<VoiceSettings, String> {
    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    read_voice_settings(&guard)
}

#[tauri::command]
pub fn save_voice_settings(
    conn: tauri::State<'_, DbConnection>,
    settings: VoiceSettings,
) -> Result<VoiceSettings, String> {
    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    write_voice_settings(&guard, &settings)
}

/// One line of the script, placed on the lesson's output timeline (0 =
/// the lesson's first kept frame; inserted intros not counted). Built by
/// the frontend's `buildVoiceLines` from the lesson's segments and words.
#[derive(Debug, Clone, Deserialize)]
pub struct VoiceLineInput {
    pub text: String,
    /// Where the line's first word is said in the lesson.
    pub start: f64,
    /// Where the next line starts (or the lesson ends): the line's slot.
    pub end: f64,
}

/// How a line was placed in the track.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VoiceLinePlacement {
    /// Where the clip actually starts (later than asked if the line before
    /// ran long).
    pub start: f64,
    /// The clip's length after any speed-up.
    pub duration: f64,
    /// Speed-up applied (1.0 = none).
    pub rate: f64,
    /// Seconds behind its words: > 0.3 s reads as out of sync.
    pub late_by: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceTrack {
    /// WAV file in the app cache, for the preview player.
    pub path: String,
    pub duration: f64,
    pub lines: Vec<VoiceLinePlacement>,
    /// How many lines had to be generated (the rest came from the cache).
    pub generated: usize,
    /// Lines starting more than 0.3 s late: their text is too long for the
    /// time the speaker took. Shortening the text fixes them.
    pub late_lines: usize,
}

#[derive(Debug, Clone, Serialize)]
struct VoiceProgress {
    lesson_id: String,
    done: usize,
    total: usize,
}

fn clip_key(voice: &str, instructions: &str, text: &str) -> String {
    let mut hasher = Sha256::new();
    for part in [TTS_MODEL, voice, instructions, text] {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn cache_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("could not resolve app cache dir: {err}"))?
        .join(sub);
    std::fs::create_dir_all(&dir).map_err(|err| format!("could not create {sub} cache dir: {err}"))?;
    Ok(dir)
}

/// Writes atomically (temp file then rename), so a cancelled run never
/// leaves a half clip that later reads as cached.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, bytes).map_err(|err| format!("could not write voice clip: {err}"))?;
    std::fs::rename(&tmp, path).map_err(|err| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not save voice clip: {err}")
    })
}

/// Sends one line's text to OpenAI's speech endpoint and returns raw PCM.
/// Network: the text, voice and instructions only (see module doc).
async fn synthesize(
    client: &reqwest::Client,
    api_key: &str,
    voice: &str,
    instructions: &str,
    text: &str,
) -> Result<Vec<u8>, String> {
    let mut body = serde_json::json!({
        "model": TTS_MODEL,
        "voice": voice,
        "input": text,
        "response_format": "pcm",
    });
    if !instructions.is_empty() {
        body["instructions"] = serde_json::Value::String(instructions.to_string());
    }
    let response = client
        .post("https://api.openai.com/v1/audio/speech")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("OpenAI speech request failed: {err}"))?;
    let status = response.status();
    if !status.is_success() {
        // The error body is OpenAI's JSON message, never our text.
        let message = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI speech request failed ({status}): {message}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("could not read OpenAI speech response: {err}"))?;
    if bytes.len() < 2 {
        return Err("OpenAI returned no audio for a line".to_string());
    }
    Ok(bytes.to_vec())
}

fn pcm_to_samples(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect()
}

/// Speeds a clip up by `rate` with ffmpeg's pitch-keeping `atempo`, cached
/// next to the clip.
async fn speed_up(app: &AppHandle, clip: &Path, rate: f64) -> Result<PathBuf, String> {
    let out = clip.with_extension(format!("x{:.3}.pcm", rate));
    if out.exists() {
        return Ok(out);
    }
    let tmp = clip.with_extension(format!("tmp-{}.pcm", uuid::Uuid::new_v4()));
    let rate_arg = format!("atempo={rate:.3}");
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|err| format!("could not resolve ffmpeg sidecar: {err}"))?
        .args([
            "-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i",
            &clip.to_string_lossy(),
            "-filter:a", &rate_arg,
            "-f", "s16le", "-ar", "24000", "-ac", "1",
            &tmp.to_string_lossy(),
        ])
        .output()
        .await
        .map_err(|err| format!("could not run ffmpeg: {err}"))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&tmp);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.chars().rev().take(800).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("ffmpeg could not speed up a voice clip: {tail}"));
    }
    std::fs::rename(&tmp, &out).map_err(|err| format!("could not save voice clip: {err}"))?;
    Ok(out)
}

/// Where each clip goes, given the clips' natural lengths. Pure, so it's
/// tested on its own. A clip longer than its slot is sped up by at most
/// `MAX_SPEEDUP`; if it still doesn't fit it runs over, and the next line
/// starts when it ends (never overlapping). Shorter clips aren't slowed:
/// the rest of the slot is silence, like a speaker's pause.
pub(crate) fn place_lines(lines: &[VoiceLineInput], natural: &[f64]) -> Vec<VoiceLinePlacement> {
    let mut cursor = 0.0_f64;
    let mut out = Vec::with_capacity(lines.len());
    for (line, &length) in lines.iter().zip(natural) {
        let start = line.start.max(cursor);
        let available = (line.end - start).max(0.01);
        let rate = if length > available {
            (length / available).min(MAX_SPEEDUP)
        } else {
            1.0
        };
        // Rounded the same way the speed-up file name is, so the placement
        // and the audio agree.
        let rate = (rate * 1000.0).round() / 1000.0;
        let duration = length / rate;
        out.push(VoiceLinePlacement {
            start,
            duration,
            rate,
            late_by: start - line.start,
        });
        cursor = start + duration;
    }
    out
}

fn validate_lines(lines: &[VoiceLineInput], lesson_length: f64) -> Result<(), String> {
    if lines.is_empty() {
        return Err("This lesson has no words to read.".to_string());
    }
    if !lesson_length.is_finite() || lesson_length <= 0.0 || lesson_length > 6.0 * 3600.0 {
        return Err("invalid lesson length".to_string());
    }
    let mut previous = 0.0;
    for line in lines {
        if !line.start.is_finite() || !line.end.is_finite() || line.start < previous || line.end < line.start {
            return Err("voice lines must be in order on the lesson's timeline".to_string());
        }
        if line.text.trim().is_empty() {
            return Err("a voice line has no text".to_string());
        }
        if line.text.chars().count() > MAX_LINE_CHARS {
            return Err(format!(
                "One sentence is over {MAX_LINE_CHARS} characters; split it in the Script tab first."
            ));
        }
        previous = line.start;
    }
    Ok(())
}

/// Generates (or reuses) a clip per line and builds the lesson's voice
/// track: a mono 24 kHz WAV as long as the lesson, saved in the app cache
/// for the preview player. Emits `"voice-progress"` while generating.
///
/// The finished track is saved as the lesson's voice (`lesson_voice`), with
/// the editor's `signature` and a hash of the script as it is now, so the
/// editor finds it again and exports can use it.
#[tauri::command]
pub async fn generate_lesson_voice(
    app: AppHandle,
    lesson_id: String,
    lines: Vec<VoiceLineInput>,
    lesson_length: f64,
    signature: String,
) -> Result<VoiceTrack, String> {
    validate_lines(&lines, lesson_length)?;
    // Hashed before generating: the lines were built from this state.
    let (settings, hash) = {
        let conn = app.state::<DbConnection>();
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        (read_voice_settings(&guard)?, script_hash(&guard, &lesson_id)?)
    };
    // The privacy opt-in, enforced here and not only in the UI.
    if !settings.enabled {
        return Err("AI voice is off. Turn it on in Settings first.".to_string());
    }

    let clips_dir = cache_dir(&app, "tts")?;
    let keys: Vec<String> = lines
        .iter()
        .map(|line| clip_key(&settings.voice, &settings.instructions, line.text.trim()))
        .collect();
    let clip_paths: Vec<PathBuf> = keys.iter().map(|key| clips_dir.join(format!("{key}.pcm"))).collect();

    // Lines whose clip isn't cached yet (each distinct text once).
    let mut missing: Vec<usize> = Vec::new();
    for (i, path) in clip_paths.iter().enumerate() {
        if !path.exists() && !missing.iter().any(|&j| keys[j] == keys[i]) {
            missing.push(i);
        }
    }
    let generated = missing.len();
    let emit = |done: usize| {
        let _ = app.emit(
            "voice-progress",
            VoiceProgress {
                lesson_id: lesson_id.clone(),
                done,
                total: generated,
            },
        );
    };
    if !missing.is_empty() {
        let api_key = crate::settings::read_stored_key()?
            .ok_or_else(|| "No OpenAI API key saved. Add one in Settings.".to_string())?;
        let client = reqwest::Client::new();
        let semaphore = Arc::new(tokio::sync::Semaphore::new(PARALLEL_REQUESTS));
        let mut tasks = tokio::task::JoinSet::new();
        for &i in &missing {
            let client = client.clone();
            let api_key = api_key.clone();
            let voice = settings.voice.clone();
            let instructions = settings.instructions.clone();
            let text = lines[i].text.trim().to_string();
            let path = clip_paths[i].clone();
            let semaphore = semaphore.clone();
            tasks.spawn(async move {
                let _permit = semaphore.acquire_owned().await.map_err(|err| err.to_string())?;
                let pcm = synthesize(&client, &api_key, &voice, &instructions, &text).await?;
                write_atomic(&path, &pcm)
            });
        }
        let mut done = 0;
        emit(0);
        while let Some(result) = tasks.join_next().await {
            match result.map_err(|err| err.to_string()).and_then(|r| r) {
                Ok(()) => {
                    done += 1;
                    emit(done);
                }
                Err(err) => {
                    tasks.abort_all();
                    return Err(err);
                }
            }
        }
    }

    // Natural clip lengths, then placement.
    let mut clips: Vec<Vec<i16>> = Vec::with_capacity(lines.len());
    for path in &clip_paths {
        let bytes = std::fs::read(path).map_err(|err| format!("could not read voice clip: {err}"))?;
        clips.push(pcm_to_samples(&bytes));
    }
    let natural: Vec<f64> = clips.iter().map(|c| c.len() as f64 / SAMPLE_RATE as f64).collect();
    let placements = place_lines(&lines, &natural);

    for (i, placement) in placements.iter().enumerate() {
        if placement.rate > 1.0 {
            let fast = speed_up(&app, &clip_paths[i], placement.rate).await?;
            let bytes = std::fs::read(&fast).map_err(|err| format!("could not read voice clip: {err}"))?;
            clips[i] = pcm_to_samples(&bytes);
        }
    }

    let last_end = placements.last().map(|p| p.start + p.duration).unwrap_or(0.0);
    let duration = lesson_length.max(last_end);
    let mut track = vec![0i16; (duration * SAMPLE_RATE as f64).ceil() as usize];
    for (placement, clip) in placements.iter().zip(&clips) {
        let offset = (placement.start * SAMPLE_RATE as f64).round() as usize;
        for (j, &sample) in clip.iter().enumerate() {
            if let Some(slot) = track.get_mut(offset + j) {
                *slot = sample;
            }
        }
    }

    let format = crate::wav::WavFormat {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
    };
    let wav = crate::wav::build_wav(&format, &track);
    // A fresh name per build, so the player never plays a stale cached copy.
    let tracks_dir = cache_dir(&app, "voice_tracks")?;
    let safe_lesson: String = lesson_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let track_path = tracks_dir.join(format!("{safe_lesson}-{}.wav", uuid::Uuid::new_v4()));
    write_atomic(&track_path, &wav)?;
    // Earlier tracks of this lesson are no longer needed.
    if let Ok(entries) = std::fs::read_dir(&tracks_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            // Finished tracks only: another run's in-flight temp file
            // (`*.tmp-…`) must survive until it's renamed.
            if path != track_path && name.starts_with(&format!("{safe_lesson}-")) && name.ends_with(".wav") {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    let late_lines = placements.iter().filter(|p| p.late_by > LATE_TOLERANCE_S).count();
    let track = VoiceTrack {
        path: track_path.to_string_lossy().to_string(),
        duration,
        lines: placements,
        generated,
        late_lines,
    };
    {
        let conn = app.state::<DbConnection>();
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        save_lesson_voice(&guard, &lesson_id, &signature, &hash, &track)?;
    }
    Ok(track)
}

const IMPROVE_SYSTEM_PROMPT: &str = "You polish one line of a training video's script so it reads \
well aloud in a studio voice. The line was transcribed from a trainer speaking off the cuff. \
Fix grammar, drop filler words, false starts and repetitions, and make the phrasing clear and \
natural. Keep the meaning, the order of ideas, product names, field names, menu paths and \
technical terms exactly. Do not add facts, greetings or new sentences. The new line must not be \
longer than the original (it has to fit the same time slot); shorter is better when nothing is \
lost. The neighbouring lines are context only: never repeat or rewrite them. Reply with JSON: \
{\"text\": \"<the improved line>\"}.";

/// Follows a user-supplied system prompt (Improve all's editable prompt):
/// whatever that prompt says about its output, each call rewrites one
/// line that must fit its slot, and the reply is parsed as JSON.
const IMPROVE_LINE_TASK: &str = "\n\n---\nTASK FOR THIS REQUEST (this overrides any output format \
or multi-segment instructions above): you are given ONE line of the script, with its neighbouring \
lines as context only. Apply the editing rules above to that line alone. The new line must not be \
longer than the original (it has to fit the same time slot); shorter is better when nothing is lost. \
Never repeat or rewrite the neighbouring lines, and add no timestamps, cue numbers or NOTE blocks. \
Reply with JSON only: {\"text\": \"<the improved line>\"}.";

/// The longest user system prompt sent.
const MAX_SYSTEM_PROMPT_CHARS: usize = 10_000;

#[derive(Deserialize)]
struct ImprovedLine {
    text: String,
}

/// Rewrites one script line for clearer delivery with GPT-5.5 and returns
/// the suggestion; nothing is saved (the editor applies it as a text edit
/// if the user accepts). Network: the line's text and its two neighbours'
/// text, only (privacy invariant 3: lesson script text, behind the AI
/// voice opt-in, checked here).
#[tauri::command]
pub async fn improve_voice_line(
    app: AppHandle,
    text: String,
    previous: Option<String>,
    next: Option<String>,
    instructions: Option<String>,
    system_prompt: Option<String>,
) -> Result<String, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("This line has no text.".to_string());
    }
    if text.chars().count() > MAX_LINE_CHARS {
        return Err(format!("This line is over {MAX_LINE_CHARS} characters."));
    }
    let enabled = {
        let conn = app.state::<DbConnection>();
        let guard = conn.0.lock().map_err(|err| err.to_string())?;
        read_voice_settings(&guard)?.enabled
    };
    if !enabled {
        return Err("AI voice is off. Turn it on in Settings first.".to_string());
    }
    let api_key = crate::settings::read_stored_key()?
        .ok_or_else(|| "No OpenAI API key saved. Add one in Settings.".to_string())?;

    let clip = |line: Option<String>| -> String {
        line.map(|l| l.trim().chars().take(600).collect::<String>())
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| "(none)".to_string())
    };
    let mut user_prompt = format!(
        "Previous line (context): {}\nNext line (context): {}\n\nLine to improve ({} characters): {}",
        clip(previous),
        clip(next),
        text.chars().count(),
        text
    );
    // The user's own direction for this rewrite (Improve all's optional
    // prompt). It can't lift the length limit: the line must still fit.
    let instructions: String = instructions.unwrap_or_default().trim().chars().take(1000).collect();
    if !instructions.is_empty() {
        user_prompt.push_str(&format!(
            "\n\nExtra instructions from the user (follow them, but keep the line no longer than the original): {instructions}"
        ));
    }
    let system_prompt: String = system_prompt
        .unwrap_or_default()
        .trim()
        .chars()
        .take(MAX_SYSTEM_PROMPT_CHARS)
        .collect();
    let system = if system_prompt.is_empty() {
        IMPROVE_SYSTEM_PROMPT.to_string()
    } else {
        format!("{system_prompt}{IMPROVE_LINE_TASK}")
    };
    let body = serde_json::json!({
        "model": "gpt-5.5",
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_prompt},
        ],
    });
    let request = reqwest::Client::new()
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(&api_key)
        .json(&body)
        .send();
    let response = match tokio::time::timeout(std::time::Duration::from_secs(90), request).await {
        Ok(Ok(response)) => response,
        Ok(Err(err)) => return Err(format!("GPT-5.5 request failed: {err}")),
        Err(_) => return Err("GPT-5.5 request timed out".to_string()),
    };
    let status = response.status();
    if !status.is_success() {
        let message: String = response.text().await.unwrap_or_default().chars().take(300).collect();
        return Err(format!("GPT-5.5 returned {status}: {message}"));
    }
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|err| format!("could not parse GPT-5.5 response: {err}"))?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "GPT-5.5 response had no message content".to_string())?;
    parse_improved_line(content)
}

fn parse_improved_line(content: &str) -> Result<String, String> {
    let improved: ImprovedLine =
        serde_json::from_str(content).map_err(|_| "GPT-5.5 didn't return a line.".to_string())?;
    let text = improved.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err("GPT-5.5 returned an empty line.".to_string());
    }
    if text.chars().count() > MAX_LINE_CHARS {
        return Err("GPT-5.5 returned a line that's too long.".to_string());
    }
    Ok(text)
}

/// A hash of everything the lesson's voice script is built from: its
/// segments in play order, the words inside them (text fixes included) and
/// the sentences those words belong to (for punctuation). Any edit that
/// could change the script or its timing changes it.
pub(crate) fn script_hash(conn: &Connection, lesson_id: &str) -> Result<String, String> {
    let video_id: String = conn
        .query_row("SELECT video_id FROM lessons WHERE id = ?1", params![lesson_id], |row| row.get(0))
        .map_err(|err| format!("could not find lesson: {err}"))?;
    let mut segments_stmt = conn
        .prepare("SELECT start, end FROM lesson_segments WHERE lesson_id = ?1 ORDER BY sort_order, id")
        .map_err(|err| err.to_string())?;
    let segments: Vec<(f64, f64)> = segments_stmt
        .query_map(params![lesson_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|err| err.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|err| err.to_string())?;
    let mut words_stmt = conn
        .prepare(
            "SELECT idx, text, start, end FROM transcript_words
             WHERE video_id = ?1 AND start >= ?2 AND start < ?3 ORDER BY start, idx",
        )
        .map_err(|err| err.to_string())?;
    let mut sentences_stmt = conn
        .prepare(
            "SELECT text, start, end FROM transcript_segments
             WHERE video_id = ?1 AND end > ?2 AND start < ?3 ORDER BY start",
        )
        .map_err(|err| err.to_string())?;

    let mut hasher = Sha256::new();
    for (start, end) in segments {
        hasher.update(format!("S{start:.3}:{end:.3}\0").as_bytes());
        let rows = words_stmt
            .query_map(params![video_id, start, end], |row| {
                Ok(format!(
                    "W{}:{}:{:.3}:{:.3}\0",
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?
                ))
            })
            .map_err(|err| err.to_string())?;
        for row in rows {
            hasher.update(row.map_err(|err| err.to_string())?.as_bytes());
        }
        let rows = sentences_stmt
            .query_map(params![video_id, start, end], |row| {
                Ok(format!(
                    "T{}:{:.3}:{:.3}\0",
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?
                ))
            })
            .map_err(|err| err.to_string())?;
        for row in rows {
            hasher.update(row.map_err(|err| err.to_string())?.as_bytes());
        }
    }
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Saves (or replaces) the lesson's voice. A regenerated voice keeps the
/// lesson's "use in exports" choice.
fn save_lesson_voice(
    conn: &Connection,
    lesson_id: &str,
    signature: &str,
    hash: &str,
    track: &VoiceTrack,
) -> Result<(), String> {
    let json = serde_json::to_string(track).map_err(|err| err.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO lesson_voice (lesson_id, use_in_export, signature, script_hash, track_json, updated_at)
         VALUES (?1, 1, ?2, ?3, ?4, ?5)
         ON CONFLICT(lesson_id) DO UPDATE SET signature = excluded.signature,
           script_hash = excluded.script_hash, track_json = excluded.track_json,
           updated_at = excluded.updated_at",
        params![lesson_id, signature, hash, json, now],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// A lesson's saved voice, as the editor gets it back.
#[derive(Debug, Clone, Serialize)]
pub struct SavedLessonVoice {
    pub track: VoiceTrack,
    pub signature: String,
    pub use_in_export: bool,
}

/// The saved row, or `None` when there's none or its WAV is gone (the
/// app cache was cleared; Generate rebuilds it).
fn read_lesson_voice(conn: &Connection, lesson_id: &str) -> Result<Option<(SavedLessonVoice, String)>, String> {
    let row: Option<(bool, String, String, String)> = conn
        .query_row(
            "SELECT use_in_export, signature, script_hash, track_json FROM lesson_voice WHERE lesson_id = ?1",
            params![lesson_id],
            |row| Ok((row.get::<_, i64>(0)? != 0, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((use_in_export, signature, hash, json)) = row else {
        return Ok(None);
    };
    let Ok(track) = serde_json::from_str::<VoiceTrack>(&json) else {
        return Ok(None);
    };
    if !Path::new(&track.path).is_file() {
        return Ok(None);
    }
    Ok(Some((
        SavedLessonVoice {
            track,
            signature,
            use_in_export,
        },
        hash,
    )))
}

#[tauri::command]
pub fn get_lesson_voice(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
) -> Result<Option<SavedLessonVoice>, String> {
    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    Ok(read_lesson_voice(&guard, &lesson_id)?.map(|(saved, _)| saved))
}

#[tauri::command]
pub fn set_lesson_voice_export(
    conn: tauri::State<'_, DbConnection>,
    lesson_id: String,
    use_in_export: bool,
) -> Result<(), String> {
    let guard = conn.0.lock().map_err(|err| err.to_string())?;
    guard
        .execute(
            "UPDATE lesson_voice SET use_in_export = ?2 WHERE lesson_id = ?1",
            params![lesson_id, use_in_export as i64],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

/// The voice track an export of this lesson should use: `None` when the
/// lesson has no voice or it's switched off for exports. Refuses, rather
/// than export an out-of-sync voice, when the lesson changed since the
/// voice was made or its track is gone.
pub(crate) fn voice_track_for_export(conn: &Connection, lesson_id: &str) -> Result<Option<VoiceTrack>, String> {
    let use_in_export: Option<bool> = conn
        .query_row(
            "SELECT use_in_export FROM lesson_voice WHERE lesson_id = ?1",
            params![lesson_id],
            |row| Ok(row.get::<_, i64>(0)? != 0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if use_in_export != Some(true) {
        return Ok(None);
    }
    let Some((saved, hash)) = read_lesson_voice(conn, lesson_id)? else {
        return Err("This lesson's AI voice is missing. Open its AI voice tab and Generate again \
                    (unchanged lines are free), or turn off \"Use the AI voice in exports\"."
            .to_string());
    };
    if hash != script_hash(conn, lesson_id)? {
        return Err("This lesson was edited after its AI voice was made. Open its AI voice tab and \
                    Generate again, or turn off \"Use the AI voice in exports\"."
            .to_string());
    }
    Ok(Some(saved.track))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start: f64, end: f64) -> VoiceLineInput {
        VoiceLineInput {
            text: "x".into(),
            start,
            end,
        }
    }

    #[test]
    fn short_clips_keep_their_place_and_speed() {
        let placed = place_lines(&[line(0.0, 5.0), line(5.0, 9.0)], &[3.0, 2.0]);
        assert_eq!(placed[0].start, 0.0);
        assert_eq!(placed[0].rate, 1.0);
        assert_eq!(placed[1].start, 5.0);
        assert_eq!(placed[1].late_by, 0.0);
    }

    #[test]
    fn long_clips_are_sped_up_to_fit() {
        let placed = place_lines(&[line(0.0, 4.0), line(4.0, 8.0)], &[4.4, 1.0]);
        assert_eq!(placed[0].rate, 1.1);
        assert!((placed[0].duration - 4.0).abs() < 0.01);
        assert!(placed[1].late_by < 0.01);
    }

    #[test]
    fn clips_too_long_even_sped_up_push_the_next_line() {
        let placed = place_lines(&[line(0.0, 2.0), line(2.0, 6.0)], &[5.0, 1.0]);
        assert_eq!(placed[0].rate, MAX_SPEEDUP);
        assert!((placed[0].duration - 4.0).abs() < 0.01);
        assert!((placed[1].start - 4.0).abs() < 0.01);
        assert!((placed[1].late_by - 2.0).abs() < 0.01);
        // Never overlapping.
        assert!(placed[1].start >= placed[0].start + placed[0].duration - 1e-9);
    }

    #[test]
    fn settings_default_off_and_validate_voice() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        let settings = read_voice_settings(&conn).unwrap();
        assert!(!settings.enabled);
        assert_eq!(settings.voice, DEFAULT_VOICE);
        let saved = write_voice_settings(
            &conn,
            &VoiceSettings {
                enabled: true,
                voice: "onyx".into(),
                instructions: "  calm ".into(),
            },
        )
        .unwrap();
        assert!(saved.enabled);
        assert_eq!(saved.voice, "onyx");
        assert_eq!(saved.instructions, "calm");
        assert!(write_voice_settings(
            &conn,
            &VoiceSettings {
                enabled: true,
                voice: "nobody".into(),
                instructions: String::new(),
            },
        )
        .is_err());
    }

    #[test]
    fn clip_keys_change_with_voice_instructions_and_text() {
        let base = clip_key("coral", "", "Hello.");
        assert_ne!(base, clip_key("onyx", "", "Hello."));
        assert_ne!(base, clip_key("coral", "calm", "Hello."));
        assert_ne!(base, clip_key("coral", "", "Hello!"));
        assert_eq!(base, clip_key("coral", "", "Hello."));
    }

    fn lesson_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Test', 't', 't');
             INSERT INTO videos (id, project_id, file_path, created_at, updated_at)
               VALUES ('v1', 'p1', '/tmp/video.mp4', 't', 't');
             INSERT INTO lessons (id, video_id, title, summary, start, end, sort_order, confidence, kind, source)
               VALUES ('l1', 'v1', 'Lesson', 's', 0.0, 10.0, 0, 0.8, 'lesson', 'ai');
             INSERT INTO lesson_segments (id, lesson_id, start, end, sort_order) VALUES ('s1', 'l1', 0.0, 10.0, 0);
             INSERT INTO transcript_words (id, video_id, idx, text, start, end) VALUES ('w1', 'v1', 0, 'Hello', 1.0, 1.5);
             INSERT INTO transcript_words (id, video_id, idx, text, start, end) VALUES ('w2', 'v1', 1, 'later', 12.0, 12.5);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn script_hash_follows_the_lessons_words_and_cuts_only() {
        let conn = lesson_conn();
        let base = script_hash(&conn, "l1").unwrap();
        // A word outside the lesson doesn't matter.
        conn.execute("UPDATE transcript_words SET text = 'Later' WHERE id = 'w2'", []).unwrap();
        assert_eq!(base, script_hash(&conn, "l1").unwrap());
        // A text fix inside it does.
        conn.execute("UPDATE transcript_words SET text = 'Hi' WHERE id = 'w1'", []).unwrap();
        let fixed = script_hash(&conn, "l1").unwrap();
        assert_ne!(base, fixed);
        // So does a cut.
        conn.execute("UPDATE lesson_segments SET end = 8.0 WHERE id = 's1'", []).unwrap();
        assert_ne!(fixed, script_hash(&conn, "l1").unwrap());
    }

    #[test]
    fn export_uses_a_saved_voice_only_while_it_matches_the_lesson() {
        let conn = lesson_conn();
        assert!(voice_track_for_export(&conn, "l1").unwrap().is_none());

        let wav = std::env::temp_dir().join(format!("coursecut-voice-test-{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&wav, b"RIFF").unwrap();
        let track = VoiceTrack {
            path: wav.to_string_lossy().to_string(),
            duration: 10.0,
            lines: vec![],
            generated: 0,
            late_lines: 0,
        };
        let hash = script_hash(&conn, "l1").unwrap();
        save_lesson_voice(&conn, "l1", "sig", &hash, &track).unwrap();
        assert_eq!(voice_track_for_export(&conn, "l1").unwrap().unwrap().path, track.path);
        let (saved, _) = read_lesson_voice(&conn, "l1").unwrap().unwrap();
        assert!(saved.use_in_export);
        assert_eq!(saved.signature, "sig");

        // Switched off: the recording is exported.
        conn.execute("UPDATE lesson_voice SET use_in_export = 0", []).unwrap();
        assert!(voice_track_for_export(&conn, "l1").unwrap().is_none());
        // Regenerating keeps that choice.
        save_lesson_voice(&conn, "l1", "sig2", &hash, &track).unwrap();
        assert!(voice_track_for_export(&conn, "l1").unwrap().is_none());
        conn.execute("UPDATE lesson_voice SET use_in_export = 1", []).unwrap();

        // Edited after the voice was made: refused.
        conn.execute("UPDATE transcript_words SET text = 'Hi' WHERE id = 'w1'", []).unwrap();
        assert!(voice_track_for_export(&conn, "l1").is_err());

        // Track gone from the cache: refused, and the editor sees no voice.
        std::fs::remove_file(&wav).unwrap();
        assert!(voice_track_for_export(&conn, "l1").is_err());
        assert!(read_lesson_voice(&conn, "l1").unwrap().is_none());
    }

    #[test]
    fn improved_lines_are_parsed_and_tidied() {
        assert_eq!(parse_improved_line(r#"{"text": "  Open the   Setup page. "}"#).unwrap(), "Open the Setup page.");
        assert!(parse_improved_line(r#"{"text": "   "}"#).is_err());
        assert!(parse_improved_line("not json").is_err());
    }

    #[test]
    fn lines_must_be_in_order_and_have_text() {
        assert!(validate_lines(&[line(0.0, 1.0), line(2.0, 3.0)], 3.0).is_ok());
        assert!(validate_lines(&[line(2.0, 3.0), line(0.0, 1.0)], 3.0).is_err());
        assert!(validate_lines(&[], 3.0).is_err());
        let mut empty = line(0.0, 1.0);
        empty.text = "  ".into();
        assert!(validate_lines(&[empty], 3.0).is_err());
    }
}
