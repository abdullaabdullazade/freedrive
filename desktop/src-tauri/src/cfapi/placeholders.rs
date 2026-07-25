use crate::api::types::{FileRecord, Folder};
use crate::cfapi::util::{
    cf_operation_param_size, file_fs_metadata, file_identity, folder_fs_metadata, path_to_wide,
};
use crate::sync::log::sync_log;
use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};
use windows::core::{HRESULT, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, NTSTATUS, STATUS_SUCCESS};
use windows::Win32::Storage::CloudFilters::{
    CfConvertToPlaceholder, CfCreatePlaceholders, CfDehydratePlaceholder, CfExecute,
    CfUpdatePlaceholder, CF_CALLBACK_INFO, CF_CONVERT_FLAG_FORCE_CONVERT_TO_CLOUD_FILE,
    CF_CONVERT_FLAG_MARK_IN_SYNC, CF_CREATE_FLAG_NONE, CF_DEHYDRATE_FLAG_NONE, CF_FS_METADATA,
    CF_OPERATION_INFO, CF_OPERATION_PARAMETERS, CF_OPERATION_PARAMETERS_0,
    CF_OPERATION_PARAMETERS_0_7, CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION,
    CF_OPERATION_TYPE_TRANSFER_PLACEHOLDERS, CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION,
    CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC, CF_PLACEHOLDER_CREATE_FLAGS, CF_PLACEHOLDER_CREATE_INFO,
    CF_UPDATE_FLAG_DISABLE_ON_DEMAND_POPULATION, CF_UPDATE_FLAG_ENABLE_ON_DEMAND_POPULATION,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ,
    FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};

pub const MY_DRIVE_FOLDER_NAME: &str = "My Drive";

#[derive(Debug, Default, Clone, Copy)]
pub struct PlaceholderCreateStats {
    pub created: u32,
    pub skipped_duplicates: u32,
}

/// Owns backing storage for a single CF_PLACEHOLDER_CREATE_INFO passed to CfExecute.
pub struct PlaceholderEntry {
    wide_name: Vec<u16>,
    identity: Vec<u8>,
    fs_metadata: CF_FS_METADATA,
    flags: CF_PLACEHOLDER_CREATE_FLAGS,
}

pub fn is_duplicate_placeholder_error(error: &AppError) -> bool {
    let message = error.to_string();
    message.contains("0x800700B7")
        || message.contains("0x80070050")
        || message.to_ascii_lowercase().contains("already exists")
}

pub fn build_placeholder_infos(folders: &[Folder], files: &[FileRecord]) -> Vec<PlaceholderEntry> {
    let mut entries = Vec::with_capacity(folders.len() + files.len());
    for folder in folders {
        entries.push(PlaceholderEntry::folder(&folder.name, &folder.id));
    }
    for file in files {
        entries.push(PlaceholderEntry::file(file));
    }
    entries
}

pub fn filter_new_entries(
    parent_dir: &Path,
    folders: &[Folder],
    files: &[FileRecord],
) -> Vec<PlaceholderEntry> {
    let mut entries = Vec::new();
    for folder in folders {
        if !parent_dir.join(&folder.name).exists() {
            entries.push(PlaceholderEntry::folder(&folder.name, &folder.id));
        }
    }
    for file in files {
        let name = file_display_name(&file.name);
        if !parent_dir.join(&name).exists() {
            entries.push(PlaceholderEntry::file(file));
        }
    }
    entries
}

pub fn count_existing_children(
    parent_dir: &Path,
    folders: &[Folder],
    files: &[FileRecord],
) -> u32 {
    let mut count = 0u32;
    for folder in folders {
        if parent_dir.join(&folder.name).exists() {
            count += 1;
        }
    }
    for file in files {
        let name = file_display_name(&file.name);
        if parent_dir.join(&name).exists() {
            count += 1;
        }
    }
    count
}

impl PlaceholderEntry {
    pub fn folder(name: &str, remote_id: &str) -> Self {
        let flags = CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC
            | CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION;
        Self {
            wide_name: wide_filename(name),
            identity: file_identity("folder", remote_id),
            fs_metadata: folder_fs_metadata(),
            flags,
        }
    }

    fn file(file: &FileRecord) -> Self {
        let name = file_display_name(&file.name);
        let updated = crate::cfapi::util::parse_rfc3339_unix(&file.updated_at);
        Self {
            wide_name: wide_filename(&name),
            identity: file_identity("file", &file.id),
            fs_metadata: file_fs_metadata(file.size, updated),
            flags: CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC,
        }
    }

