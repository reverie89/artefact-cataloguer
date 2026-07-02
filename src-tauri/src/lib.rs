//! Artefact Cataloguer — Tauri backend.
//!
//! Three concerns, all file paths resolved relative to the running binary
//! (the exe's directory) so settings and temp images live beside the app:
//!   * `state`    — load/save the single settings.json beside the exe
//!   * `images`   — write extracted spreadsheet images to <exedir>/tmp/...,
//!                  wiping that subtree on startup and on app quit
//!   * `ai`       — OpenAI-compatible chat completion calls (keys never
//!                  touch the renderer, so there is no CORS)

mod ai;
mod images;
mod settings;

// `Manager` is only needed for the dev-only devtools call below; keep the
// import so the trait is in scope when that code is compiled in.
#[allow(unused_imports)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Wipe any leftover temp images from a previous run before the UI starts.
    if let Err(e) = images::cleanup_temp() {
        eprintln!("[artefact] startup temp cleanup failed: {e}");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ai::default_registry())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }

            // Grant the real scratch dir to the asset protocol at runtime. The
            // static `$EXEDIR/tmp/**` scope can miss the canonicalized request
            // path on Windows (the `\\?\` verbatim prefix `canonicalize` adds),
            // which makes extracted images 403 in the webview. Adding the
            // resolved directory directly sidesteps that mismatch in dev and
            // packaged builds alike.
            let scratch = images::temp_app_dir();
            let _ = std::fs::create_dir_all(&scratch);
            let _ = app.asset_protocol_scope().allow_directory(&scratch, true);

            // In release builds `app` is otherwise unused.
            let _ = &app;
            Ok(())
        })
        .on_window_event(|window, event| {
            // App quit: tear down the temp image directory beside the exe.
            if let tauri::WindowEvent::Destroyed = event {
                if let Err(e) = images::cleanup_temp() {
                    eprintln!("[artefact] quit temp cleanup failed: {e}");
                }
                // Touch `window` so the parameter isn't flagged unused in
                // configurations where the match arm does nothing else.
                let _ = window.label();
            }
        })
        .invoke_handler(tauri::generate_handler![
            settings::load_state,
            settings::save_state,
            images::extract_images,
            images::cleanup_temp,
            ai::catalogue_artefact,
            ai::cancel_catalogue,
            ai::build_prompts_preview,
            ai::test_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Artefact Cataloguer");
}
