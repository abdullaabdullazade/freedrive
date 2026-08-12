use crate::cfapi::register::sync_root_identity_bytes;
use crate::db::{config_get, config_set, DbHandle};
use crate::error::{AppError, AppResult};
use crate::sync::log::sync_log;
use std::path::{Path, PathBuf};
use winreg::enums::*;
use winreg::{HKEY, RegKey, RegValue};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub const CF_SHELL_REGISTERED_KEY: &str = "cf_shell_registered";

const SHELL_PROVIDER_NAME: &str = "FreeDrive";
const SHELL_ACCOUNT_FALLBACK: &str = "default";

/// Stable Explorer namespace CLSID (separate from CfAPI PROVIDER_ID).
const SHELL_NAMESPACE_CLSID: &str = "{FD9A2B3C-4D5E-6F70-8899-AABBCCDDEE01}";
/// Shell folder instance object (Microsoft cloud-storage integration docs).
const SHELL_FOLDER_INSTANCE_CLSID: &str = "{0E5AAE11-A475-4c5b-AB00-C66DE400274E}";

const SYNC_ROOT_MANAGER_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager";
const CLSID_KEY: &str = r"Software\Classes\CLSID";
const DESKTOP_NAMESPACE_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace";
const HIDE_DESKTOP_ICONS_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\HideDesktopIcons\NewStartPanel";

fn shell_log(message: impl AsRef<str>) {
    let line = format!("cfapi: {}", message.as_ref());
    eprintln!("{}", line);
    sync_log(line);
}

pub fn is_shell_registered(db: &DbHandle) -> AppResult<bool> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    Ok(config_get(&conn, CF_SHELL_REGISTERED_KEY)?.as_deref() == Some("true"))
}

fn mark_shell_registered(db: &DbHandle) -> AppResult<()> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    config_set(&conn, CF_SHELL_REGISTERED_KEY, "true")?;
    Ok(())
}

pub fn clear_shell_registration_state(db: &DbHandle) -> AppResult<()> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    config_set(&conn, CF_SHELL_REGISTERED_KEY, "false")?;
    Ok(())
}

pub fn sync_root_shell_id(db: &DbHandle) -> AppResult<String> {
    let account = shell_account_id(db)?;
    let sid = current_user_sid_string()?;
    Ok(format!("{}!{}!{}", SHELL_PROVIDER_NAME, sid, account))
}

fn shell_account_id(db: &DbHandle) -> AppResult<String> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    Ok(config_get(&conn, "last_user_id")?.unwrap_or_else(|| SHELL_ACCOUNT_FALLBACK.to_string()))
}

fn current_user_sid_string() -> AppResult<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| AppError::msg(format!("OpenProcessToken failed: {}", e)))?;

        let mut size = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
        if size == 0 {
            return Err(AppError::msg("GetTokenInformation size query failed"));
        }

        let mut buffer = vec![0u8; size as usize];
        GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr() as *mut _),
            size,
            &mut size,
        )
        .map_err(|e| AppError::msg(format!("GetTokenInformation failed: {}", e)))?;

        let token_user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut sid_string = windows::core::PWSTR::null();
        ConvertSidToStringSidW(token_user.User.Sid, &mut sid_string)
            .map_err(|e| AppError::msg(format!("ConvertSidToStringSidW failed: {}", e)))?;
        let sid = sid_string.to_string().map_err(|e| AppError::msg(e.to_string()))?;
        let _ = windows::Win32::Foundation::LocalFree(windows::Win32::Foundation::HLOCAL(
            sid_string.0 as _,
        ));
        Ok(sid)
    }
}