    fn to_create_info(&self) -> CF_PLACEHOLDER_CREATE_INFO {
        CF_PLACEHOLDER_CREATE_INFO {
            RelativeFileName: PCWSTR(self.wide_name.as_ptr()),
            FsMetadata: self.fs_metadata,
            FileIdentity: self.identity.as_ptr() as *const _,
            FileIdentityLength: self.identity.len() as u32,
            Flags: self.flags,
            Result: HRESULT(0),
            ..Default::default()
        }
    }
}

/// Transfer placeholders to the platform during FETCH_PLACEHOLDERS (Cloud Mirror pattern).
pub unsafe fn transfer_placeholders_via_callback(
    info: &CF_CALLBACK_INFO,
    entries: &[PlaceholderEntry],
    placeholder_total_count: u32,
) -> AppResult<u32> {
    let count = entries.len() as u32;
    if count == 0 {
        return complete_fetch_placeholders(info, placeholder_total_count, placeholder_total_count);
    }

    let mut infos: Vec<CF_PLACEHOLDER_CREATE_INFO> =
        entries.iter().map(PlaceholderEntry::to_create_info).collect();

    execute_transfer_placeholders(
        info,
        infos.as_mut_ptr(),
        count,
        placeholder_total_count,
        count,
        STATUS_SUCCESS,
        CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION,
    )
}

/// Completion-only response when no new placeholders need transferring.
pub unsafe fn complete_fetch_placeholders(
    info: &CF_CALLBACK_INFO,
    placeholder_total_count: u32,
    entries_processed: u32,
) -> AppResult<u32> {
    execute_transfer_placeholders(
        info,
        std::ptr::null_mut(),
        0,
        placeholder_total_count,
        entries_processed,
        STATUS_SUCCESS,
        CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION,
    )
}

unsafe fn execute_transfer_placeholders(
    info: &CF_CALLBACK_INFO,
    placeholder_array: *mut CF_PLACEHOLDER_CREATE_INFO,
    placeholder_count: u32,
    placeholder_total_count: u32,
    entries_processed_this_call: u32,
    status: NTSTATUS,
    flags: windows::Win32::Storage::CloudFilters::CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAGS,
) -> AppResult<u32> {
    let param_size = cf_operation_param_size::<CF_OPERATION_PARAMETERS_0_7>();
    let total = placeholder_total_count as i64;
    sync_log(format!(
        "cfapi: CfExecute TRANSFER_PLACEHOLDERS param_size={} total={} count={} processed={}",
        param_size, placeholder_total_count, placeholder_count, entries_processed_this_call
    ));
    let op_info = CF_OPERATION_INFO {
        StructSize: std::mem::size_of::<CF_OPERATION_INFO>() as u32,
        Type: CF_OPERATION_TYPE_TRANSFER_PLACEHOLDERS,
        ConnectionKey: info.ConnectionKey,
        TransferKey: info.TransferKey,
        CorrelationVector: info.CorrelationVector,
        RequestKey: info.RequestKey,
        SyncStatus: std::ptr::null(),
    };
    let mut op_params = CF_OPERATION_PARAMETERS {
        ParamSize: param_size,
        Anonymous: CF_OPERATION_PARAMETERS_0 {
            TransferPlaceholders: CF_OPERATION_PARAMETERS_0_7 {
                Flags: flags,
                CompletionStatus: status,
                PlaceholderTotalCount: total,
                PlaceholderArray: placeholder_array,
                PlaceholderCount: placeholder_count,
                EntriesProcessed: entries_processed_this_call,
            },
        },
    };
    CfExecute(&op_info, &mut op_params)
        .map_err(|e| AppError::msg(format!("CfExecute TRANSFER_PLACEHOLDERS: {}", e)))?;
    Ok(entries_processed_this_call)
}

pub fn is_not_cloud_file_error(error: &AppError) -> bool {
    error.to_string().contains("0x80070178")
}

/// Convert a plain NTFS directory into a cloud placeholder.
pub fn convert_directory_to_placeholder(
    dir: &Path,
    item_type: &str,
    remote_id: &str,
) -> AppResult<()> {
    let identity = file_identity(item_type, remote_id);
    let wide = path_to_wide(dir);
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        .map_err(|e| AppError::msg(format!("open directory for CfConvertToPlaceholder: {}", e)))?
    };

    let flags = CF_CONVERT_FLAG_MARK_IN_SYNC | CF_CONVERT_FLAG_FORCE_CONVERT_TO_CLOUD_FILE;
    let result = unsafe {
        CfConvertToPlaceholder(
            handle,
            Some(identity.as_ptr() as *const _),
            identity.len() as u32,
            flags,
            None,
            None,
        )
        .map_err(|e| AppError::msg(format!("CfConvertToPlaceholder: {}", e)))
    };

    unsafe {
        let _ = CloseHandle(handle);
    }
    result
}

