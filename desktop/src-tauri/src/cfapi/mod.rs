#[cfg(windows)]
mod callbacks;
#[cfg(windows)]
pub use callbacks::init_app_handle;
#[cfg(windows)]
mod connection;
#[cfg(windows)]
mod placeholders;
#[cfg(windows)]
pub use placeholders::{
    convert_file_to_placeholder, create_file_placeholder, create_named_folder_placeholder,
    dehydrate_my_drive_tree, dehydrate_placeholder_file, ensure_cloud_placeholder,
    is_dehydrated_placeholder, is_duplicate_placeholder_error, is_not_cloud_file_error,
    mark_directory_partially_populated, MY_DRIVE_FOLDER_NAME,
};
#[cfg(windows)]
mod register;
#[cfg(windows)]
mod shell_register;
#[cfg(windows)]
pub use shell_register::refresh_offline_context_menu;
#[cfg(windows)]
mod util;
#[cfg(windows)]
pub use util::notify_directory_updated;

#[cfg(windows)]
use crate::api::ApiClient;
#[cfg(windows)]
use crate::db::DbHandle;
#[cfg(windows)]
use crate::state::AppState;
#[cfg(windows)]
use crate::sync::log::sync_log;
#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
fn cfapi_log(message: impl AsRef<str>) {
    let line = format!("cfapi: {}", message.as_ref());
    eprintln!("{}", line);
    sync_log(line);
}

/// Register sync root, connect callbacks, and ensure My Drive placeholder (blocking).
#[cfg(windows)]
pub fn start(state: &AppState) -> Result<(), String> {
    let api = state.api().map_err(|e| e.to_string())?;
    let db = &state.db;

    let registered = register::is_registered(db).map_err(|e| e.to_string())?;
    let finalized = register::is_finalize_complete(db).map_err(|e| e.to_string())?;

    if connection::is_connected() && finalized {
        return Ok(());
    }

    if connection::is_connected() && !finalized {
        let sync_root = crate::auth_store::sync_root_dir(false).map_err(|e| e.to_string())?;
        cfapi_log("resuming finalize after incomplete start");
        return complete_connect_finalize(db, &sync_root, api);
    }

    if !connection::is_connected() && registered {
        let sync_root = crate::auth_store::sync_root_dir(false).map_err(|e| e.to_string())?;
        cfapi_log("reconnecting to registered sync root");
        return connect_and_finalize(db, &sync_root, api);
    }

    match start_inner(db, api) {
        Ok(()) => Ok(()),
        Err(e) => {
            if !connection::is_connected() {
                connection::disconnect();
            }
            cfapi_log(&format!("start failed: {}", e));
            Err(e)
        }
    }
}

/// Start CfAPI and verify the provider is connected (retries once on failure).
#[cfg(windows)]
pub fn ensure_connected(state: &AppState) -> Result<(), String> {
    start(state)?;
    if connection::is_connected() {
        return Ok(());
    }
    cfapi_log("provider not connected after start, retrying connect");
    connection::disconnect();
    start(state)?;
    if !connection::is_connected() {
        return Err(
            "Could not connect File Explorer integration. Restart the app or run recovery."
                .into(),
        );
    }
    Ok(())
}

#[cfg(windows)]
pub fn is_connected() -> bool {
    connection::is_connected()
}

#[cfg(windows)]
pub fn integration_status(db: &DbHandle) -> Result<(bool, bool, bool), String> {
    let registered = register::is_registered(db).map_err(|e| e.to_string())?;
    let finalized = register::is_finalize_complete(db).map_err(|e| e.to_string())?;
    Ok((connection::is_connected(), registered, finalized))
}

#[cfg(windows)]
fn start_inner(db: &DbHandle, api: ApiClient) -> Result<(), String> {
    let sync_root = crate::auth_store::sync_root_dir(false).map_err(|e| e.to_string())?;
    let registered = register::is_registered(db).map_err(|e| e.to_string())?;

    if registered {
        connect_and_finalize(db, &sync_root, api)?;
        return Ok(());
    }

    if try_recover_existing_registration(db, &sync_root, api.clone())? {
        return Ok(());
    }

    let sync_root = crate::auth_store::sync_root_dir(true).map_err(|e| e.to_string())?;
    register::ensure_registered(db, &sync_root).map_err(|e| e.to_string())?;
    connection::connect(db, &sync_root, api.clone()).map_err(|e| e.to_string())?;
    complete_connect_finalize(db, &sync_root, api)?;

    Ok(())
}

