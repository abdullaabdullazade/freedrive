use crate::api::types::FolderContents;
use crate::api::ApiClient;
use crate::db::{
    config_get, config_set, get_file_key, get_pending_file_key, has_any_pending_file_key,
    my_drive_get_placeholder, my_drive_get_placeholder_by_remote_id, my_drive_upsert_placeholder,
    DbHandle,
};
use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use windows::Win32::Storage::CloudFilters::CF_CALLBACK_INFO;

pub const ROOT_FOLDER_CONFIG_KEY: &str = "my_drive_root_folder_id";
/// Stored when GET /folders/root returns children without a folder object.
pub const MY_DRIVE_CLOUD_ROOT_SENTINEL: &str = "cloud-root";

/// Map desktop My Drive root sentinels to API `parent_id` / `folder_id`.
/// Virtual root has no UUID — create/upload must send `null` and list via `/folders/root`.
pub fn api_folder_parent_id(id: &str) -> Option<&str> {
    if id.is_empty()
        || id == MY_DRIVE_CLOUD_ROOT_SENTINEL
        || id.eq_ignore_ascii_case("root")
    {
        None
    } else {
        Some(id)
    }
}

pub fn ensure_my_drive_folder() -> AppResult<PathBuf> {
    crate::auth_store::my_drive_dir()
}

pub fn relative_path_from_sync_root(sync_root: &Path, full_path: &Path) -> Option<String> {
    let root_str = path_display(sync_root);
    let full_str = path_display(full_path);

    if full_str.eq_ignore_ascii_case(&root_str) {
        return Some(String::new());
    }

    let prefix = format!("{}\\", root_str);
    if full_str.len() <= prefix.len() || !full_str[..prefix.len()].eq_ignore_ascii_case(&prefix) {
        return None;
    }

    Some(full_str[prefix.len()..].to_string())
}

fn path_display(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_string()
}

pub fn is_under_my_drive(relative: &str) -> bool {
    relative.eq_ignore_ascii_case("My Drive")
        || relative.starts_with("My Drive\\")
        || relative.starts_with("My Drive/")
}

pub fn store_root_folder_id(db: &DbHandle, folder_id: &str) -> AppResult<()> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    config_set(&conn, ROOT_FOLDER_CONFIG_KEY, folder_id)?;
    my_drive_upsert_placeholder(&conn, "My Drive", folder_id, "folder", None)?;
    Ok(())
}

pub fn resolve_my_drive_root_id(db: &DbHandle) -> AppResult<String> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    Ok(config_get(&conn, ROOT_FOLDER_CONFIG_KEY)?.unwrap_or_else(|| "root".to_string()))
}

#[cfg(windows)]
pub fn resolve_folder_id_from_identity(info: &CF_CALLBACK_INFO) -> Option<String> {
    if info.FileIdentity.is_null() || info.FileIdentityLength == 0 {
        return None;
    }
    let identity = unsafe {
        std::slice::from_raw_parts(
            info.FileIdentity as *const u8,
            info.FileIdentityLength as usize,
        )
    };
    let s = std::str::from_utf8(identity).ok()?;
    let (item_type, remote_id) = s.split_once(':')?;
    if item_type == "folder" {
        Some(remote_id.to_string())
    } else {
        None
    }
}

pub enum FolderIdSource {
    Identity,
    Database,
    RootConfig,
}

#[cfg(windows)]
pub fn resolve_folder_id_for_fetch(
    db: &DbHandle,
    info: &CF_CALLBACK_INFO,
    relative_path: &str,
) -> AppResult<(Option<String>, FolderIdSource)> {
    if let Some(id) = resolve_folder_id_from_identity(info) {
        if !id.is_empty() && id != MY_DRIVE_CLOUD_ROOT_SENTINEL {
            return Ok((Some(id), FolderIdSource::Identity));
        }
    }

    if relative_path.eq_ignore_ascii_case("My Drive") {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        if let Some(id) = config_get(&conn, ROOT_FOLDER_CONFIG_KEY)? {
            if id != MY_DRIVE_CLOUD_ROOT_SENTINEL {
                return Ok((Some(id), FolderIdSource::RootConfig));
            }
            return Ok((None, FolderIdSource::RootConfig));
        }
        return Ok((None, FolderIdSource::RootConfig));
    }

    if let Some(id) = resolve_folder_id(db, relative_path)? {
        return Ok((Some(id), FolderIdSource::Database));
    }

    Ok((None, FolderIdSource::Database))
}

