use crate::api::types::{LoginSuccess, SharedItem, StorageInfo, User};
use crate::api::ApiClient;
use crate::auth_store::{clear_auth, load_auth, my_drive_path, save_auth, sync_root_dir, StoredAuth};
use crate::db::{
    config_get, config_set, delete_sync_folder, import_file_keys, list_activity, list_all_file_keys,
    list_sync_folders, prepare_login_session, reset_session_on_logout, save_local_sync_folders,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::sync::engine::{initial_sync_complete, SyncEngine, SyncStatusKind};
use crate::sync::watcher::WatcherHandle;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize)]
pub struct AuthState {
    pub logged_in: bool,
    pub server_url: Option<String>,
    pub user: Option<User>,
    pub onboarding_complete: bool,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub server_url: String,
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LoginResult {
    Success { user: User },
    TwoFactor {
        challenge_id: String,
        email_masked: String,
        method: String,
        methods_available: Vec<String>,
    },
}

#[derive(Debug, Deserialize)]
pub struct TwoFactorRequest {
    pub server_url: String,
    pub challenge_id: String,
    pub code: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct Send2FAEmailRequest {
    pub server_url: String,
    pub challenge_id: String,
}

#[derive(Debug, Serialize)]
pub struct SystemFolder {
    pub label: String,
    pub path: String,
    pub suggested: bool,
}

#[derive(Debug, Serialize)]
pub struct ExplorerIntegrationStatus {
    pub connected: bool,
    pub registered: bool,
    pub finalized: bool,
    pub sync_root_path: String,
    pub my_drive_path: String,
}

#[derive(Debug, Deserialize)]
pub struct SaveSyncConfigRequest {
    pub folders: Vec<SelectedFolder>,
}

#[derive(Debug, Deserialize)]
pub struct SelectedFolder {
    pub path: String,
    pub label: String,
}

fn onboarding_complete(state: &AppState) -> bool {
    state.is_onboarding_complete()
}

/// Start CfAPI in a background thread so login/UI never blocks on WinRT/CfConnect.
#[cfg(windows)]
pub fn spawn_cfapi_integration(app: &AppHandle) {
    crate::cfapi::init_app_handle(app.clone());
    let app_handle = app.clone();
    std::thread::spawn(move || {
        use std::sync::mpsc;

        let (tx, rx) = mpsc::sync_channel(1);
        let app_bg = app_handle.clone();
        std::thread::spawn(move || {
            let result = if let Some(state) = app_bg.try_state::<AppState>() {
                crate::cfapi::start(&state)
            } else {
                Err("AppState unavailable for explorer integration".to_string())
            };
            let _ = tx.send(result);
        });

        match rx.recv_timeout(Duration::from_secs(60)) {
            Ok(Ok(())) => {
                crate::sync::log::sync_log("cfapi: explorer integration started (background)");
            }
            Ok(Err(e)) => {
                eprintln!("CfAPI explorer integration failed: {}", e);
                crate::sync::log::sync_log(format!("cfapi: explorer integration failed: {}", e));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                eprintln!("CfAPI explorer integration timed out after 60s");
                crate::sync::log::sync_log(
                    "cfapi: explorer integration timed out after 60s (continuing in background)",
                );
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                eprintln!("CfAPI explorer integration thread disconnected");
            }
        }
    });
}

#[cfg(not(windows))]
pub fn spawn_cfapi_integration(_app: &AppHandle) {}

fn restart_watcher(state: &AppState, engine: Arc<SyncEngine>) -> Result<(), String> {
    let folders = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        list_sync_folders(&conn).map_err(|e: crate::error::AppError| e.to_string())?
    };
    let mut paths: Vec<PathBuf> = folders
        .iter()
        .map(|f| PathBuf::from(&f.local_path))
        .collect();
    if let Ok(my_drive) = crate::auth_store::my_drive_path(false) {
        if my_drive.exists() {
            paths.push(my_drive);
        }
    }
    let watcher = WatcherHandle::start(paths, engine)
        .map_err(|e: crate::error::AppError| e.to_string())?;
    state.set_watcher(watcher);
    Ok(())
}

fn start_sync_services(
    state: &AppState,
    app: &AppHandle,
    engine: Arc<SyncEngine>,
    paths: Vec<PathBuf>,
    run_initial: bool,
    start_watcher: bool,
) -> Result<(), String> {
    let _paths = paths;
    if start_watcher {
        restart_watcher(state, engine.clone())?;
    }

    if run_initial {
        let eng = engine.clone();
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = eng.clone().run_initial_sync().await {
                eprintln!("initial sync failed: {}", e);
                eng.report_sync_error(e.to_string());
                let _ = app_handle.emit("sync-status-changed", eng.get_status());
            }
            if let Some(app_state) = app_handle.try_state::<AppState>() {
                if app_state.watcher.lock().is_none() {
                    let _ = restart_watcher(&app_state, eng);
                }
            }
        });
    }

    if state.sync_background.try_start_background() {
        let eng = engine.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                if eng.is_shutdown() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                if eng.is_shutdown() {
                    break;
                }
                if eng.is_initial_sync_running() {
                    continue;
                }
                let _ = eng.poll_my_drive().await;
                let _ = eng.poll_remote().await;
            }
        });

        let eng2 = engine.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                if eng2.is_shutdown() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                if eng2.is_shutdown() {
                    break;
                }
                let _ = eng2.heartbeat_loop().await;
            }
        });

        // Periodic orphan/local-delete catch-up (missed watcher events, Recycle Bin).
        let eng3 = engine.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                if eng3.is_shutdown() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                if eng3.is_shutdown() || eng3.is_paused() {
                    continue;
                }
                if eng3.is_initial_sync_running() {
                    continue;
                }
                if let Err(e) = eng3.clone().run_background_verify().await {
                    eprintln!("periodic background verify failed: {}", e);
                    crate::sync::log::sync_log(format!(
                        "periodic background verify failed: {}",
                        e
                    ));
                }
            }
        });
    }

    let _ = app.emit("sync-status-changed", engine.get_status());
    Ok(())
}