fn icon_resource_path() -> String {
    // Prefer the running binary (NSIS/Tauri embeds icon at index 0).
    if let Ok(exe) = std::env::current_exe() {
        if exe.is_file() {
            return format!("{},0", exe.display());
        }
        if let Some(parent) = exe.parent() {
            let bundled = parent.join("icons").join("icon.ico");
            if bundled.exists() {
                return format!("{},0", bundled.display());
            }
        }
    }

    let dev_icon = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("icons")
        .join("icon.ico");
    if dev_icon.exists() {
        return format!("{},0", dev_icon.display());
    }

    "%SystemRoot%\\System32\\imageres.dll,-189".to_string()
}

fn provider_id_string() -> String {
    "{fd9a2b3c-4d5e-6f70-8899-aabbccddeeff}".to_string()
}

fn is_access_denied(error: &AppError) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("access is denied") || message.contains("os error 5")
}

fn sync_root_key_exists(hive: HKEY, sync_root_id: &str) -> bool {
    let hk = RegKey::predef(hive);
    let key_path = format!("{}\\{}", SYNC_ROOT_MANAGER_KEY, sync_root_id);
    hk.open_subkey(&key_path).is_ok()
}

fn sync_root_registry_valid(sync_root_id: &str, sid: &str) -> bool {
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let hk = RegKey::predef(hive);
        let key_path = format!("{}\\{}", SYNC_ROOT_MANAGER_KEY, sync_root_id);
        if let Ok(root) = hk.open_subkey(&key_path) {
            if let Ok(user_sync) = root.open_subkey("UserSyncRoots") {
                if user_sync.get_value::<String, _>(sid).is_ok() {
                    return true;
                }
            }
        }
    }
    false
}

fn write_sync_root_registry_to_hive(
    hive: HKEY,
    sync_root_id: &str,
    sync_root: &Path,
    identity: &[u8],
    sid: &str,
) -> AppResult<()> {
    let hk = RegKey::predef(hive);
    let manager = hk
        .create_subkey(SYNC_ROOT_MANAGER_KEY)
        .map_err(|e| AppError::msg(format!("open SyncRootManager failed: {}", e)))?
        .0;

    let root_key = manager
        .create_subkey(sync_root_id)
        .map_err(|e| AppError::msg(format!("create sync root key failed: {}", e)))?
        .0;

    let icon = icon_resource_path();
    root_key
        .set_value("DisplayNameResource", &SHELL_PROVIDER_NAME)
        .map_err(|e| AppError::msg(format!("set DisplayNameResource failed: {}", e)))?;
    root_key
        .set_value("IconResource", &icon)
        .map_err(|e| AppError::msg(format!("set IconResource failed: {}", e)))?;
    root_key
        .set_value("ProviderId", &provider_id_string())
        .map_err(|e| AppError::msg(format!("set ProviderId failed: {}", e)))?;
    root_key
        .set_value("Version", &format!("{}.0.0", env!("CARGO_PKG_VERSION")))
        .map_err(|e| AppError::msg(format!("set Version failed: {}", e)))?;
    root_key
        .set_raw_value(
            "Context",
            &RegValue {
                vtype: REG_BINARY,
                bytes: identity.to_vec(),
            },
        )
        .map_err(|e| AppError::msg(format!("set Context failed: {}", e)))?;

    let user_sync_roots = root_key
        .create_subkey("UserSyncRoots")
        .map_err(|e| AppError::msg(format!("create UserSyncRoots failed: {}", e)))?
        .0;
    let path_str = sync_root.to_string_lossy().to_string();
    user_sync_roots
        .set_value(sid, &path_str)
        .map_err(|e| AppError::msg(format!("set UserSyncRoots path failed: {}", e)))?;

    Ok(())
}

