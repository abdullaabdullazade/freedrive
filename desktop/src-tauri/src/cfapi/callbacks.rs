use crate::api::ApiClient;
use crate::cfapi::placeholders::{
    build_placeholder_infos, complete_fetch_placeholders, count_existing_children,
    create_named_folder_placeholder, dehydrate_placeholder_file, ensure_cloud_placeholder,
    filter_new_entries, is_duplicate_placeholder_error, mark_directory_populated,
    transfer_or_complete_fetch, transfer_placeholders_via_callback, PlaceholderEntry,
    MY_DRIVE_FOLDER_NAME,
};
use crate::cfapi::util::parse_file_identity;
use crate::db::DbHandle;
use crate::error::AppResult;
use crate::cfapi::util::{callback_full_path, cf_operation_param_size, notify_directory_updated};
use crate::my_drive::{
    clear_hydrate_cache_for_file, ensure_hydrated_plaintext, fetch_folder_contents,
    is_under_my_drive, relative_path_from_sync_root, resolve_folder_id_for_fetch,
    resolve_my_drive_root_id, FolderIdSource,
};
use crate::sync::log::sync_log;
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{NTSTATUS, STATUS_CLOUD_FILE_UNSUCCESSFUL, STATUS_SUCCESS};
use windows::Win32::Storage::CloudFilters::{
    CfExecute, CF_CALLBACK_INFO, CF_CALLBACK_PARAMETERS, CF_OPERATION_INFO,
    CF_OPERATION_PARAMETERS, CF_OPERATION_PARAMETERS_0, CF_OPERATION_PARAMETERS_0_6,
    CF_OPERATION_TRANSFER_DATA_FLAG_NONE, CF_OPERATION_TYPE_TRANSFER_DATA,
};

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(30);
/// Large My Drive opens (download + decrypt) can take many minutes — do not use the
/// short placeholder timeout. Google Drive for desktop likewise waits for full hydrate.
const HYDRATE_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);

struct CallbackContext {
    sync_root: PathBuf,
    db: DbHandle,
    api: ApiClient,
}

static CONTEXT: OnceLock<Mutex<Option<CallbackContext>>> = OnceLock::new();
static APP_HANDLE: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();
static CANCELLED_PLACEHOLDER_REQUESTS: OnceLock<Mutex<HashSet<i64>>> = OnceLock::new();

#[derive(Clone, Serialize)]
struct HydrateFailedPayload {
    message: String,
    file_id: String,
}

pub fn init_app_handle(app: AppHandle) {
    let slot = APP_HANDLE.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(app);
    }
}

pub fn clear_app_handle() {
    if let Some(slot) = APP_HANDLE.get() {
        if let Ok(mut guard) = slot.lock() {
            *guard = None;
        }
    }
}

fn cancelled_requests() -> &'static Mutex<HashSet<i64>> {
    CANCELLED_PLACEHOLDER_REQUESTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_placeholder_request_cancelled(request_key: i64) -> bool {
    if request_key == 0 {
        return false;
    }
    cancelled_requests()
        .lock()
        .ok()
        .is_some_and(|set| set.contains(&request_key))
}

fn mark_placeholder_request_cancelled(request_key: i64) {
    if request_key == 0 {
        return;
    }
    if let Ok(mut set) = cancelled_requests().lock() {
        set.insert(request_key);
    }
}

fn clear_placeholder_request_cancelled(request_key: i64) {
    if request_key == 0 {
        return;
    }
    if let Ok(mut set) = cancelled_requests().lock() {
        set.remove(&request_key);
    }
}

pub fn init_context(db: DbHandle, sync_root: PathBuf, api: ApiClient) {
    let slot = CONTEXT.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(CallbackContext {
            sync_root,
            db,
            api,
        });
    }
}

pub fn clear_context() {
    if let Some(slot) = CONTEXT.get() {
        if let Ok(mut guard) = slot.lock() {
            *guard = None;
        }
    }
    clear_app_handle();
    if let Ok(mut set) = cancelled_requests().lock() {
        set.clear();
    }
}

fn with_context<F, R>(f: F) -> Option<R>
where
    F: FnOnce(&CallbackContext) -> R,
{
    let slot = CONTEXT.get()?;
    let guard = slot.lock().ok()?;
    guard.as_ref().map(f)
}

fn cfapi_callback_log(message: impl AsRef<str>) {
    let line = format!("cfapi: {}", message.as_ref());
    eprintln!("{}", line);
    sync_log(line);
}