fn emit_crypto_sync_stats(app: &AppHandle, stats: &crate::account_crypto::CryptoSyncStats) {
    let total = stats.pulled + stats.pushed + stats.pending_flushed;
    if total > 0 {
        let _ = app.emit("crypto-keys-synced", stats.clone());
    }
}

fn emit_crypto_unlocked(app: &AppHandle) {
    let _ = app.emit("crypto-unlocked", ());
}

fn emit_crypto_unlock_failed(app: &AppHandle, message: &str) {
    let _ = app.emit("crypto-unlock-failed", message.to_string());
}

async fn ensure_crypto_unlocked(state: &AppState, app: &AppHandle) -> Result<(), String> {
    let auth = load_auth()
        .map_err(|e: crate::error::AppError| e.to_string())?
        .ok_or_else(|| "not logged in".to_string())?;
    let user: serde_json::Value =
        serde_json::from_str(&auth.user_json).map_err(|e| e.to_string())?;
    let user_id = user
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing user id".to_string())?
        .to_string();
    let client = state.api().map_err(|e| e.to_string())?;
    if let Some(stats) = crate::account_crypto::ensure_unlocked_from_keyring(
        &client,
        &state.db,
        &user_id,
    )
    .await
    .map_err(|e: crate::error::AppError| e.to_string())?
    {
        emit_crypto_unlocked(app);
        emit_crypto_sync_stats(app, &stats);
    }
    Ok(())
}

