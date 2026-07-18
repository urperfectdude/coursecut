mod db;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let connection = db::open_connection(app.handle())?;
            app.manage(db::DbConnection(std::sync::Mutex::new(connection)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::create_project,
            db::list_projects,
            db::get_project,
            db::delete_project,
            db::import_videos,
            db::list_videos,
        ])
        .run(tauri::generate_context!())
        .expect("error while running coursecut");
}
