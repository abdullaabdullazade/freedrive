mod account_crypto;
mod api;
mod auth_store;
mod blocking;
mod cfapi;
mod commands;
mod crypto;
mod db;
mod desktop_settings;
mod error;
mod secret_storage;
mod my_drive;
mod my_drive_shell;
mod state;
mod sync;

use state::AppState;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};

pub(crate) fn shutdown_cfapi() {
    #[cfg(windows)]
    crate::cfapi::stop();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // NSIS PREUNINSTALL invokes these before removing binaries (no UI). `--uninstall-cleanup`
    // only drops the Explorer/CfAPI registration so an upgrade keeps working; `--uninstall-purge`
    // additionally deletes My Drive and %APPDATA%\FreeDrive (Tauri's BUNDLEID path is not used).
    let uninstall_cleanup = std::env::args().any(|a| a == "--uninstall-cleanup");
    let uninstall_purge = std::env::args().any(|a| a == "--uninstall-purge");
    if uninstall_cleanup || uninstall_purge {
        match db::open_db() {
            Ok(db) => {
                #[cfg(windows)]
                if uninstall_cleanup {
                    cfapi::unregister_for_uninstall(&db);
                }
                if uninstall_purge {
                    if let Err(e) = my_drive::uninstall_remove_my_drive(&db) {
                        eprintln!("uninstall purge failed: {}", e);
                        sync::log::sync_log(format!("uninstall purge failed: {}", e));
                    }
                }
            }
            Err(e) => {
                eprintln!("uninstall cleanup: open db failed: {}", e);
            }
        }
        if uninstall_purge {
            my_drive::uninstall_remove_app_data();
        }
        return;
    }

    // Prove Explorer launched us (before single-instance may exit).
    my_drive_shell::append_shell_invoke_log();

    // Explorer context menu: always enqueue before single-instance may exit(0).
    let launch_args: Vec<String> = std::env::args().collect();
    if let Some(action) = my_drive_shell::parse_my_drive_shell_args(&launch_args) {
        my_drive_shell::write_pending_shell_action(&action);
    }

    let db = db::open_db().expect("failed to open database");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let is_shell = my_drive_shell::handle_single_instance_shell(&app, &args);
            // Explorer context-menu invocations must stay in tray.
            if !is_shell {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![] as Vec<&str>),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::new(db))
        .invoke_handler(tauri::generate_handler![
            commands::get_auth_state,
            commands::register,
            commands::login,
            commands::poll_login_approval,
            commands::verify_2fa,
            commands::send_2fa_email,
            commands::logout,
            commands::expire_session,
            commands::get_system_folders,
            commands::pick_folder,
            commands::save_sync_config,
            commands::complete_onboarding,
            commands::get_sync_status,
            commands::get_sync_activity,
            commands::get_sync_folders,
            commands::add_sync_folder,
            commands::remove_sync_folder,
            commands::open_preferences_window,
            commands::quit_app,
            commands::get_sync_mode,
            commands::set_sync_mode,
            commands::get_launch_on_login,
            commands::set_launch_on_login,
            commands::get_start_minimized,
            commands::set_start_minimized,
            commands::get_desktop_sync_settings,
            commands::set_desktop_sync_settings,
            commands::get_remote_sync_folders,
            commands::open_sync_log_folder,
            commands::pause_sync,
            commands::resume_sync,
            commands::open_drive_folder,
            commands::get_explorer_integration_status,
            commands::get_profile,
            commands::get_storage_info,
            commands::get_shared_with_me,
            commands::browse_drive,
            commands::search_drive,
            commands::get_drive_collection,
            commands::restore_drive_item,
            commands::permanently_delete_drive_item,
            commands::empty_drive_trash,
            commands::create_drive_folder,
            commands::upload_drive_files,
            commands::trash_drive_item,
            commands::list_drive_folders,
            commands::update_drive_item,
            commands::download_drive_file,
            commands::preview_drive_file,
            commands::get_drive_file_versions,
            commands::restore_drive_file_version,
            commands::share_drive_item_with_user,
            commands::create_drive_share_link,
            commands::get_drive_item_shares,
            commands::update_drive_user_share,
            commands::revoke_drive_user_share,
            commands::revoke_drive_share_link,
            commands::get_sync_conflicts,
            commands::resolve_sync_conflict,
            commands::open_path_in_explorer,
            commands::import_encryption_keys,
            commands::export_encryption_keys,
            commands::unregister_explorer_integration,
            commands::get_crypto_status,
            commands::unlock_crypto_recovery,
            commands::rotate_crypto_key,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            if app
                .config()
                .plugins
                .0
                .get("updater")
                .is_some_and(serde_json::Value::is_object)
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            let state = app.state::<AppState>();
            let _ = commands::init_api_from_storage(&state);

            if auth_store::load_auth().ok().flatten().is_some() {
                if let Ok(client) = state.api() {
                    let engine = std::sync::Arc::new(sync::engine::SyncEngine::new(
                        client,
                        state.db.clone(),
                        app.handle().clone(),
                    ));
                    engine.load_computer_from_db();
                    state.set_sync_engine(engine);
                }

                #[cfg(windows)]
                commands::spawn_cfapi_integration(app.handle());

                my_drive_shell::spawn_pending_shell_poller(app.handle());

                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        let _ = commands::restore_sync_on_startup(&state, &app_handle).await;
                    }
                    // Cold start from Explorer context menu (argv + pending file, deduped).
                    let args: Vec<String> = std::env::args().collect();
                    my_drive_shell::handle_single_instance_shell(&app_handle, &args);
                });
            }

            let open_i = MenuItem::with_id(app, "open", "Open FreeDrive", true, None::<&str>)?;
            let pause_i = MenuItem::with_id(app, "pause", "Pause sync", true, None::<&str>)?;
            let resume_i = MenuItem::with_id(app, "resume", "Resume sync", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &pause_i, &resume_i, &quit_i])?;

            let icon = app.default_window_icon().cloned().expect("tray icon");
            let _tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .menu(&menu)
                .tooltip("FreeDrive")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "pause" => {
                        if let Some(state) = app.try_state::<AppState>() {
                            if let Ok(engine) = state.sync_engine() {
                                engine.set_paused(true);
                            }
                        }
                    }
                    "resume" => {
                        if let Some(state) = app.try_state::<AppState>() {
                            if let Ok(engine) = state.sync_engine() {
                                engine.set_paused(false);
                                let eng = engine.clone();
                                tauri::async_runtime::spawn(async move {
                                    let _ = eng.clone().run_initial_sync().await;
                                });
                            }
                        }
                    }
                    "quit" => {
                        shutdown_cfapi();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Cold start: hide main window when "Start minimized" is enabled (tray only).
            {
                let state = app.state::<AppState>();
                let start_minimized = state
                    .db
                    .lock()
                    .ok()
                    .and_then(|conn| crate::db::config_get(&conn, "start_minimized").ok().flatten())
                    .as_deref()
                    == Some("true");
                if start_minimized {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label == "main" || label == "preferences" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                shutdown_cfapi();
            }
        });
}