pub fn ensure_cloud_placeholder(dir: &Path, item_type: &str, remote_id: &str) -> AppResult<()> {
    if !dir.exists() {
        return Ok(());
    }
    match mark_directory_populated(dir) {
        Ok(()) => {
            sync_log(format!(
                "cfapi: ensure_cloud_placeholder ok path={}",
                dir.display()
            ));
            Ok(())
        }
        Err(e) if is_not_cloud_file_error(&e) => {
            sync_log(format!(
                "cfapi: ensure_cloud_placeholder converting path={}",
                dir.display()
            ));
            convert_directory_to_placeholder(dir, item_type, remote_id)?;
            sync_log(format!(
                "cfapi: ensure_cloud_placeholder converted path={}",
                dir.display()
            ));
            Ok(())
        }
        Err(e) => {
            sync_log(format!(
                "cfapi: ensure_cloud_placeholder warning path={}: {}",
                dir.display(),
                e
            ));
            Ok(())
        }
    }
}

/// Free local plaintext for a hydrated cloud file (Google Drive “free up space”).
/// `length = -1` dehydrates from `starting_offset` through EOF.
pub fn dehydrate_placeholder_file(path: &Path) -> AppResult<()> {
    if !path.is_file() {
        return Ok(());
    }
    let wide = path_to_wide(path);
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        .map_err(|e| AppError::msg(format!("open file for CfDehydratePlaceholder: {}", e)))?
    };

    let result = unsafe {
        CfDehydratePlaceholder(handle, 0, -1, CF_DEHYDRATE_FLAG_NONE, None)
            .map_err(|e| AppError::msg(format!("CfDehydratePlaceholder: {}", e)))
    };

    unsafe {
        let _ = CloseHandle(handle);
    }
    result
}

/// Best-effort walk of My Drive: dehydrate every regular file so Stream mode reclaims disk.
pub fn dehydrate_my_drive_tree(my_drive: &Path) -> u32 {
    if !my_drive.is_dir() {
        return 0;
    }
    let mut freed = 0u32;
    dehydrate_tree_recursive(my_drive, &mut freed);
    freed
}

fn dehydrate_tree_recursive(dir: &Path, freed: &mut u32) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            sync_log(format!(
                "cfapi: dehydrate walk failed {}: {}",
                dir.display(),
                e
            ));
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            dehydrate_tree_recursive(&path, freed);
            continue;
        }
        if !path.is_file() {
            continue;
        }
        match dehydrate_placeholder_file(&path) {
            Ok(()) => {
                *freed += 1;
                sync_log(format!("cfapi: dehydrated {}", path.display()));
            }
            Err(e) => {
                sync_log(format!(
                    "cfapi: dehydrate skipped {}: {}",
                    path.display(),
                    e
                ));
            }
        }
    }
}

/// Transfer placeholders during FETCH; fall back to completion-only on duplicate errors.
pub unsafe fn transfer_or_complete_fetch(
    info: &CF_CALLBACK_INFO,
    entries: &[PlaceholderEntry],
    total: u32,
) -> AppResult<u32> {
    if entries.is_empty() {
        return complete_fetch_placeholders(info, total, total);
    }
    match transfer_placeholders_via_callback(info, entries, total) {
        Ok(count) => Ok(count),
        Err(e) if is_duplicate_placeholder_error(&e) => {
            sync_log(format!(
                "cfapi: transfer_or_complete_fetch duplicate fallback total={}",
                total
            ));
            complete_fetch_placeholders(info, total, total)
        }
        Err(e) => Err(e),
    }
}

/// Mark a placeholder directory as fully populated (no further FETCH_PLACEHOLDERS).
pub fn mark_directory_populated(dir: &Path) -> AppResult<()> {
    update_directory_population(dir, CF_UPDATE_FLAG_DISABLE_ON_DEMAND_POPULATION)
}

/// Re-enable on-demand population so Explorer will send FETCH_PLACEHOLDERS again
/// (needed after remote restore when the folder was previously marked fully populated).
pub fn mark_directory_partially_populated(dir: &Path) -> AppResult<()> {
    update_directory_population(dir, CF_UPDATE_FLAG_ENABLE_ON_DEMAND_POPULATION)
}

