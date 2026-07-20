//! OpenAI API key storage and verification (BYOK — coursecut never ships a
//! baked-in key; see PRD and `coursecut-privacy-invariants`).
//!
//! The key is a secret and is deliberately kept out of SQLite: it's stored
//! in the OS keychain via the `keyring` crate, under a fixed service/account
//! pair. This module never sends anything to OpenAI beyond the user's own
//! key, and only to `/v1/models`, to confirm the key works — no transcript
//! or video content is ever involved here.

use serde::Serialize;

const KEYRING_SERVICE: &str = "coursecut";
const KEYRING_ACCOUNT: &str = "openai_api_key";

#[derive(Debug, Serialize)]
pub struct KeyStatus {
    pub present: bool,
    pub last_four: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct KeyTestResult {
    pub valid: bool,
    pub message: String,
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|err| err.to_string())
}

/// Reads the stored key, treating "no entry found" as `Ok(None)` rather
/// than an error — the key simply hasn't been saved yet. `pub(crate)` so
/// other backend modules (e.g. `openai.rs`, to authenticate Whisper calls)
/// can fetch the raw key without duplicating the `Entry::new(...)` call;
/// the raw key itself is never exposed to the frontend (see
/// `get_openai_key_status`, which only returns a masked summary).
pub(crate) fn read_stored_key() -> Result<Option<String>, String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub fn save_openai_key(key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("API key must not be empty".to_string());
    }
    let entry = keyring_entry()?;
    entry.set_password(&key).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_openai_key_status() -> Result<KeyStatus, String> {
    match read_stored_key()? {
        Some(key) => {
            let last_four = if key.len() >= 4 {
                Some(key[key.len() - 4..].to_string())
            } else {
                Some(key.clone())
            };
            Ok(KeyStatus {
                present: true,
                last_four,
            })
        }
        None => Ok(KeyStatus {
            present: false,
            last_four: None,
        }),
    }
}

#[derive(serde::Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(serde::Deserialize)]
struct ModelEntry {
    id: String,
}

/// Calls OpenAI's `GET /v1/models` with the stored key to confirm it's
/// valid, and reports whether Whisper and a GPT-5-class model are
/// available on the account. Sends only the user's own API key, to
/// OpenAI's model-listing endpoint — no transcript or media content.
#[tauri::command(async)]
pub async fn test_openai_key() -> Result<KeyTestResult, String> {
    let key = read_stored_key()?.ok_or_else(|| "No API key saved yet".to_string())?;

    const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

    let client = reqwest::Client::new();
    let request = client
        .get("https://api.openai.com/v1/models")
        .bearer_auth(&key)
        .send();

    let response = match tokio::time::timeout(REQUEST_TIMEOUT, request).await {
        Ok(Ok(response)) => response,
        Ok(Err(err)) => {
            return Ok(KeyTestResult {
                valid: false,
                message: format!("Request failed: {err}"),
            });
        }
        Err(_) => {
            return Ok(KeyTestResult {
                valid: false,
                message: "Request timed out".to_string(),
            });
        }
    };

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(KeyTestResult {
            valid: false,
            message: "Invalid API key".to_string(),
        });
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(200).collect();
        return Ok(KeyTestResult {
            valid: false,
            message: format!("OpenAI returned {status}: {snippet}"),
        });
    }

    let parsed: ModelsResponse = match response.json().await {
        Ok(parsed) => parsed,
        Err(err) => {
            return Ok(KeyTestResult {
                valid: false,
                message: format!("Could not parse response: {err}"),
            });
        }
    };

    let has_whisper = parsed.data.iter().any(|model| model.id == "whisper-1");
    let has_gpt5 = parsed
        .data
        .iter()
        .any(|model| model.id.starts_with("gpt-5"));

    let message = format!(
        "Key is valid. whisper-1: {}. gpt-5 class model: {}.",
        if has_whisper { "available" } else { "not found" },
        if has_gpt5 { "available" } else { "not found" },
    );

    Ok(KeyTestResult {
        valid: true,
        message,
    })
}