pub async fn restore_sync_on_startup(state: &AppState, app: &AppHandle) -> AppResult<()> {
    if let Err(e) = ensure_crypto_unlocked(state, app).await {
        eprintln!("crypto unlock on startup failed: {}", e);
    }

    let complete = {
        let conn = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        config_get(&conn, "onboarding_complete")?
            .map(|v| v == "true")
            .unwrap_or(false)
    };
    if !complete {
        return Ok(());
    }

    let engine = state.sync_engine().map_err(|e| AppError::msg(e))?;
    if let Err(e) = engine.setup_computer().await {
        eprintln!("setup_computer on startup failed: {}", e);
    }

    let folders = {
        let conn = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        list_sync_folders(&conn)?
    };
    if folders.is_empty() {
        return Ok(());
    }

    let paths: Vec<PathBuf> = folders.iter().map(|f| PathBuf::from(&f.local_path)).collect();

    let pending_initial = !initial_sync_complete(&state.db);
    if pending_initial {
        engine.set_sync_status(SyncStatusKind::Syncing, "Resuming sync…");
    }

    start_sync_services(state, app, engine.clone(), paths, pending_initial, true)
        .map_err(|e| AppError::msg(e))?;

    if !pending_initial {
        engine.set_sync_status(SyncStatusKind::Syncing, "Syncing…");
        let eng = engine.clone();
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = eng.clone().run_background_verify().await {
                eprintln!("background verify on startup failed: {}", e);
            }
            let _ = app_handle.emit("sync-status-changed", eng.get_status());
        });
    }

    Ok(())
}

