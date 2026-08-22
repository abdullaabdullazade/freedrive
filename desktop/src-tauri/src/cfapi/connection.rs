use crate::api::ApiClient;
use crate::cfapi::callbacks;
use crate::cfapi::util::path_to_wide;
use crate::db::DbHandle;
use crate::error::{AppError, AppResult};
use crate::sync::log::sync_log;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use windows::core::PCWSTR;
use windows::Win32::Storage::CloudFilters::{
    CfConnectSyncRoot, CfDisconnectSyncRoot, CF_CALLBACK_REGISTRATION,
    CF_CALLBACK_TYPE_CANCEL_FETCH_PLACEHOLDERS, CF_CALLBACK_TYPE_FETCH_DATA,
    CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS, CF_CALLBACK_TYPE_NOTIFY_DELETE,
    CF_CALLBACK_TYPE_NOTIFY_FILE_CLOSE_COMPLETION, CF_CALLBACK_TYPE_NONE, CF_CONNECT_FLAGS,
    CF_CONNECTION_KEY,
};

fn cfapi_connection_log(message: impl AsRef<str>) {
    let line = format!("cfapi: {}", message.as_ref());
    eprintln!("{}", line);
    sync_log(line);
}

pub struct CfConnection {
    pub sync_root: PathBuf,
    pub db: DbHandle,
    pub api: ApiClient,
    pub connection_key: CF_CONNECTION_KEY,
}

static CONNECTION: OnceLock<Mutex<Option<CfConnection>>> = OnceLock::new();

fn connection_slot() -> &'static Mutex<Option<CfConnection>> {
    CONNECTION.get_or_init(|| Mutex::new(None))
}

pub fn connect(db: &DbHandle, sync_root: &std::path::Path, api: ApiClient) -> AppResult<()> {
    {
        let guard = connection_slot().lock().map_err(|e| AppError::msg(e.to_string()))?;
        if guard.is_some() {
            return Ok(());
        }
    }

    callbacks::init_context(db.clone(), sync_root.to_path_buf(), api.clone());

    let sync_root_wide = path_to_wide(sync_root);
    let table = [
        CF_CALLBACK_REGISTRATION {
            Type: CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS,
            Callback: Some(callbacks::fetch_placeholders),
        },
        CF_CALLBACK_REGISTRATION {
            Type: CF_CALLBACK_TYPE_CANCEL_FETCH_PLACEHOLDERS,
            Callback: Some(callbacks::cancel_fetch_placeholders),
        },
        CF_CALLBACK_REGISTRATION {
            Type: CF_CALLBACK_TYPE_FETCH_DATA,
            Callback: Some(callbacks::fetch_data),
        },
        CF_CALLBACK_REGISTRATION {
            Type: CF_CALLBACK_TYPE_NOTIFY_FILE_CLOSE_COMPLETION,
            Callback: Some(callbacks::notify_file_close),
        },
        CF_CALLBACK_REGISTRATION {
            Type: CF_CALLBACK_TYPE_NOTIFY_DELETE,
            Callback: Some(callbacks::notify_delete),
        },
        CF_CALLBACK_REGISTRATION {
            Type: CF_CALLBACK_TYPE_NONE,
            Callback: None,
        },
    ];

    let connection_key = unsafe {
        CfConnectSyncRoot(
            PCWSTR(sync_root_wide.as_ptr()),
            table.as_ptr(),
            None,
            CF_CONNECT_FLAGS(0),
        )
        .map_err(|e| AppError::msg(format!("CfConnectSyncRoot failed: {}", e)))?
    };

    let _ = sync_root_wide;

    let mut guard = connection_slot()
        .lock()
        .map_err(|e| AppError::msg(e.to_string()))?;
    *guard = Some(CfConnection {
        sync_root: sync_root.to_path_buf(),
        db: db.clone(),
        api,
        connection_key,
    });
    cfapi_connection_log(&format!(
        "CfConnectSyncRoot ok path={}",
        sync_root.display()
    ));
    Ok(())
}

pub fn is_connected() -> bool {
    connection_slot()
        .lock()
        .ok()
        .is_some_and(|guard| guard.is_some())
}

pub fn disconnect() {
    if let Ok(mut guard) = connection_slot().lock() {
        if let Some(conn) = guard.take() {
            unsafe {
                let _ = CfDisconnectSyncRoot(conn.connection_key);
            }
        }
    }
    callbacks::clear_context();
}
