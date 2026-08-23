use crate::cfapi::util::{path_to_wide, PROVIDER_ID};
use crate::db::{config_get, config_set, DbHandle};
use crate::error::{AppError, AppResult};
use crate::sync::log::sync_log;
use std::path::Path;
use uuid::Uuid;
use windows::core::PCWSTR;
use windows::Win32::Storage::CloudFilters::{
    CfRegisterSyncRoot, CfUnregisterSyncRoot, CF_HARDLINK_POLICY_NONE, CF_HYDRATION_POLICY,
    CF_HYDRATION_POLICY_MODIFIER, CF_HYDRATION_POLICY_PARTIAL, CF_INSYNC_POLICY_TRACK_ALL,
    CF_PLACEHOLDER_MANAGEMENT_POLICY_DEFAULT, CF_POPULATION_POLICY, CF_POPULATION_POLICY_MODIFIER,
    CF_POPULATION_POLICY_PARTIAL, CF_REGISTER_FLAGS, CF_SYNC_POLICIES, CF_SYNC_REGISTRATION,
};

pub const CF_REGISTERED_KEY: &str = "cf_sync_root_registered";
pub const CF_FINALIZE_COMPLETE_KEY: &str = "cf_finalize_complete";
const CF_IDENTITY_KEY: &str = "cf_sync_root_identity";

/// HRESULT values that indicate the sync root may already be registered in Windows.
pub fn is_recoverable_register_hresult(code: u32) -> bool {
    matches!(
        code,
        0x80070057 // ERROR_INVALID_PARAMETER
            | 0x80070050 // ERROR_FILE_EXISTS
            | 0x800700B7 // ERROR_ALREADY_EXISTS
    )
}

pub fn hresult_code(error: &windows::core::Error) -> u32 {
    error.code().0 as u32
}

fn cfapi_register_log(message: impl AsRef<str>) {
    let line = format!("cfapi: {}", message.as_ref());
    eprintln!("{}", line);
    sync_log(line);
}

pub fn is_registered(db: &DbHandle) -> AppResult<bool> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    Ok(config_get(&conn, CF_REGISTERED_KEY)?.as_deref() == Some("true"))
}

pub fn clear_registration_state(db: &DbHandle) -> AppResult<()> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    config_set(&conn, CF_REGISTERED_KEY, "false")?;
    config_set(&conn, CF_FINALIZE_COMPLETE_KEY, "false")?;
    Ok(())
}

pub fn is_finalize_complete(db: &DbHandle) -> AppResult<bool> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    Ok(config_get(&conn, CF_FINALIZE_COMPLETE_KEY)?.as_deref() == Some("true"))
}

pub fn mark_finalize_complete(db: &DbHandle) -> AppResult<()> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    config_set(&conn, CF_FINALIZE_COMPLETE_KEY, "true")?;
    Ok(())
}

pub fn mark_registered(db: &DbHandle) -> AppResult<()> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    config_set(&conn, CF_REGISTERED_KEY, "true")?;
    Ok(())
}

pub fn sync_root_identity_bytes(db: &DbHandle) -> AppResult<Vec<u8>> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    if let Some(hex) = config_get(&conn, CF_IDENTITY_KEY)? {
        if let Ok(bytes) = hex::decode(hex) {
            if !bytes.is_empty() {
                return Ok(bytes);
            }
        }
    }
    let id = Uuid::new_v4();
    let bytes = id.as_bytes().to_vec();
    let hex = hex::encode(&bytes);
    config_set(&conn, CF_IDENTITY_KEY, &hex)?;
    Ok(bytes)
}

pub fn ensure_registered(db: &DbHandle, sync_root: &Path) -> AppResult<()> {
    if is_registered(db)? {
        return Ok(());
    }

    match register_sync_root(db, sync_root) {
        Ok(()) => mark_registered(db),
        Err(e) if register_error_is_recoverable(&e) => {
            cfapi_register_log(&format!(
                "register failed (recoverable), retrying after unregister: {}",
                e
            ));
            unregister_sync_root(sync_root)?;
            register_sync_root(db, sync_root)?;
            mark_registered(db)
        }
        Err(e) => Err(e),
    }
}