pub fn init_api_from_storage(state: &AppState) -> AppResult<()> {
    if let Some(auth) = load_auth()? {
        let client = ApiClient::from_auth(&auth);
        state.set_api(client);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_auth_state(state: State<'_, AppState>) -> Result<AuthState, String> {
    let complete = onboarding_complete(&state);
    if let Some(auth) = load_auth().map_err(|e: crate::error::AppError| e.to_string())? {
        let user: Option<User> = serde_json::from_str(&auth.user_json).ok();
        let _ = init_api_from_storage(&state);
        return Ok(AuthState {
            logged_in: true,
            server_url: Some(auth.server_url),
            user,
            onboarding_complete: complete,
        });
    }
    Ok(AuthState {
        logged_in: false,
        server_url: None,
        user: None,
        onboarding_complete: complete,
    })
}

#[tauri::command]
pub async fn login(
    state: State<'_, AppState>,
    app: AppHandle,
    req: LoginRequest,
) -> Result<LoginResult, String> {
    let data = ApiClient::login(&req.server_url, &req.email, &req.password)
        .await
        .map_err(|e: crate::error::AppError| e.to_string())?;

    if let Some(requires) = data.get("requires_2fa").and_then(|v| v.as_bool()) {
        if requires {
            let methods = data
                .get("methods_available")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            return Ok(LoginResult::TwoFactor {
                challenge_id: data["challenge_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                email_masked: data["email_masked"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                method: data
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or("email")
                    .to_string(),
                methods_available: methods,
            });
        }
    }

    let success: LoginSuccess = serde_json::from_value(data).map_err(|e| e.to_string())?;
    finish_login(&state, &app, &req.server_url, &success, Some(&req.password)).await?;
    Ok(LoginResult::Success {
        user: success.user,
    })
}

#[tauri::command]
pub async fn verify_2fa(
    state: State<'_, AppState>,
    app: AppHandle,
    req: TwoFactorRequest,
) -> Result<User, String> {
    let success = ApiClient::verify_2fa(&req.challenge_id, &req.code, &req.server_url)
        .await
        .map_err(|e: crate::error::AppError| e.to_string())?;
    finish_login(
        &state,
        &app,
        &req.server_url,
        &success,
        Some(&req.password),
    )
    .await?;
    Ok(success.user)
}

#[tauri::command]
pub async fn send_2fa_email(req: Send2FAEmailRequest) -> Result<LoginResult, String> {
    let data = ApiClient::send_2fa_email(&req.challenge_id, &req.server_url)
        .await
        .map_err(|e: crate::error::AppError| e.to_string())?;
    let methods = data
        .get("methods_available")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec!["email".to_string()]);
    Ok(LoginResult::TwoFactor {
        challenge_id: data["challenge_id"]
            .as_str()
            .unwrap_or(&req.challenge_id)
            .to_string(),
        email_masked: data["email_masked"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        method: data
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("email")
            .to_string(),
        methods_available: methods,
    })
}

async fn finish_login(
    state: &AppState,
    app: &AppHandle,
    server_url: &str,
    success: &LoginSuccess,
    password: Option<&str>,
) -> Result<(), String> {
    let normalized_url = server_url.trim_end_matches('/').to_string();

    let folders_to_remap = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        prepare_login_session(&conn, &success.user.id, &normalized_url)
            .map_err(|e: crate::error::AppError| e.to_string())?
            .folders_to_remap
    };
    state.refresh_onboarding_from_db();

    let auth = StoredAuth {
        server_url: normalized_url,
        access_token: success.tokens.access_token.clone(),
        refresh_token: success.tokens.refresh_token.clone(),
        user_json: serde_json::json!({
            "id": success.user.id,
            "email": success.user.email,
            "username": success.user.username,
            "role": success.user.role,
        })
        .to_string(),
    };
    save_auth(&auth).map_err(|e: crate::error::AppError| e.to_string())?;

    let client = ApiClient::from_auth(&auth);
    state.set_api(client.clone());

    let engine = Arc::new(SyncEngine::new(client, state.db.clone(), app.clone()));
    engine.load_computer_from_db();
    state.set_sync_engine(engine);

    let user_id = success.user.id.clone();
    let password_owned = password.map(|s| s.to_string());
    let onboarding_done = onboarding_complete(state);
    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        let Some(app_state) = app_handle.try_state::<AppState>() else {
            return;
        };

        let client = match app_state.api() {
            Ok(c) => c,
            Err(_) => return,
        };

        if let Some(pwd) = password_owned.as_deref() {
            match crate::account_crypto::unlock_after_login(
                &client,
                &app_state.db,
                &user_id,
                pwd,
            )
            .await
            {
                Ok(unlock) => {
                    if unlock.setup {
                        if let Some(code) = unlock.recovery_code {
                            let _ = app_handle.emit("crypto-recovery-setup", code);
                        }
                    }
                    emit_crypto_unlocked(&app_handle);
                    emit_crypto_sync_stats(&app_handle, &unlock.sync_stats);
                }
                Err(e) => {
                    eprintln!("encryption unlock failed: {}", e);
                    let message = if e.to_string().to_lowercase().contains("decrypt") {
                        "Could not unlock encryption — check your password.".to_string()
                    } else {
                        format!("Could not unlock encryption: {}", e)
                    };
                    emit_crypto_unlock_failed(&app_handle, &message);
                }
            }
        } else if let Ok(Some(stats)) = crate::account_crypto::ensure_unlocked_from_keyring(
            &client,
            &app_state.db,
            &user_id,
        )
        .await
        {
            emit_crypto_unlocked(&app_handle);
            emit_crypto_sync_stats(&app_handle, &stats);
        }

        if let Ok(eng) = app_state.sync_engine() {
            if let Err(e) = eng.setup_computer().await {
                eprintln!("setup_computer on login failed: {}", e);
            }
        }

        spawn_cfapi_integration(&app_handle);

        if !folders_to_remap.is_empty() {
            let Ok(eng) = app_state.sync_engine() else {
                return;
            };
            if let Err(e) = eng.configure_folders(folders_to_remap.clone()).await {
                eprintln!("remap folders after server change failed: {}", e);
                return;
            }
            {
                let conn = match app_state.db.lock() {
                    Ok(c) => c,
                    Err(_) => return,
                };
                let _ = config_set(&conn, "initial_sync_complete", "false");
            }
            let paths: Vec<PathBuf> = folders_to_remap
                .into_iter()
                .map(|(p, _)| PathBuf::from(p))
                .collect();
            let _ = start_sync_services(&app_state, &app_handle, eng, paths, true, false);
        } else if onboarding_done {
            if let Err(e) = restore_sync_on_startup(&app_state, &app_handle).await {
                eprintln!("restore sync on login failed: {}", e);
                crate::sync::log::sync_log(format!("restore sync on login failed: {}", e));
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> Result<(), String> {
    let user_id = load_auth()
        .ok()
        .flatten()
        .and_then(|a| serde_json::from_str::<serde_json::Value>(&a.user_json).ok())
        .and_then(|v| v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()));
    if let Ok(client) = state.api() {
        let _ = client.logout().await;
    }
    if let Some(uid) = user_id.as_deref() {
        crate::account_crypto::clear_uek(uid);
    }
    if let Ok(engine) = state.sync_engine() {
        engine.shutdown();
    }
    #[cfg(windows)]
    crate::cfapi::stop();
    // After CfAPI disconnect: wipe My Drive contents (folder kept for next login).
    let _ = crate::my_drive::clear_my_drive_contents(&state.db);
    clear_auth().map_err(|e: crate::error::AppError| e.to_string())?;
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        reset_session_on_logout(&conn)
            .map_err(|e: crate::error::AppError| e.to_string())?;
    }
    *state.api.lock() = None;
    *state.sync_engine.lock() = None;
    *state.watcher.lock() = None;
    state.sync_background.reset();
    Ok(())
}

#[tauri::command]
pub async fn get_system_folders() -> Result<Vec<SystemFolder>, String> {
    let mut folders = Vec::new();
    if let Some(p) = dirs::desktop_dir() {
        folders.push(SystemFolder {
            label: "Desktop".into(),
            path: p.to_string_lossy().into_owned(),
            suggested: true,
        });
    }
    if let Some(p) = dirs::document_dir() {
        folders.push(SystemFolder {
            label: "Documents".into(),
            path: p.to_string_lossy().into_owned(),
            suggested: true,
        });
    }
    if let Some(p) = dirs::download_dir() {
        folders.push(SystemFolder {
            label: "Downloads".into(),
            path: p.to_string_lossy().into_owned(),
            suggested: true,
        });
    }
    Ok(folders)
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .map(|p| p.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(picked)
}

#[tauri::command]
pub async fn save_sync_config(
    state: State<'_, AppState>,
    app: AppHandle,
    req: SaveSyncConfigRequest,
) -> Result<(), String> {
    let pairs: Vec<(String, String)> = req
        .folders
        .into_iter()
        .map(|f| (f.path, f.label))
        .collect();

    let folders_changed = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let old: std::collections::HashSet<String> = list_sync_folders(&conn)
            .map_err(|e: crate::error::AppError| e.to_string())?
            .into_iter()
            .map(|f| f.local_path)
            .collect();
        let new: std::collections::HashSet<String> =
            pairs.iter().map(|(p, _)| p.clone()).collect();
        old != new
    };

    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        save_local_sync_folders(&conn, &pairs)
            .map_err(|e: crate::error::AppError| e.to_string())?;
        if folders_changed {
            crate::db::config_set(&conn, "initial_sync_complete", "false")
                .map_err(|e: crate::error::AppError| e.to_string())?;
        }
    }

    let app_handle = app.clone();
    let pairs_bg = pairs.clone();
    let run_initial = folders_changed || !initial_sync_complete(&state.db);
    tauri::async_runtime::spawn(async move {
        let Some(app_state) = app_handle.try_state::<AppState>() else {
            return;
        };
        let Ok(engine) = app_state.sync_engine() else {
            return;
        };
        if let Err(e) = engine.configure_folders(pairs_bg.clone()).await {
            eprintln!("configure_folders after save_sync_config failed: {}", e);
            return;
        }
        let paths: Vec<PathBuf> = pairs_bg
            .into_iter()
            .map(|(p, _)| PathBuf::from(p))
            .collect();
        if let Err(e) = start_sync_services(&app_state, &app_handle, engine, paths, run_initial, true) {
            eprintln!("start_sync_services after save_sync_config failed: {}", e);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn complete_onboarding(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state.mark_onboarding_complete();

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(app_state) = app_handle.try_state::<AppState>() else {
            return;
        };
        if app_state.watcher.lock().is_none() {
            if let Ok(engine) = app_state.sync_engine() {
                if let Err(e) = restart_watcher(&app_state, engine) {
                    eprintln!("restart_watcher after onboarding failed: {}", e);
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn get_sync_status(state: State<'_, AppState>) -> Result<crate::sync::engine::SyncStatus, String> {
    let engine = state.sync_engine().map_err(|e| e.to_string())?;
    Ok(engine.get_status())
}

#[tauri::command]
pub async fn get_sync_activity(state: State<'_, AppState>) -> Result<Vec<crate::db::ActivityRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    list_activity(&conn, 50).map_err(|e: crate::error::AppError| e.to_string())
}

#[tauri::command]
pub async fn get_sync_folders(state: State<'_, AppState>) -> Result<Vec<crate::db::SyncFolderRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    list_sync_folders(&conn).map_err(|e: crate::error::AppError| e.to_string())
}

#[tauri::command]
pub async fn add_sync_folder(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let engine = state.sync_engine().map_err(|e| e.to_string())?;
    let label = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Folder")
        .to_string();

    engine
        .add_sync_folder(&path, &label)
        .await
        .map_err(|e: crate::error::AppError| e.to_string())?;

    let sync_folder_id = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        crate::db::get_sync_folder_by_path(&conn, &path)
            .map_err(|e: crate::error::AppError| e.to_string())?
            .ok_or_else(|| "folder was not saved".to_string())?
            .id
    };

    restart_watcher(&state, engine.clone())?;

    let eng = engine.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = eng.sync_single_folder(sync_folder_id).await {
            eprintln!("sync after add folder failed: {}", e);
        }
    });

    Ok(format!("Added {} to sync", label))
}

#[tauri::command]
pub async fn open_preferences_window(app: AppHandle) -> Result<(), String> {
    let w = app
        .get_webview_window("preferences")
        .ok_or_else(|| "Preferences window is not available".to_string())?;
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn quit_app(app: AppHandle) -> Result<(), String> {
    crate::shutdown_cfapi();
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn remove_sync_folder(
    state: State<'_, AppState>,
    folder_id: i64,
) -> Result<(), String> {
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if !delete_sync_folder(&conn, folder_id).map_err(|e: AppError| e.to_string())? {
            return Err("Sync folder not found".into());
        }
    }

    if let Ok(engine) = state.sync_engine() {
        restart_watcher(&state, engine)?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_sync_mode(state: State<'_, AppState>) -> Result<String, String> {
    Ok(crate::sync::engine::get_sync_mode(&state.db))
}

#[tauri::command]
pub fn set_sync_mode(state: State<'_, AppState>, mode: String) -> Result<(), String> {
    let normalized = if mode == "stream" { "stream" } else { "mirror" };
    crate::sync::engine::set_sync_mode(&state.db, normalized).map_err(|e: AppError| e.to_string())?;

    if normalized == "stream" {
        // Reclaim disk from a previous Mirror: dehydrate My Drive + drop hydrate_cache.
        tauri::async_runtime::spawn(async move {
            crate::my_drive::clear_all_hydrate_cache();
            #[cfg(windows)]
            {
                if let Ok(my_drive) = crate::auth_store::my_drive_path(false) {
                    let freed = crate::cfapi::dehydrate_my_drive_tree(&my_drive);
                    crate::sync::log::sync_log(format!(
                        "switched to stream: dehydrated {} My Drive file(s)",
                        freed
                    ));
                }
            }
        });
    }

    if let Ok(engine) = state.sync_engine() {
        let eng = engine.clone();
        tauri::async_runtime::spawn(async move {
            let _ = eng.poll_my_drive().await;
        });
    }
    Ok(())
}

#[tauri::command]
pub fn get_launch_on_login(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_launch_on_login(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    if enabled {
        app.autolaunch().enable().map_err(|e| e.to_string())
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn open_sync_log_folder(app: AppHandle) -> Result<(), String> {
    let dir = crate::auth_store::data_dir().map_err(|e: AppError| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pause_sync(state: State<'_, AppState>) -> Result<(), String> {
    let engine = state.sync_engine().map_err(|e| e.to_string())?;
    engine.set_paused(true);
    Ok(())
}

#[tauri::command]
pub async fn resume_sync(state: State<'_, AppState>) -> Result<(), String> {
    let engine = state.sync_engine().map_err(|e| e.to_string())?;
    engine.set_paused(false);
    let eng = engine.clone();
    tauri::async_runtime::spawn(async move {
        let _ = eng.clone().run_initial_sync().await;
    });
    Ok(())
}

#[tauri::command]
pub async fn get_explorer_integration_status(
    state: State<'_, AppState>,
) -> Result<ExplorerIntegrationStatus, String> {
    let sync_root = sync_root_dir(false).map_err(|e: crate::error::AppError| e.to_string())?;
    let my_drive = my_drive_path(false).map_err(|e: crate::error::AppError| e.to_string())?;
    let (connected, registered, finalized) =
        crate::cfapi::integration_status(&state.db).map_err(|e| e.to_string())?;
    Ok(ExplorerIntegrationStatus {
        connected,
        registered,
        finalized,
        sync_root_path: sync_root.to_string_lossy().into_owned(),
        my_drive_path: my_drive.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn open_drive_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    crate::cfapi::ensure_connected(&state).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let dir = my_drive_path(false).map_err(|e: crate::error::AppError| e.to_string())?;
    #[cfg(not(windows))]
    let dir = sync_root_dir(false).map_err(|e: crate::error::AppError| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_profile(state: State<'_, AppState>) -> Result<User, String> {
    state
        .api()
        .map_err(|e| e.to_string())?
        .get_me()
        .await
        .map_err(|e: crate::error::AppError| e.to_string())
}

#[tauri::command]
pub async fn get_storage_info(state: State<'_, AppState>) -> Result<StorageInfo, String> {
    state
        .api()
        .map_err(|e| e.to_string())?
        .get_my_storage()
        .await
        .map_err(|e: crate::error::AppError| e.to_string())
}

#[tauri::command]
pub async fn get_shared_with_me(state: State<'_, AppState>) -> Result<Vec<SharedItem>, String> {
    state
        .api()
        .map_err(|e| e.to_string())?
        .get_shared_with_me()
        .await
        .map_err(|e: crate::error::AppError| e.to_string())
}

#[tauri::command]
pub async fn open_server_url(
    state: State<'_, AppState>,
    app: AppHandle,
    path: Option<String>,
) -> Result<(), String> {
    let base = state.api().map_err(|e| e.to_string())?.server_url();
    let url = match path.filter(|p| !p.is_empty()) {
        Some(p) if p.starts_with('#') => format!("{}{}", base, p),
        Some(p) if p.starts_with('/') => format!("{}{}", base, p),
        Some(p) => format!("{}/{}", base.trim_end_matches('/'), p.trim_start_matches('/')),
        None => base,
    };
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| e.to_string())
}

const PROJECT_GITHUB_URL: &str = "https://github.com/marcinx98x/freedrive";

#[tauri::command]
pub async fn open_project_url(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(PROJECT_GITHUB_URL, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_path_in_explorer(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
struct EncryptionKeysExport {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    exported_at: String,
    keys: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct ImportEncryptionKeysResult {
    pub imported: usize,
}

#[derive(Debug, Serialize)]
pub struct ExportEncryptionKeysResult {
    pub exported: usize,
    pub path: String,
}

#[tauri::command]
pub async fn import_encryption_keys(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ImportEncryptionKeysResult, String> {
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("JSON", &["json"])
            .blocking_pick_file()
            .map(|p| p.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    let path = picked.ok_or_else(|| "No file selected".to_string())?;
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let export: EncryptionKeysExport =
        serde_json::from_str(&content).map_err(|e| format!("Invalid key export file: {}", e))?;
    if export.keys.is_empty() {
        return Err("Key export file contains no keys".into());
    }

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let imported = import_file_keys(&conn, &export.keys).map_err(|e| e.to_string())?;
    if imported == 0 {
        return Err("No valid keys found in export file".into());
    }
    Ok(ImportEncryptionKeysResult { imported })
}

#[tauri::command]
pub async fn export_encryption_keys(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ExportEncryptionKeysResult, String> {
    let keys = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        list_all_file_keys(&conn).map_err(|e| e.to_string())?
    };
    if keys.is_empty() {
        return Err("No encryption keys on this device".into());
    }

    let export = EncryptionKeysExport {
        version: 1,
        exported_at: chrono::Utc::now().to_rfc3339(),
        keys: keys.clone(),
    };
    let json =
        serde_json::to_string_pretty(&export).map_err(|e| format!("Failed to encode keys: {}", e))?;

    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("JSON", &["json"])
            .set_file_name("freedrive-encryption-keys.json")
            .blocking_save_file()
            .map(|p| p.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Export cancelled".to_string())?;

    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(ExportEncryptionKeysResult {
        exported: keys.len(),
        path,
    })
}

/// Emergency recovery: disconnect and unregister CfAPI sync root (Windows only).
#[tauri::command]
pub async fn unregister_explorer_integration(state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(windows)]
    return crate::cfapi::unregister(&state);
    #[cfg(not(windows))]
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct CryptoStatus {
    pub unlocked: bool,
    pub server_has_crypto: bool,
    pub needs_recovery: bool,
}

#[derive(Debug, Deserialize)]
struct CryptoAccountStatusResponse {
    has_crypto: bool,
}

#[derive(Debug, Deserialize)]
struct EncryptionKeysListStatus {
    keys: Vec<serde_json::Value>,
}

#[tauri::command]
pub async fn get_crypto_status(state: State<'_, AppState>) -> Result<CryptoStatus, String> {
    let unlocked = if let Ok(Some(auth)) = load_auth().map_err(|e: crate::error::AppError| e.to_string()) {
        let user: serde_json::Value =
            serde_json::from_str(&auth.user_json).map_err(|e| e.to_string())?;
        if let Some(user_id) = user.get("id").and_then(|v| v.as_str()) {
            crate::account_crypto::get_uek(user_id).is_some()
        } else {
            false
        }
    } else {
        false
    };
    let mut server_has_crypto = false;
    let mut needs_recovery = false;
    if let Ok(client) = state.api() {
        if let Ok(raw) = client.get_crypto_account().await {
            if let Ok(account) = serde_json::from_value::<CryptoAccountStatusResponse>(raw) {
                server_has_crypto = account.has_crypto;
                if !account.has_crypto {
                    if let Ok(keys_raw) = client.list_encryption_keys("").await {
                        if let Ok(resp) =
                            serde_json::from_value::<EncryptionKeysListStatus>(keys_raw)
                        {
                            needs_recovery = !resp.keys.is_empty();
                        }
                    }
                }
            }
        }
    }
    Ok(CryptoStatus {
        unlocked,
        server_has_crypto,
        needs_recovery,
    })
}

#[derive(Debug, Deserialize)]
pub struct UnlockCryptoRecoveryRequest {
    pub recovery_code: String,
}

#[tauri::command]
pub async fn unlock_crypto_recovery(
    state: State<'_, AppState>,
    app: AppHandle,
    req: UnlockCryptoRecoveryRequest,
) -> Result<crate::account_crypto::CryptoSyncStats, String> {
    let auth = load_auth()
        .map_err(|e: crate::error::AppError| e.to_string())?
        .ok_or_else(|| "Not logged in".to_string())?;
    let user: serde_json::Value =
        serde_json::from_str(&auth.user_json).map_err(|e| e.to_string())?;
    let user_id = user
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing user id".to_string())?
        .to_string();
    let client = state.api().map_err(|e| e.to_string())?;
    let stats = crate::account_crypto::unlock_with_recovery(
        &client,
        &state.db,
        &user_id,
        &req.recovery_code,
    )
    .await
    .map_err(|e: crate::error::AppError| e.to_string())?;
    emit_crypto_unlocked(&app);
    emit_crypto_sync_stats(&app, &stats);
    Ok(stats)
}

#[derive(Debug, Deserialize)]
pub struct RotateCryptoKeyRequest {
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct RotateCryptoKeyResult {
    pub recovery_code: String,
}

#[tauri::command]
pub async fn rotate_crypto_key(
    state: State<'_, AppState>,
    app: AppHandle,
    req: RotateCryptoKeyRequest,
) -> Result<RotateCryptoKeyResult, String> {
    let auth = load_auth()
        .map_err(|e: crate::error::AppError| e.to_string())?
        .ok_or_else(|| "Not logged in".to_string())?;
    let user: serde_json::Value =
        serde_json::from_str(&auth.user_json).map_err(|e| e.to_string())?;
    let user_id = user
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing user id".to_string())?
        .to_string();
    let client = state.api().map_err(|e| e.to_string())?;
    let recovery_code = crate::account_crypto::rotate_account_key(
        &client,
        &state.db,
        &user_id,
        &req.password,
    )
    .await
    .map_err(|e: crate::error::AppError| e.to_string())?;
    let _ = app.emit("crypto-recovery-setup", recovery_code.clone());
    Ok(RotateCryptoKeyResult { recovery_code })
}