pub fn resolve_folder_id(db: &DbHandle, relative_path: &str) -> AppResult<Option<String>> {
    if relative_path.eq_ignore_ascii_case("My Drive") {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        if let Some(id) = config_get(&conn, ROOT_FOLDER_CONFIG_KEY)? {
            return Ok(Some(id));
        }
        return Ok(None);
    }

    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    if let Some((remote_id, item_type)) = my_drive_get_placeholder(&conn, relative_path)? {
        if item_type == "folder" {
            return Ok(Some(remote_id));
        }
    }
    Ok(None)
}

pub async fn fetch_folder_contents(
    api: &ApiClient,
    db: &DbHandle,
    sync_root: &Path,
    parent_relative: &str,
    folder_id: Option<&str>,
) -> AppResult<FolderContents> {
    let use_root_endpoint = parent_relative.eq_ignore_ascii_case("My Drive")
        && folder_id
            .map(|id| id.is_empty() || id == MY_DRIVE_CLOUD_ROOT_SENTINEL)
            .unwrap_or(true);

    let contents = if use_root_endpoint {
        api.get_my_drive_root().await?
    } else {
        let fid = folder_id
            .ok_or_else(|| AppError::msg("missing folder id for My Drive subfolder"))?;
        api.get_folder_contents(fid).await?
    };

    if parent_relative.eq_ignore_ascii_case("My Drive") {
        if let Some(ref folder) = contents.folder {
            store_root_folder_id(db, &folder.id)?;
        } else {
            store_root_folder_id(db, MY_DRIVE_CLOUD_ROOT_SENTINEL)?;
        }
    }

    let parent_remote = if parent_relative.eq_ignore_ascii_case("My Drive") {
        contents.folder.as_ref().map(|f| f.id.as_str())
    } else {
        folder_id
    };

    let parent_base = PathBuf::from(parent_relative);
    {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        for folder in &contents.folders {
            let rel = parent_base
                .join(&folder.name)
                .to_string_lossy()
                .replace('/', "\\");
            my_drive_upsert_placeholder(
                &conn,
                &rel,
                &folder.id,
                "folder",
                parent_remote,
            )?;
        }
        for file in &contents.files {
            let rel = parent_base
                .join(&file.name)
                .to_string_lossy()
                .replace('/', "\\");
            my_drive_upsert_placeholder(&conn, &rel, &file.id, "file", parent_remote)?;
        }
    }

    let _ = sync_root;
    Ok(contents)
}

pub async fn hydrate_file(
    api: &ApiClient,
    db: &DbHandle,
    file_id: &str,
) -> AppResult<Vec<u8>> {
    let path = ensure_hydrated_plaintext(api, db, file_id).await?;
    Ok(tokio::fs::read(path).await?)
}