fn write_sync_root_registry(
    sync_root_id: &str,
    sync_root: &Path,
    identity: &[u8],
) -> AppResult<()> {
    let sid = current_user_sid_string()?;

    // Prefer updating the hive that already hosts this sync root (CfAPI often writes HKLM).
    if sync_root_key_exists(HKEY_LOCAL_MACHINE, sync_root_id) {
        match write_sync_root_registry_to_hive(
            HKEY_LOCAL_MACHINE,
            sync_root_id,
            sync_root,
            identity,
            &sid,
        ) {
            Ok(()) => {
                shell_log("shell registry refreshed in existing HKLM key");
                return Ok(());
            }
            Err(e) if is_access_denied(&e) => {
                shell_log("HKLM refresh denied, trying HKCU");
            }
            Err(e) => return Err(e),
        }
    } else if sync_root_key_exists(HKEY_CURRENT_USER, sync_root_id) {
        write_sync_root_registry_to_hive(
            HKEY_CURRENT_USER,
            sync_root_id,
            sync_root,
            identity,
            &sid,
        )?;
        shell_log("shell registry refreshed in existing HKCU key");
        return Ok(());
    }

    match write_sync_root_registry_to_hive(
        HKEY_LOCAL_MACHINE,
        sync_root_id,
        sync_root,
        identity,
        &sid,
    ) {
        Ok(()) => {
            shell_log("shell registry written to HKLM");
            Ok(())
        }
        Err(e) if is_access_denied(&e) => {
            shell_log("HKLM shell registry denied, falling back to HKCU");
            write_sync_root_registry_to_hive(
                HKEY_CURRENT_USER,
                sync_root_id,
                sync_root,
                identity,
                &sid,
            )?;
            shell_log("shell registry written to HKCU");
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn set_expand_sz(key: &RegKey, name: &str, value: &str) -> AppResult<()> {
    let mut bytes: Vec<u8> = value
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    bytes.extend_from_slice(&[0, 0]);
    key.set_raw_value(
        name,
        &RegValue {
            vtype: REG_EXPAND_SZ,
            bytes,
        },
    )
    .map_err(|e| AppError::msg(format!("set {} failed: {}", name, e)))
}

/// Pin FreeDrive in Explorer's left navigation pane (Microsoft cloud-storage CLSID recipe).
fn ensure_namespace_pinned(sync_root: &Path) -> AppResult<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let clsid_path = format!("{}\\{}", CLSID_KEY, SHELL_NAMESPACE_CLSID);
    let clsid = hkcu
        .create_subkey(&clsid_path)
        .map_err(|e| AppError::msg(format!("create CLSID failed: {}", e)))?
        .0;

    clsid
        .set_value("", &SHELL_PROVIDER_NAME)
        .map_err(|e| AppError::msg(format!("set CLSID name failed: {}", e)))?;
    clsid
        .set_value("System.IsPinnedToNameSpaceTree", &1u32)
        .map_err(|e| AppError::msg(format!("set IsPinnedToNameSpaceTree failed: {}", e)))?;
    clsid
        .set_value("SortOrderIndex", &0x42u32)
        .map_err(|e| AppError::msg(format!("set SortOrderIndex failed: {}", e)))?;

    let default_icon = clsid
        .create_subkey("DefaultIcon")
        .map_err(|e| AppError::msg(format!("create DefaultIcon failed: {}", e)))?
        .0;
    // Same form as SyncRootManager IconResource: "{exe},0"
    set_expand_sz(&default_icon, "", &icon_resource_path())?;

    let inproc = clsid
        .create_subkey("InProcServer32")
        .map_err(|e| AppError::msg(format!("create InProcServer32 failed: {}", e)))?
        .0;
    set_expand_sz(&inproc, "", r"%systemroot%\system32\shell32.dll")?;

    let instance = clsid
        .create_subkey("Instance")
        .map_err(|e| AppError::msg(format!("create Instance failed: {}", e)))?
        .0;
    instance
        .set_value("CLSID", &SHELL_FOLDER_INSTANCE_CLSID)
        .map_err(|e| AppError::msg(format!("set Instance CLSID failed: {}", e)))?;

    let init = instance
        .create_subkey("InitPropertyBag")
        .map_err(|e| AppError::msg(format!("create InitPropertyBag failed: {}", e)))?
        .0;
    // FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_READONLY
    init.set_value("Attributes", &0x11u32)
        .map_err(|e| AppError::msg(format!("set Attributes failed: {}", e)))?;
    set_expand_sz(
        &init,
        "TargetFolderPath",
        &sync_root.to_string_lossy(),
    )?;

    let shell_folder = clsid
        .create_subkey("ShellFolder")
        .map_err(|e| AppError::msg(format!("create ShellFolder failed: {}", e)))?
        .0;
    shell_folder
        .set_value("FolderValueFlags", &0x28u32)
        .map_err(|e| AppError::msg(format!("set FolderValueFlags failed: {}", e)))?;
    // SFGAO flags from MS cloud storage integration docs
    shell_folder
        .set_value("Attributes", &0xF080004Du32)
        .map_err(|e| AppError::msg(format!("set ShellFolder Attributes failed: {}", e)))?;

    let ns = hkcu
        .create_subkey(&format!("{}\\{}", DESKTOP_NAMESPACE_KEY, SHELL_NAMESPACE_CLSID))
        .map_err(|e| AppError::msg(format!("create Desktop\\NameSpace failed: {}", e)))?
        .0;
    ns.set_value("", &SHELL_PROVIDER_NAME)
        .map_err(|e| AppError::msg(format!("set NameSpace name failed: {}", e)))?;

    let hide = hkcu
        .create_subkey(HIDE_DESKTOP_ICONS_KEY)
        .map_err(|e| AppError::msg(format!("create HideDesktopIcons failed: {}", e)))?
        .0;
    hide.set_value(SHELL_NAMESPACE_CLSID, &1u32)
        .map_err(|e| AppError::msg(format!("set HideDesktopIcons failed: {}", e)))?;

    shell_log(&format!(
        "Explorer NameSpace pinned clsid={} path={}",
        SHELL_NAMESPACE_CLSID,
        sync_root.display()
    ));
    Ok(())
}

fn delete_namespace_pin() {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    if let Ok(ns_parent) = hkcu.open_subkey_with_flags(DESKTOP_NAMESPACE_KEY, KEY_WRITE) {
        match ns_parent.delete_subkey_all(SHELL_NAMESPACE_CLSID) {
            Ok(()) => shell_log("purged Desktop\\NameSpace FreeDrive CLSID"),
            Err(e) => shell_log(&format!("purge Desktop\\NameSpace failed: {}", e)),
        }
    }

    if let Ok(clsid_parent) = hkcu.open_subkey_with_flags(CLSID_KEY, KEY_WRITE) {
        match clsid_parent.delete_subkey_all(SHELL_NAMESPACE_CLSID) {
            Ok(()) => shell_log("purged Classes\\CLSID FreeDrive"),
            Err(e) => shell_log(&format!("purge Classes\\CLSID failed: {}", e)),
        }
    }

    if let Ok(hide) = hkcu.open_subkey_with_flags(HIDE_DESKTOP_ICONS_KEY, KEY_SET_VALUE) {
        let _ = hide.delete_value(SHELL_NAMESPACE_CLSID);
    }
}

fn delete_sync_root_registry_from_hive(hive: HKEY, sync_root_id: &str) -> AppResult<()> {
    let hk = RegKey::predef(hive);
    let manager = hk
        .open_subkey_with_flags(SYNC_ROOT_MANAGER_KEY, KEY_WRITE)
        .map_err(|e| AppError::msg(format!("open SyncRootManager for delete failed: {}", e)))?;
    manager
        .delete_subkey_all(sync_root_id)
        .map_err(|e| AppError::msg(format!("delete sync root registry failed: {}", e)))?;
    Ok(())
}

fn delete_sync_root_registry(sync_root_id: &str) -> AppResult<()> {
    let _ = delete_sync_root_registry_from_hive(HKEY_LOCAL_MACHINE, sync_root_id);
    let _ = delete_sync_root_registry_from_hive(HKEY_CURRENT_USER, sync_root_id);
    Ok(())
}

/// Register / refresh SyncRootManager + pin FreeDrive in Explorer nav pane.
/// Always rewrites IconResource / NameSpace so NSIS updates pick up the new exe icon.
pub fn ensure_shell_registered(db: &DbHandle, sync_root: &Path) -> AppResult<()> {
    let sync_root_id = sync_root_shell_id(db)?;
    let identity = sync_root_identity_bytes(db)?;

    match write_sync_root_registry(&sync_root_id, sync_root, &identity) {
        Ok(()) => shell_log(&format!("shell SyncRootManager ok id={}", sync_root_id)),
        Err(e) => {
            let msg = e.to_string();
            if msg.to_ascii_lowercase().contains("already exists") {
                shell_log(&format!("shell SyncRootManager already exists id={}", sync_root_id));
            } else {
                // NameSpace pin can still show the folder even if SyncRootManager write fails.
                shell_log(&format!("shell SyncRootManager warning: {}", e));
            }
        }
    }

    ensure_namespace_pinned(sync_root)?;
    refresh_offline_context_menu(db)?;
    mark_shell_registered(db)?;
    shell_log(&format!("shell registered id={}", sync_root_id));
    Ok(())
}

/// Stream: Free up + Download in Explorer. Mirror: no offline verbs (like Google Drive).
pub fn refresh_offline_context_menu(db: &DbHandle) -> AppResult<()> {
    let stream = crate::sync::engine::sync_mode_is_stream(db);
    ensure_context_menu_registered(stream)
}

pub fn unregister_shell(db: &DbHandle) -> AppResult<()> {
    let sync_root_id = sync_root_shell_id(db)?;
    let sid = current_user_sid_string().unwrap_or_default();
    if is_shell_registered(db)? || sync_root_registry_valid(&sync_root_id, &sid) {
        delete_sync_root_registry(&sync_root_id)?;
    }
    delete_namespace_pin();
    delete_context_menu_registration();
    clear_shell_registration_state(db)?;
    shell_log("shell unregistered");
    Ok(())
}

/// Delete every FreeDrive SyncRootManager entry + NameSpace pin (uninstall / stale cleanup).
pub fn purge_all_freedrive_shell_entries() {
    let prefix = format!("{}!", SHELL_PROVIDER_NAME);
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let hk = RegKey::predef(hive);
        let Ok(manager) = hk.open_subkey_with_flags(SYNC_ROOT_MANAGER_KEY, KEY_READ | KEY_WRITE)
        else {
            continue;
        };
        let Ok(names) = manager.enum_keys().collect::<Result<Vec<_>, _>>() else {
            continue;
        };
        for name in names {
            if name.starts_with(&prefix) {
                match manager.delete_subkey_all(&name) {
                    Ok(()) => shell_log(&format!("purged shell key {}", name)),
                    Err(e) => shell_log(&format!("purge shell key {} failed: {}", name, e)),
                }
            }
        }
    }
    delete_namespace_pin();
    delete_context_menu_registration();
}

/// Explorer context menu: flat verbs with a direct `command` (cascade SubCommands=""
/// often shows FreeDrive > but never launches the exe on Win11 classic menu).
/// Only registered in Stream mode — Mirror has no Free up / Download (Google Drive parity).
fn ensure_context_menu_registered(stream_mode: bool) -> AppResult<()> {
    delete_context_menu_registration();

    if !stream_mode {
        shell_log("shell context menu FreeDrive offline verbs cleared (Mirror mode)");
        return Ok(());
    }

    let exe = std::env::current_exe()
        .map_err(|e| AppError::msg(format!("current_exe failed: {}", e)))?;
    let exe_str = exe.to_string_lossy().replace('/', "\\");
    let icon = icon_resource_path();
    let hydrate_cmd = format!("\"{}\" --my-drive-hydrate \"%1\"", exe_str);
    let free_cmd = format!("\"{}\" --my-drive-free-space \"%1\"", exe_str);

    let verbs = [
        (
            r"Software\Classes\AllFilesystemObjects\shell\FreeDriveDownload",
            "FreeDrive Download",
            hydrate_cmd.as_str(),
        ),
        (
            r"Software\Classes\AllFilesystemObjects\shell\FreeDriveFreeSpace",
            "FreeDrive Free up space",
            free_cmd.as_str(),
        ),
        (
            r"Software\Classes\*\shell\FreeDriveDownload",
            "FreeDrive Download file",
            hydrate_cmd.as_str(),
        ),
        (
            r"Software\Classes\*\shell\FreeDriveFreeSpace",
            "FreeDrive Free up space",
            free_cmd.as_str(),
        ),
        (
            r"Software\Classes\Directory\shell\FreeDriveDownload",
            "FreeDrive Download folder",
            hydrate_cmd.as_str(),
        ),
        (
            r"Software\Classes\Directory\shell\FreeDriveFreeSpace",
            "FreeDrive Free up space",
            free_cmd.as_str(),
        ),
    ];
    for (key_path, label, command) in verbs {
        register_flat_verb(key_path, label, &icon, command)?;
    }

    shell_log("shell context menu FreeDrive registered (Stream offline verbs)");
    Ok(())
}

const COMMAND_STORE_SHELL: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\CommandStore\shell";

fn register_flat_verb(
    key_path: &str,
    label: &str,
    icon: &str,
    command: &str,
) -> AppResult<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let root = hkcu
        .create_subkey(key_path)
        .map_err(|e| AppError::msg(format!("create {} failed: {}", key_path, e)))?
        .0;
    root.set_value("MUIVerb", &label)
        .map_err(|e| AppError::msg(format!("set MUIVerb failed: {}", e)))?;
    root.set_value("Icon", &icon)
        .map_err(|e| AppError::msg(format!("set Icon failed: {}", e)))?;
    let cmd_key = root
        .create_subkey("command")
        .map_err(|e| AppError::msg(format!("create {}\\command failed: {}", key_path, e)))?
        .0;
    cmd_key
        .set_value("", &command)
        .map_err(|e| AppError::msg(format!("set {} command failed: {}", key_path, e)))?;
    Ok(())
}