fn update_directory_population(
    dir: &Path,
    flags: windows::Win32::Storage::CloudFilters::CF_UPDATE_FLAGS,
) -> AppResult<()> {
    let wide = path_to_wide(dir);
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        .map_err(|e| AppError::msg(format!("open directory for CfUpdatePlaceholder: {}", e)))?
    };

    let result = unsafe {
        CfUpdatePlaceholder(handle, None, None, 0, None, flags, None, None)
            .map_err(|e| AppError::msg(format!("CfUpdatePlaceholder: {}", e)))
    };

    unsafe {
        let _ = CloseHandle(handle);
    }
    result
}

fn create_single_placeholder(
    parent_dir: &Path,
    name: &str,
    identity: &[u8],
    fs_metadata: CF_FS_METADATA,
) -> AppResult<()> {
    let parent_wide = path_to_wide(parent_dir);
    let wide_name = wide_filename(name);
    let mut info = CF_PLACEHOLDER_CREATE_INFO {
        RelativeFileName: PCWSTR(wide_name.as_ptr()),
        FsMetadata: fs_metadata,
        FileIdentity: identity.as_ptr() as *const _,
        FileIdentityLength: identity.len() as u32,
        Flags: CF_PLACEHOLDER_CREATE_FLAGS(0),
        Result: HRESULT(0),
        ..Default::default()
    };

    unsafe {
        CfCreatePlaceholders(
            PCWSTR(parent_wide.as_ptr()),
            std::slice::from_mut(&mut info),
            CF_CREATE_FLAG_NONE,
            None,
        )
        .map_err(|e| AppError::msg(format!("CfCreatePlaceholders failed for {}: {}", name, e)))?;
    }

    let _ = (parent_wide, wide_name);
    Ok(())
}

pub fn create_named_folder_placeholder(
    parent_dir: &Path,
    name: &str,
    remote_id: &str,
) -> AppResult<()> {
    let identity = file_identity("folder", remote_id);
    create_single_placeholder(parent_dir, name, &identity, folder_fs_metadata())
}

pub fn create_file_placeholder(parent_dir: &Path, file: &FileRecord) -> AppResult<()> {
    let name = file_display_name(&file.name);
    let identity = file_identity("file", &file.id);
    let updated = crate::cfapi::util::parse_rfc3339_unix(&file.updated_at);
    create_single_placeholder(parent_dir, &name, &identity, file_fs_metadata(file.size, updated))
}

/// Background prefetch still uses CfCreatePlaceholders directly (not inside a callback).
pub fn create_placeholders(
    parent_dir: &Path,
    folders: &[Folder],
    files: &[FileRecord],
) -> AppResult<PlaceholderCreateStats> {
    let mut stats = PlaceholderCreateStats::default();
    if folders.is_empty() && files.is_empty() {
        return Ok(stats);
    }

    for folder in folders {
        match create_named_folder_placeholder(parent_dir, &folder.name, &folder.id) {
            Ok(()) => stats.created += 1,
            Err(e) if is_duplicate_placeholder_error(&e) => stats.skipped_duplicates += 1,
            Err(e) => return Err(e),
        }
    }

    for file in files {
        match create_file_placeholder(parent_dir, file) {
            Ok(()) => stats.created += 1,
            Err(e) if is_duplicate_placeholder_error(&e) => stats.skipped_duplicates += 1,
            Err(e) => return Err(e),
        }
    }

    Ok(stats)
}

fn file_display_name(name: &str) -> String {
    PathBuf::from(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(name)
        .to_string()
}

fn wide_filename(name: &str) -> Vec<u16> {
    file_display_name(name)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_placeholder_error_detected() {
        let err = AppError::msg("CfCreatePlaceholders failed: already exists (0x800700B7)");
        assert!(is_duplicate_placeholder_error(&err));
        let err = AppError::msg("access denied");
        assert!(!is_duplicate_placeholder_error(&err));
    }

    #[test]
    fn build_placeholder_infos_counts_entries() {
        let folders = vec![Folder {
            id: "f1".into(),
            name: "Docs".into(),
            parent_id: None,
            is_trashed: false,
        }];
        let files = vec![FileRecord {
            id: "file1".into(),
            name: "readme.txt".into(),
            mime_type: "text/plain".into(),
            size: 10,
            folder_id: None,
            updated_at: "2026-01-01T00:00:00Z".into(),
            version: 1,
        }];
        let entries = build_placeholder_infos(&folders, &files);
        assert_eq!(entries.len(), 2);
    }
}