pub fn sync_root_fetch_requires_my_drive_placeholder(relative: &str) -> bool {
    relative.is_empty()
}

fn log_callback_error(kind: &str, error: &str) {
    cfapi_callback_log(&format!("{} error: {}", kind, error));
}

fn folder_id_source_label(source: FolderIdSource) -> &'static str {
    match source {
        FolderIdSource::Identity => "identity",
        FolderIdSource::Database => "database",
        FolderIdSource::RootConfig => "root_config",
    }
}

pub unsafe extern "system" fn fetch_placeholders(
    info: *const CF_CALLBACK_INFO,
    params: *const CF_CALLBACK_PARAMETERS,
) {
    let _ = params;
    if info.is_null() {
        return;
    }
    let info = &*info;

    match std::panic::catch_unwind(|| handle_fetch_placeholders(info)) {
        Ok(Ok(count)) => {
            cfapi_callback_log(&format!("TRANSFER_PLACEHOLDERS ok entries={}", count));
        }
        Ok(Err(e)) => {
            log_callback_error("FETCH_PLACEHOLDERS", &e);
            if let Err(ack_err) = complete_fetch_placeholders(info, 0, 0) {
                log_callback_error("TRANSFER_PLACEHOLDERS", &ack_err.to_string());
            }
        }
        Err(_) => {
            log_callback_error("FETCH_PLACEHOLDERS", "callback panicked");
            if let Err(ack_err) = complete_fetch_placeholders(info, 0, 0) {
                log_callback_error("TRANSFER_PLACEHOLDERS", &ack_err.to_string());
            }
        }
    }

    clear_placeholder_request_cancelled(info.RequestKey);
}

pub unsafe extern "system" fn cancel_fetch_placeholders(
    info: *const CF_CALLBACK_INFO,
    params: *const CF_CALLBACK_PARAMETERS,
) {
    let _ = params;
    if info.is_null() {
        return;
    }
    let info = &*info;
    if info.RequestKey == 0 {
        return;
    }
    mark_placeholder_request_cancelled(info.RequestKey);
    cfapi_callback_log(&format!(
        "CANCEL_FETCH_PLACEHOLDERS request_key={}",
        info.RequestKey
    ));
}

pub unsafe extern "system" fn fetch_data(
    info: *const CF_CALLBACK_INFO,
    params: *const CF_CALLBACK_PARAMETERS,
) {
    if info.is_null() || params.is_null() {
        return;
    }
    let info = &*info;
    let params = &*params;

    let file_id = unsafe {
        let identity = std::slice::from_raw_parts(
            info.FileIdentity as *const u8,
            info.FileIdentityLength as usize,
        );
        parse_file_identity(identity)
            .map(|(_, id)| id)
            .unwrap_or_default()
    };

    let result = std::panic::catch_unwind(|| handle_fetch_data(info, params));
    match result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            log_callback_error("FETCH_DATA", &e);
            emit_hydrate_failed(&e, &file_id);
            if let Err(te) = fail_fetch_data(info, params) {
                log_callback_error("TRANSFER_DATA", &te);
            }
        }
        Err(_) => {
            log_callback_error("FETCH_DATA", "callback panicked");
            if let Err(te) = fail_fetch_data(info, params) {
                log_callback_error("TRANSFER_DATA", &te);
            }
        }
    }
}

fn emit_hydrate_failed(message: &str, file_id: &str) {
    let Some(slot) = APP_HANDLE.get() else {
        return;
    };
    let Ok(guard) = slot.lock() else {
        return;
    };
    let Some(app) = guard.as_ref() else {
        return;
    };
    let _ = app.emit(
        "my-drive-hydrate-failed",
        HydrateFailedPayload {
            message: message.to_string(),
            file_id: file_id.to_string(),
        },
    );
}

