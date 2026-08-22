use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use windows::core::GUID;
use windows::Win32::Storage::CloudFilters::{
    CF_CALLBACK_INFO, CF_FS_METADATA, CF_OPERATION_PARAMETERS,
};
use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_BASIC_INFO};

/// Stable provider GUID shown in Explorer as FreeDrive.
pub const PROVIDER_ID: GUID = GUID::from_u128(0xfd9a2b3c_4d5e_6f70_8899_aabbccddeeff);

pub fn path_to_wide(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

pub fn file_identity(item_type: &str, remote_id: &str) -> Vec<u8> {
    format!("{}:{}", item_type, remote_id).into_bytes()
}

pub fn parse_file_identity(identity: &[u8]) -> Option<(String, String)> {
    let s = std::str::from_utf8(identity).ok()?;
    let (ty, id) = s.split_once(':')?;
    Some((ty.to_string(), id.to_string()))
}

fn unix_to_filetime_i64(unix_secs: i64) -> i64 {
    const WINDOWS_EPOCH_OFFSET: i64 = 11_644_473_600;
    let secs = unix_secs.max(0) + WINDOWS_EPOCH_OFFSET;
    secs * 10_000_000
}

pub fn folder_fs_metadata() -> CF_FS_METADATA {
    CF_FS_METADATA {
        BasicInfo: FILE_BASIC_INFO {
            CreationTime: unix_to_filetime_i64(0),
            LastAccessTime: unix_to_filetime_i64(0),
            LastWriteTime: unix_to_filetime_i64(0),
            ChangeTime: unix_to_filetime_i64(0),
            FileAttributes: FILE_ATTRIBUTE_DIRECTORY.0,
        },
        FileSize: 0,
    }
}

pub fn file_fs_metadata(size: i64, updated_unix: i64) -> CF_FS_METADATA {
    let ft = unix_to_filetime_i64(updated_unix);
    CF_FS_METADATA {
        BasicInfo: FILE_BASIC_INFO {
            CreationTime: ft,
            LastAccessTime: ft,
            LastWriteTime: ft,
            ChangeTime: ft,
            FileAttributes: FILE_ATTRIBUTE_NORMAL.0,
        },
        FileSize: size.max(0),
    }
}

pub fn parse_rfc3339_unix(s: &str) -> i64 {
    let _ = s;
    0
}

/// CfExecute ParamSize = offsetof(union) + sizeof(active variant).
pub fn cf_operation_param_size<T>() -> u32 {
    (std::mem::offset_of!(CF_OPERATION_PARAMETERS, Anonymous) + std::mem::size_of::<T>()) as u32
}

/// Build a full Win32 path from CfAPI callback fields (`C:` + `\Users\...\FreeDrive`).
pub fn callback_full_path(info: &CF_CALLBACK_INFO) -> Result<PathBuf, String> {
    let volume = wide_ptr_to_string(info.VolumeDosName)?;
    let normalized = wide_ptr_to_string(info.NormalizedPath)?;
    Ok(combine_volume_path(&volume, &normalized))
}

pub fn combine_volume_path(volume: &str, normalized: &str) -> PathBuf {
    if normalized.is_empty() {
        return PathBuf::from(volume);
    }
    if normalized.starts_with('\\') {
        PathBuf::from(format!("{}{}", volume.trim_end_matches('\\'), normalized))
    } else {
        PathBuf::from(format!(
            "{}\\{}",
            volume.trim_end_matches('\\'),
            normalized
        ))
    }
}

pub fn wide_ptr_to_string(ptr: windows::core::PCWSTR) -> Result<String, String> {
    if ptr.is_null() {
        return Err("null wide string".into());
    }
    let mut len = 0usize;
    unsafe {
        while *ptr.0.add(len) != 0 {
            len += 1;
            if len > 32_768 {
                return Err("wide string too long".into());
            }
        }
        let slice = std::slice::from_raw_parts(ptr.0, len);
        Ok(String::from_utf16_lossy(slice))
    }
}

/// Ask Explorer to refresh a directory listing after placeholder changes.
pub fn notify_directory_updated(path: &Path) {
    use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_UPDATEDIR, SHCNF_PATHW};
    let wide = path_to_wide(path);
    unsafe {
        SHChangeNotify(
            SHCNE_UPDATEDIR,
            SHCNF_PATHW,
            Some(wide.as_ptr() as *const _),
            None,
        );
    }
}

/// Notify Explorer that sync root shell registration changed (sidebar refresh).
pub fn notify_shell_updated() {
    use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    unsafe {
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Storage::CloudFilters::CF_OPERATION_PARAMETERS_0_7;

    #[test]
    fn combine_volume_path_matches_drive_path() {
        let path = combine_volume_path("C:", r"\Users\me\FreeDrive");
        assert_eq!(path.to_string_lossy().replace('/', "\\"), r"C:\Users\me\FreeDrive");
    }

    #[test]
    fn cf_operation_param_size_includes_union_offset() {
        let size = cf_operation_param_size::<CF_OPERATION_PARAMETERS_0_7>();
        assert!(size > std::mem::size_of::<CF_OPERATION_PARAMETERS_0_7>() as u32);
    }
}
