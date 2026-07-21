mod app_settings;
mod db;
mod export;
mod ffmpeg;
mod openai;
mod progress;
mod settings;
mod wav;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let connection = db::open_connection(app.handle())?;
            // The asset-protocol scope registered by `import_videos` is
            // in-memory only and doesn't persist across launches (unlike the
            // `videos` rows themselves) — re-allow every already-imported
            // video's path now, or it would silently stop being playable
            // after a restart.
            db::allow_existing_video_playback(app.handle(), &connection)?;
            // Crash recovery: if the app was previously killed mid-export,
            // its `exports` row would otherwise be stuck at `status =
            // 'running'` forever (no UI-reachable command accepts that
            // status) — reset any such row to `failed` so `retry_export`
            // can reach it. Must run before the worker task is spawned
            // below, so it never has a chance to see a stale `running` row
            // from a previous session.
            let cache_dir = app
                .path()
                .app_cache_dir()
                .map_err(|err| format!("could not resolve app cache dir: {err}"))?;
            export::reconcile_interrupted_exports(&connection, &cache_dir)?;
            app.manage(db::DbConnection(std::sync::Mutex::new(connection)));
            // Tracks the `CommandChild` of whatever export is currently
            // running, so `cancel_export` can find and kill it (see
            // `export.rs`'s `ExportRunning`).
            app.manage(export::ExportRunning::new());
            // The single, sequential, app-wide export queue processor (PRD
            // §10) — one background task for the whole app's lifetime, not
            // per-video/per-lesson, so only one ffmpeg export subprocess
            // ever runs at a time.
            export::spawn_worker(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::create_project,
            db::list_projects,
            db::get_project,
            db::delete_project,
            db::delete_video,
            db::import_videos,
            db::list_videos,
            db::get_video,
            db::mark_video_error,
            db::list_transcript_segments,
            db::list_lessons,
            db::update_transcript_segment,
            db::update_lesson,
            db::create_lesson,
            db::split_lesson,
            db::merge_lessons,
            db::delete_lesson,
            db::reorder_lessons,
            db::list_lesson_segments,
            db::add_lesson_segment,
            db::update_lesson_segment,
            db::delete_lesson_segment,
            db::reorder_lesson_segments,
            ffmpeg::extract_audio_for_video,
            openai::transcribe_video,
            openai::analyze_video,
            settings::save_openai_key,
            settings::get_openai_key_status,
            settings::test_openai_key,
            app_settings::save_analysis_instructions,
            app_settings::get_analysis_instructions,
            export::queue_export,
            export::pause_export,
            export::resume_export,
            export::cancel_export,
            export::retry_export,
            export::list_exports,
            export::reveal_in_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running coursecut");
}