fn fail_fetch_data(
    info: &CF_CALLBACK_INFO,
    params: &CF_CALLBACK_PARAMETERS,
) -> Result<(), String> {
    let fetch = unsafe { params.Anonymous.FetchData };
    let offset = fetch.RequiredFileOffset;
    let length = fetch.RequiredLength;
    unsafe {
        transfer_data(info, offset, length, &[], STATUS_CLOUD_FILE_UNSUCCESSFUL)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn handle_fetch_placeholders(info: &CF_CALLBACK_INFO) -> Result<u32, String> {
    if is_placeholder_request_cancelled(info.RequestKey) {
        return unsafe { complete_fetch_placeholders(info, 0, 0).map_err(|e| e.to_string()) };
    }

    let full_path = callback_full_path(info)?;
    let ctx = with_context(|c| (c.sync_root.clone(), c.db.clone(), c.api.clone()))
        .ok_or_else(|| "CfAPI context not initialized".to_string())?;

    let relative = relative_path_from_sync_root(&ctx.0, &full_path)
        .ok_or_else(|| format!("path outside sync root: {}", full_path.display()))?;

    cfapi_callback_log(&format!(
        "FETCH_PLACEHOLDERS relative={:?} path={}",
        relative,
        full_path.display()
    ));

    if sync_root_fetch_requires_my_drive_placeholder(&relative) {
        let folder_id = resolve_my_drive_root_id(&ctx.1).map_err(|e| e.to_string())?;
        let my_drive_path = ctx.0.join(MY_DRIVE_FOLDER_NAME);
        cfapi_callback_log("FETCH_PLACEHOLDERS sync root -> My Drive placeholder");
        if my_drive_path.exists() {
            ensure_cloud_placeholder(&my_drive_path, "folder", &folder_id)
                .map_err(|e| e.to_string())?;
        }
        match create_named_folder_placeholder(&ctx.0, MY_DRIVE_FOLDER_NAME, &folder_id) {
            Ok(()) => {}
            Err(e) if is_duplicate_placeholder_error(&e) => {}
            Err(e) => return Err(e.to_string()),
        }
        let entry = PlaceholderEntry::folder(MY_DRIVE_FOLDER_NAME, &folder_id);
        let count = unsafe {
            transfer_or_complete_fetch(info, std::slice::from_ref(&entry), 1)
                .map_err(|e| e.to_string())?
        };
        cfapi_callback_log(&format!(
            "sync root transfer My Drive entries=1 transferred={}",
            count
        ));
        notify_directory_updated(&ctx.0);
        return Ok(count);
    }

    if !is_under_my_drive(&relative) {
        return unsafe { complete_fetch_placeholders(info, 0, 0).map_err(|e| e.to_string()) };
    }

    let (folder_id, id_source) =
        resolve_folder_id_for_fetch(&ctx.1, info, &relative).map_err(|e| e.to_string())?;
    cfapi_callback_log(&format!(
        "FETCH_PLACEHOLDERS folder_id={:?} source={}",
        folder_id,
        folder_id_source_label(id_source)
    ));

    if is_placeholder_request_cancelled(info.RequestKey) {
        return unsafe { complete_fetch_placeholders(info, 0, 0).map_err(|e| e.to_string()) };
    }

    let sync_root = ctx.0.clone();
    let relative_owned = relative.clone();
    let parent_dir = sync_root.join(relative.replace('\\', std::path::MAIN_SEPARATOR_STR));
    let contents = crate::blocking::run_async_future_with_timeout(
        CALLBACK_TIMEOUT,
        async move {
            fetch_folder_contents(
                &ctx.2,
                &ctx.1,
                &sync_root,
                &relative_owned,
                folder_id.as_deref(),
            )
            .await
            .map_err(|e| e.to_string())
        },
    )?;

    if is_placeholder_request_cancelled(info.RequestKey) {
        return unsafe { complete_fetch_placeholders(info, 0, 0).map_err(|e| e.to_string()) };
    }

    let total = (contents.folders.len() + contents.files.len()) as u32;
    let existing = count_existing_children(&parent_dir, &contents.folders, &contents.files);

    let count = if total == 0 {
        mark_directory_populated(&parent_dir).map_err(|e| e.to_string())?;
        cfapi_callback_log(&format!(
            "mark_directory_populated empty path={}",
            parent_dir.display()
        ));
        unsafe { complete_fetch_placeholders(info, 0, 0).map_err(|e| e.to_string())? };
        0
    } else if existing >= total {
        let entries = build_placeholder_infos(&contents.folders, &contents.files);
        cfapi_callback_log(&format!(
            "subfolder transfer total={} existing={} path={}",
            total,
            existing,
            parent_dir.display()
        ));
        let count = unsafe {
            transfer_or_complete_fetch(info, &entries, total).map_err(|e| e.to_string())?
        };
        if count < total {
            cfapi_callback_log(&format!(
                "subfolder complete_fetch fallback total={} processed={}",
                total, count
            ));
        }
        if let Err(e) = mark_directory_populated(&parent_dir) {
            cfapi_callback_log(&format!(
                "mark_directory_populated warning path={}: {}",
                parent_dir.display(),
                e
            ));
        } else {
            cfapi_callback_log(&format!(
                "mark_directory_populated path={} existing={}",
                parent_dir.display(),
                existing
            ));
        }
        count
    } else {
        let new_entries =
            filter_new_entries(&parent_dir, &contents.folders, &contents.files);
        let stats = crate::cfapi::placeholders::create_placeholders(
            &parent_dir,
            &contents.folders,
            &contents.files,
        )
        .map_err(|e| e.to_string())?;
        cfapi_callback_log(&format!(
            "FETCH_PLACEHOLDERS created {} skipped {} (total {}) under {:?}",
            stats.created,
            stats.skipped_duplicates,
            total,
            relative
        ));
        let transferred = unsafe {
            transfer_placeholders_via_callback(info, &new_entries, total)
                .map_err(|e| e.to_string())?
        };
        cfapi_callback_log(&format!(
            "transfer_placeholders path={} transferred={} total={}",
            parent_dir.display(),
            transferred,
            total
        ));
        transferred
    };

    notify_directory_updated(&parent_dir);
    Ok(count)
}

fn handle_fetch_data(
    info: &CF_CALLBACK_INFO,
    params: &CF_CALLBACK_PARAMETERS,
) -> Result<(), String> {
    let identity = unsafe {
        std::slice::from_raw_parts(
            info.FileIdentity as *const u8,
            info.FileIdentityLength as usize,
        )
    };
    let (item_type, remote_id) = parse_file_identity(identity)
        .ok_or_else(|| "invalid file identity".to_string())?;
    if item_type != "file" {
        return Err("FETCH_DATA on non-file".into());
    }

    let ctx = with_context(|c| (c.db.clone(), c.api.clone()))
        .ok_or_else(|| "CfAPI context not initialized".to_string())?;

    let cache_path = crate::blocking::run_async_future_with_timeout(
        HYDRATE_TIMEOUT,
        async move {
            ensure_hydrated_plaintext(&ctx.1, &ctx.0, &remote_id)
                .await
                .map_err(|e| e.to_string())
        },
    )?;

    let fetch = unsafe { params.Anonymous.FetchData };
    let offset = fetch.RequiredFileOffset;
    let length = fetch.RequiredLength as usize;
    let offset_usize = offset as usize;

    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(&cache_path).map_err(|e| e.to_string())?;
    let file_len = file.metadata().map_err(|e| e.to_string())?.len() as usize;
    if offset_usize > file_len {
        return Err("fetch offset beyond file".into());
    }
    let end = (offset_usize + length).min(file_len);
    let need = end - offset_usize;
    file.seek(SeekFrom::Start(offset as u64))
        .map_err(|e| e.to_string())?;
    let mut chunk = vec![0u8; need];
    file.read_exact(&mut chunk).map_err(|e| e.to_string())?;

    unsafe { transfer_data(info, offset, chunk.len() as i64, &chunk, STATUS_SUCCESS)? };
    Ok(())
}

unsafe fn transfer_data(
    info: &CF_CALLBACK_INFO,
    offset: i64,
    length: i64,
    buffer: &[u8],
    status: NTSTATUS,
) -> AppResult<()> {
    let op_info = CF_OPERATION_INFO {
        StructSize: std::mem::size_of::<CF_OPERATION_INFO>() as u32,
        Type: CF_OPERATION_TYPE_TRANSFER_DATA,
        ConnectionKey: info.ConnectionKey,
        TransferKey: info.TransferKey,
        CorrelationVector: info.CorrelationVector,
        RequestKey: info.RequestKey,
        SyncStatus: std::ptr::null(),
    };
    let mut op_params = CF_OPERATION_PARAMETERS {
        ParamSize: cf_operation_param_size::<CF_OPERATION_PARAMETERS_0_6>(),
        Anonymous: CF_OPERATION_PARAMETERS_0 {
            TransferData: CF_OPERATION_PARAMETERS_0_6 {
                Flags: CF_OPERATION_TRANSFER_DATA_FLAG_NONE,
                CompletionStatus: status,
                Buffer: buffer.as_ptr() as *const _,
                Offset: offset,
                Length: length,
            },
        },
    };
    CfExecute(&op_info, &mut op_params)
        .map_err(|e| crate::error::AppError::msg(format!("CfExecute TRANSFER_DATA: {}", e)))
}

fn path_is_under_my_drive(sync_root: &std::path::Path, full: &std::path::Path) -> bool {
    relative_path_from_sync_root(sync_root, full)
        .as_deref()
        .is_some_and(is_under_my_drive)
}

pub unsafe extern "system" fn notify_file_close(
    info: *const CF_CALLBACK_INFO,
    _params: *const CF_CALLBACK_PARAMETERS,
) {
    if info.is_null() {
        return;
    }
    let info = &*info;
    let _ = std::panic::catch_unwind(|| handle_notify_file_close(info));
}

fn handle_notify_file_close(info: &CF_CALLBACK_INFO) -> Result<(), String> {
    let full = callback_full_path(info).map_err(|e| e.to_string())?;
    if !full.is_file() {
        return Ok(());
    }
    let file_name = full
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    if crate::sync::should_skip_file(file_name) {
        return Ok(());
    }
    let (api, db, sync_root) = with_context(|ctx| {
        (ctx.api.clone(), ctx.db.clone(), ctx.sync_root.clone())
    })
    .ok_or_else(|| "cfapi context missing".to_string())?;
    if !path_is_under_my_drive(&sync_root, &full) {
        return Ok(());
    }

    let remote_id = unsafe {
        let identity = std::slice::from_raw_parts(
            info.FileIdentity as *const u8,
            info.FileIdentityLength as usize,
        );
        parse_file_identity(identity)
            .filter(|(ty, _)| ty == "file")
            .map(|(_, id)| id)
    }
    .or_else(|| {
        let relative = relative_path_from_sync_root(&sync_root, &full)?;
        let conn = db.lock().ok()?;
        crate::db::my_drive_get_placeholder(&conn, &relative)
            .ok()
            .flatten()
            .filter(|(_, item_type)| item_type == "file")
            .map(|(id, _)| id)
    });

    let stream_mode = crate::sync::engine::sync_mode_is_stream(&db);
    cfapi_callback_log(&format!(
        "NOTIFY_FILE_CLOSE {} stream={} remote={:?}",
        full.display(),
        stream_mode,
        remote_id
    ));

    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::my_drive::upload_my_drive_path(&api, &db, &full).await {
            cfapi_callback_log(&format!("NOTIFY_FILE_CLOSE upload failed: {}", e));
        }
        if !stream_mode {
            return;
        }
        if let Some(ref id) = remote_id {
            clear_hydrate_cache_for_file(id);
        }
        // Brief delay so editors release the handle before dehydrate.
        tokio::time::sleep(Duration::from_millis(400)).await;
        match dehydrate_placeholder_file(&full) {
            Ok(()) => cfapi_callback_log(&format!(
                "NOTIFY_FILE_CLOSE dehydrated {}",
                full.display()
            )),
            Err(e) => cfapi_callback_log(&format!(
                "NOTIFY_FILE_CLOSE dehydrate skipped {}: {}",
                full.display(),
                e
            )),
        }
    });
    Ok(())
}

