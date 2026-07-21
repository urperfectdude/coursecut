//! Single typed progress event ("video-progress") emitted from the
//! extract/transcribe/analyze pipeline (`ffmpeg.rs`, `openai.rs`) and
//! consumed by the frontend's `useVideoProgress()` hook
//! (`src/hooks/useVideoProgress.ts`). Local IPC only — nothing here is a
//! network call, so it doesn't touch `coursecut-privacy-invariants`.

use tauri::{AppHandle, Emitter};

// No `Importing` variant: the plan's Phase 2 sketch lists one, but its own
// "Emit points" list has no import-stage site (`import_videos` is a
// synchronous, file-copy-free metadata operation with nothing to report on)
// — add it back if/when a real emit site exists, rather than carrying a
// variant no code ever constructs.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub enum Stage {
    ExtractingAudio,
    Transcribing,
    Analyzing,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct VideoProgress {
    video_id: String,
    stage: Stage,
    fraction: Option<f64>,
    detail: Option<String>,
    attempt: u32,
}

/// Emits a `"video-progress"` event to the frontend. Best-effort: an emit
/// failure (e.g. no window yet) must never fail the underlying pipeline
/// step, so the error is swallowed rather than propagated.
pub fn emit(
    app: &AppHandle,
    video_id: &str,
    stage: Stage,
    fraction: Option<f64>,
    detail: Option<String>,
    attempt: u32,
) {
    let payload = VideoProgress {
        video_id: video_id.to_string(),
        stage,
        fraction,
        detail,
        attempt,
    };
    let _ = app.emit("video-progress", payload);
}