fn delete_context_menu_registration() {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let class_paths = [
        // Legacy cascade roots
        r"Software\Classes\*\shell\FreeDrive",
        r"Software\Classes\Directory\shell\FreeDrive",
        r"Software\Classes\AllFilesystemObjects\shell\FreeDrive",
        // Flat verbs
        r"Software\Classes\*\shell\FreeDriveDownload",
        r"Software\Classes\*\shell\FreeDriveFreeSpace",
        r"Software\Classes\Directory\shell\FreeDriveDownload",
        r"Software\Classes\Directory\shell\FreeDriveFreeSpace",
        r"Software\Classes\AllFilesystemObjects\shell\FreeDriveDownload",
        r"Software\Classes\AllFilesystemObjects\shell\FreeDriveFreeSpace",
    ];
    for path in class_paths {
        match hkcu.delete_subkey_all(path) {
            Ok(()) => shell_log(&format!("shell context menu removed {}", path)),
            Err(e) => shell_log(&format!(
                "shell context menu remove {} skipped: {}",
                path, e
            )),
        }
    }
    for name in [
        "FreeDrive.DownloadFile",
        "FreeDrive.DownloadFolder",
        "FreeDrive.FreeSpace",
        "FreeDrive.Download",
    ] {
        let path = format!("{}\\{}", COMMAND_STORE_SHELL, name);
        match hkcu.delete_subkey_all(&path) {
            Ok(()) => shell_log(&format!("shell context menu removed {}", path)),
            Err(e) => shell_log(&format!(
                "shell context menu remove {} skipped: {}",
                path, e
            )),
        }
    }
}