pub unsafe extern "system" fn notify_delete(
    info: *const CF_CALLBACK_INFO,
    _params: *const CF_CALLBACK_PARAMETERS,
) {
    if info.is_null() {
        return;
    }
    let info = &*info;
    let _ = std::panic::catch_unwind(|| handle_notify_delete(info));
}

fn handle_notify_delete(info: &CF_CALLBACK_INFO) -> Result<(), String> {
    let full = callback_full_path(info).map_err(|e| e.to_string())?;
    let (api, db, sync_root) = with_context(|ctx| {
        (ctx.api.clone(), ctx.db.clone(), ctx.sync_root.clone())
    })
    .ok_or_else(|| "cfapi context missing".to_string())?;
    if !path_is_under_my_drive(&sync_root, &full) {
        return Ok(());
    }
    cfapi_callback_log(&format!("NOTIFY_DELETE {}", full.display()));
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::my_drive::delete_my_drive_path(&api, &db, &full).await {
            cfapi_callback_log(&format!("NOTIFY_DELETE failed: {}", e));
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_root_requires_my_drive_placeholder() {
        assert!(sync_root_fetch_requires_my_drive_placeholder(""));
        assert!(!sync_root_fetch_requires_my_drive_placeholder("My Drive"));
    }

    #[test]
    fn cancel_ignored_for_request_key_zero() {
        assert!(!is_placeholder_request_cancelled(0));
        mark_placeholder_request_cancelled(0);
        assert!(!is_placeholder_request_cancelled(0));
    }
}