#[cfg(windows)]
fn connect_and_finalize(
    db: &DbHandle,
    sync_root: &std::path::Path,
    api: ApiClient,
) -> Result<(), String> {
    connection::connect(db, sync_root, api.clone()).map_err(|e| e.to_string())?;
    complete_connect_finalize(db, sync_root, api)
}

#[cfg(windows)]
fn try_recover_existing_registration(
    db: &DbHandle,
    sync_root: &std::path::Path,
    api: ApiClient,
) -> Result<bool, String> {
    match connection::connect(db, sync_root, api.clone()) {
        Ok(()) => {
            register::mark_registered(db).map_err(|e| e.to_string())?;
            cfapi_log("recovered existing OS registration");
            complete_connect_finalize(db, sync_root, api)?;
            Ok(true)
        }
        Err(e) => {
            cfapi_log(&format!("connect-first recovery skipped: {}", e));
            connection::disconnect();
            Ok(false)
        }
    }
}

/// After CfConnectSyncRoot: placeholder, mark ready, prefetch in background.
#[cfg(windows)]
fn complete_connect_finalize(
    db: &DbHandle,
    sync_root: &std::path::Path,
    api: ApiClient,
) -> Result<(), String> {
    use crate::cfapi::placeholders::MY_DRIVE_FOLDER_NAME;

    ensure_my_drive_placeholder(db, sync_root)?;
    let my_drive_path = sync_root.join(MY_DRIVE_FOLDER_NAME);
    util::notify_directory_updated(sync_root);
    util::notify_directory_updated(&my_drive_path);

    let already_finalized = register::is_finalize_complete(db).map_err(|e| e.to_string())?;
    if already_finalized {
        cfapi_log("reconnected to existing sync root");
    } else {
        register::mark_finalize_complete(db).map_err(|e| e.to_string())?;
    }

    // Branded Explorer navigation pane entry (Google Drive–style). Best-effort only —
    // must not break CfAPI connect / 0x80070057 recovery.
    match shell_register::ensure_shell_registered(db, sync_root) {
        Ok(()) => {
            util::notify_shell_updated();
            cfapi_log("shell SyncRootManager registered / refreshed");
        }
        Err(e) => cfapi_log(&format!("shell register warning: {}", e)),
    }

    cfapi_log("explorer integration started");

    spawn_prefetch_my_drive(db.clone(), sync_root.to_path_buf(), api);
    Ok(())
}

#[cfg(windows)]
fn spawn_prefetch_my_drive(db: DbHandle, sync_root: PathBuf, api: ApiClient) {
    std::thread::spawn(move || {
        cfapi_log("prefetch My Drive started");
        let started = std::time::Instant::now();
        match prefetch_my_drive_contents(&db, &sync_root, api) {
            Ok(()) => cfapi_log(&format!(
                "prefetch My Drive finished in {}ms",
                started.elapsed().as_millis()
            )),
            Err(e) => cfapi_log(&format!("prefetch My Drive failed: {}", e)),
        }
    });
}