/// Google Drive for desktop–style open: download once to a local plaintext cache,
/// then serve byte ranges from disk (Explorer / default video player).
pub async fn ensure_hydrated_plaintext(
    api: &ApiClient,
    db: &DbHandle,
    file_id: &str,
) -> AppResult<PathBuf> {
    let cache_path = hydrate_cache_path(file_id)?;
    if cache_path.is_file() {
        let meta = std::fs::metadata(&cache_path)?;
        if meta.len() > 0 {
            return Ok(cache_path);
        }
    }

    let lock = hydrate_file_lock(file_id);
    let _guard = lock.lock().await;

    if cache_path.is_file() {
        let meta = std::fs::metadata(&cache_path)?;
        if meta.len() > 0 {
            return Ok(cache_path);
        }
    }

    let user_id = crate::auth_store::load_auth()
        .ok()
        .flatten()
        .and_then(|a| serde_json::from_str::<serde_json::Value>(&a.user_json).ok())
        .and_then(|v| {
            v.get("id")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| AppError::msg("not authenticated"))?;
    let key_b64url =
        crate::account_crypto::resolve_file_key(api, db, &user_id, file_id).await?;

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    api.download_file_to_path(file_id, Some(&key_b64url), &cache_path)
        .await?;
    Ok(cache_path)
}

fn hydrate_cache_path(file_id: &str) -> AppResult<PathBuf> {
    let safe: String = file_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok(crate::auth_store::data_dir()?
        .join("hydrate_cache")
        .join(safe))
}

/// Drop cached plaintext so the next open re-downloads (and Stream mode frees disk).
pub fn clear_hydrate_cache_for_file(file_id: &str) {
    if let Ok(path) = hydrate_cache_path(file_id) {
        let _ = std::fs::remove_file(path);
    }
}

pub fn clear_all_hydrate_cache() {
    let Ok(dir) = crate::auth_store::data_dir().map(|d| d.join("hydrate_cache")) else {
        return;
    };
    let _ = std::fs::remove_dir_all(&dir);
}

fn hydrate_file_lock(file_id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(file_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn resolve_encryption_key(db: &DbHandle, file_id: &str) -> AppResult<String> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    if let Some(key) = get_file_key(&conn, file_id)? {
        return Ok(key);
    }

    let mut pending_file_name: Option<String> = None;
    if let Some((rel_path, item_type, parent_remote_id)) =
        my_drive_get_placeholder_by_remote_id(&conn, file_id)?
    {
        if item_type != "file" {
            return Err(AppError::msg("FETCH_DATA on non-file"));
        }
        let file_name = rel_path
            .rsplit(['/', '\\'])
            .next()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| AppError::msg("invalid file path in placeholder"))?;
        pending_file_name = Some(file_name.to_string());
        let folder_id = parent_remote_id.unwrap_or_else(|| {
            config_get(&conn, ROOT_FOLDER_CONFIG_KEY)
                .ok()
                .flatten()
                .unwrap_or_else(|| "root".to_string())
        });
        if let Some(key) = get_pending_file_key(&conn, &folder_id, file_name)? {
            return Ok(key);
        }
    }

    if let Some(ref name) = pending_file_name {
        if has_any_pending_file_key(&conn, name)? {
            return Err(AppError::msg("file is still uploading"));
        }
    }

    Err(AppError::msg(
        "this file's encryption key is missing from the server; open FreeDrive in the original browser/device to sync its keys, or re-upload the original file",
    ))
}

pub fn sync_root_path() -> AppResult<PathBuf> {
    crate::auth_store::sync_root_dir(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_path_from_sync_root_windows() {
        let root = PathBuf::from(r"C:\Users\me\FreeDrive");
        let full = PathBuf::from(r"C:\Users\me\FreeDrive\My Drive\Docs");
        let rel = relative_path_from_sync_root(&root, &full).unwrap();
        assert_eq!(rel, "My Drive\\Docs");
    }

    #[test]
    fn relative_path_from_volume_relative_normalized() {
        let root = PathBuf::from(r"C:\Users\me\FreeDrive");
        let full = PathBuf::from(r"C:\Users\me\FreeDrive\My Drive");
        let rel = relative_path_from_sync_root(&root, &full).unwrap();
        assert_eq!(rel, "My Drive");
    }

    #[test]
    fn relative_path_sync_root_is_empty() {
        let root = PathBuf::from(r"C:\Users\me\FreeDrive");
        let rel = relative_path_from_sync_root(&root, &root).unwrap();
        assert_eq!(rel, "");
    }

    #[test]
    fn resolve_encryption_key_uses_pending_during_upload() {
        use crate::db::{in_memory_db, my_drive_upsert_placeholder, store_pending_file_key};

        let db = in_memory_db();
        {
            let conn = db.lock().unwrap();
            my_drive_upsert_placeholder(
                &conn,
                "My Drive\\a.bin",
                "fid-1",
                "file",
                Some("f-parent"),
            )
            .unwrap();
            store_pending_file_key(&conn, "f-parent", "a.bin", "pending-key").unwrap();
        }
        let key = resolve_encryption_key(&db, "fid-1").unwrap();
        assert_eq!(key, "pending-key");
    }
}