fn register_error_is_recoverable(error: &AppError) -> bool {
    let message = error.to_string();
    message.contains("0x80070057")
        || message.contains("0x80070050")
        || message.contains("0x800700B7")
}

pub fn register_sync_root(db: &DbHandle, sync_root: &Path) -> AppResult<()> {
    let identity = sync_root_identity_bytes(db)?;
    let provider_name = widestring("FreeDrive");
    let provider_version = widestring(env!("CARGO_PKG_VERSION"));
    let sync_root_wide = path_to_wide(sync_root);

    cfapi_register_log(&format!(
        "CfRegisterSyncRoot path={} identity_len={} provider_id={:?}",
        sync_root.display(),
        identity.len(),
        PROVIDER_ID
    ));

    let registration = CF_SYNC_REGISTRATION {
        StructSize: std::mem::size_of::<CF_SYNC_REGISTRATION>() as u32,
        ProviderName: PCWSTR(provider_name.as_ptr()),
        ProviderVersion: PCWSTR(provider_version.as_ptr()),
        SyncRootIdentity: identity.as_ptr() as *const _,
        SyncRootIdentityLength: identity.len() as u32,
        FileIdentity: std::ptr::null(),
        FileIdentityLength: 0,
        ProviderId: PROVIDER_ID,
    };

    let policies = CF_SYNC_POLICIES {
        StructSize: std::mem::size_of::<CF_SYNC_POLICIES>() as u32,
        Hydration: CF_HYDRATION_POLICY {
            Primary: CF_HYDRATION_POLICY_PARTIAL,
            Modifier: CF_HYDRATION_POLICY_MODIFIER(0),
        },
        Population: CF_POPULATION_POLICY {
            Primary: CF_POPULATION_POLICY_PARTIAL,
            Modifier: CF_POPULATION_POLICY_MODIFIER(0),
        },
        InSync: CF_INSYNC_POLICY_TRACK_ALL,
        HardLink: CF_HARDLINK_POLICY_NONE,
        PlaceholderManagement: CF_PLACEHOLDER_MANAGEMENT_POLICY_DEFAULT,
    };

    unsafe {
        CfRegisterSyncRoot(
            PCWSTR(sync_root_wide.as_ptr()),
            &registration,
            &policies,
            CF_REGISTER_FLAGS(0),
        )
        .map_err(|e| {
            let hr = hresult_code(&e);
            cfapi_register_log(&format!(
                "CfRegisterSyncRoot failed path={} hr=0x{:08X}: {}",
                sync_root.display(),
                hr,
                e
            ));
            AppError::msg(format!("CfRegisterSyncRoot failed: {} (0x{:08X})", e, hr))
        })?;
    }

    let _ = (provider_name, provider_version, sync_root_wide, identity);
    Ok(())
}

pub fn unregister_sync_root(sync_root: &Path) -> AppResult<()> {
    let sync_root_wide = path_to_wide(sync_root);
    unsafe {
        CfUnregisterSyncRoot(PCWSTR(sync_root_wide.as_ptr()))
            .map_err(|e| AppError::msg(format!("CfUnregisterSyncRoot failed: {}", e)))?;
    }
    Ok(())
}

fn widestring(s: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recoverable_hresults_include_einval_and_already_exists() {
        assert!(is_recoverable_register_hresult(0x80070057));
        assert!(is_recoverable_register_hresult(0x800700B7));
        assert!(!is_recoverable_register_hresult(0x80070005));
    }

    #[test]
    fn register_error_is_recoverable_from_message() {
        let err = AppError::msg("CfRegisterSyncRoot failed: bad (0x80070057)");
        assert!(register_error_is_recoverable(&err));
        let err = AppError::msg("CfRegisterSyncRoot failed: access denied");
        assert!(!register_error_is_recoverable(&err));
    }
}