#[cfg(windows)]
fn ensure_my_drive_placeholder(
    db: &DbHandle,
    sync_root: &std::path::Path,
) -> Result<(), String> {
    use crate::cfapi::placeholders::{
        create_named_folder_placeholder, ensure_cloud_placeholder, is_duplicate_placeholder_error,
        MY_DRIVE_FOLDER_NAME,
    };
    use crate::my_drive::resolve_my_drive_root_id;

    let remote_id = resolve_my_drive_root_id(db).map_err(|e| e.to_string())?;
    let my_drive_path = sync_root.join(MY_DRIVE_FOLDER_NAME);
    match create_named_folder_placeholder(sync_root, MY_DRIVE_FOLDER_NAME, &remote_id) {
        Ok(()) => {
            cfapi_log("My Drive placeholder created");
            Ok(())
        }
        Err(e) if is_duplicate_placeholder_error(&e) => {
            cfapi_log("My Drive placeholder already exists");
            ensure_cloud_placeholder(&my_drive_path, "folder", &remote_id)
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(windows)]
fn prefetch_my_drive_contents(
    db: &DbHandle,
    sync_root: &std::path::Path,
    api: ApiClient,
) -> Result<(), String> {
    use crate::cfapi::placeholders::{create_placeholders, MY_DRIVE_FOLDER_NAME};

    let db = db.clone();
    let sync_root_buf = sync_root.to_path_buf();
    let my_drive_path = sync_root_buf.join(MY_DRIVE_FOLDER_NAME);
    let result = match crate::blocking::run_async_future_with_timeout(
        Duration::from_secs(30),
        async move {
            crate::my_drive::fetch_folder_contents(
                &api,
                &db,
                &sync_root_buf,
                MY_DRIVE_FOLDER_NAME,
                None,
            )
            .await
            .map_err(|e| e.to_string())
        },
    ) {
        Ok(contents) => contents,
        Err(e) => {
            cfapi_log(&format!("prefetch My Drive skipped: {}", e));
            util::notify_directory_updated(&my_drive_path);
            return Ok(());
        }
    };

    let folder_count = result.folders.len();
    let file_count = result.files.len();
    if folder_count == 0 && file_count == 0 {
        cfapi_log("prefetched 0 folders, 0 files in My Drive");
        util::notify_directory_updated(&my_drive_path);
        return Ok(());
    }
    let stats = create_placeholders(&my_drive_path, &result.folders, &result.files)
        .map_err(|e| e.to_string())?;
    cfapi_log(&format!(
        "prefetched {} folders, {} files in My Drive ({} placeholders created, {} skipped as existing)",
        folder_count,
        file_count,
        stats.created,
        stats.skipped_duplicates
    ));
    util::notify_directory_updated(&my_drive_path);
    Ok(())
}

/// Disconnect from sync root (keeps registration for next login).
#[cfg(windows)]
pub fn stop() {
    connection::disconnect();
}

/// Unregister sync root and clear local registration state.
#[cfg(windows)]
pub fn unregister(state: &AppState) -> Result<(), String> {
    stop();
    let sync_root = crate::auth_store::sync_root_dir(false).map_err(|e| e.to_string())?;
    let registered = register::is_registered(&state.db).map_err(|e| e.to_string())?;
    if !registered {
        cfapi_log("sync root not registered in local state, skipping unregister");
        return Ok(());
    }

    if shell_register::is_shell_registered(&state.db).unwrap_or(false) {
        if let Err(e) = shell_register::unregister_shell(&state.db) {
            cfapi_log(&format!("shell unregister warning: {}", e));
        }
    }
    shell_register::purge_all_freedrive_shell_entries();
    util::notify_shell_updated();

    register::unregister_sync_root(&sync_root).map_err(|e| {
        let msg = format!(
            "unregister failed: {} (local DB flag kept; run recovery or restart app)",
            e
        );
        cfapi_log(&msg);
        msg
    })?;
    register::clear_registration_state(&state.db).map_err(|e| e.to_string())?;
    cfapi_log("sync root unregistered");
    Ok(())
}

/// Best-effort CfAPI teardown for NSIS `--uninstall-cleanup` (tries even if DB flag is stale).
#[cfg(windows)]
pub fn unregister_for_uninstall(db: &crate::db::DbHandle) {
    stop();
    let Ok(sync_root) = crate::auth_store::sync_root_dir(false) else {
        // Still purge shell keys so the Explorer nav entry disappears.
        shell_register::purge_all_freedrive_shell_entries();
        util::notify_shell_updated();
        return;
    };
    if let Err(e) = shell_register::unregister_shell(db) {
        cfapi_log(&format!("uninstall shell unregister warning: {}", e));
    }
    // Always wipe any leftover FreeDrive!* SyncRootManager keys (stale DB flags).
    shell_register::purge_all_freedrive_shell_entries();
    util::notify_shell_updated();
    if let Err(e) = register::unregister_sync_root(&sync_root) {
        cfapi_log(&format!("uninstall unregister sync root: {}", e));
    }
    let _ = register::clear_registration_state(db);
    let _ = shell_register::clear_shell_registration_state(db);
    cfapi_log("uninstall: sync root unregister attempted");
}

#[cfg(not(windows))]
use crate::state::AppState;

#[cfg(not(windows))]
pub fn start(_state: &AppState) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub fn stop() {}

#[cfg(not(windows))]
pub fn unregister(_state: &AppState) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub fn ensure_connected(_state: &AppState) -> Result<(), String> {
    Err("File Explorer integration is only available on Windows".into())
}

#[cfg(not(windows))]
pub fn is_connected() -> bool {
    false
}

#[cfg(not(windows))]
pub fn integration_status(_db: &crate::db::DbHandle) -> Result<(bool, bool, bool), String> {
    Ok((false, false, false))
}
