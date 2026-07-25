use crate::api::ApiClient;
use crate::auth_store::sync_root_dir;
use crate::cfapi::{
    create_placeholders, mark_directory_partially_populated, notify_directory_updated,
    MY_DRIVE_FOLDER_NAME,
};
use crate::crypto::key_to_b64url;
use crate::db::{
    get_file_key, my_drive_delete_placeholder, my_drive_delete_placeholders_under_prefix,
    my_drive_get_placeholder, my_drive_upsert_placeholder, store_file_key, upsert_activity,
    DbHandle,
};
use crate::error::{AppError, AppResult};
use crate::my_drive::{
    ensure_hydrated_plaintext, fetch_folder_contents, is_under_my_drive,
    relative_path_from_sync_root, resolve_my_drive_root_id,
};
use crate::sync::log::sync_log;
use crate::sync::DOWNLOAD_CONCURRENCY;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

pub async fn poll_my_drive(
    api: &ApiClient,
    db: &DbHandle,
    mirror: bool,
    download_sem: Arc<Semaphore>,
) -> AppResult<()> {
    let sync_root = sync_root_dir(false)?;
    sync_log(&format!("poll My Drive started (mirror={})", mirror));
    poll_my_drive_folder(
        api,
        db,
        &sync_root,
        MY_DRIVE_FOLDER_NAME,
        None,
        mirror,
        download_sem,
    )
    .await?;
    notify_directory_updated(&local_dir_for_relative(&sync_root, MY_DRIVE_FOLDER_NAME));
    sync_log("poll My Drive finished");
    Ok(())
}

async fn poll_my_drive_folder(
    api: &ApiClient,
    db: &DbHandle,
    sync_root: &Path,
    parent_relative: &str,
    folder_id: Option<&str>,
    mirror: bool,
    download_sem: Arc<Semaphore>,
) -> AppResult<()> {
    let contents =
        fetch_folder_contents(api, db, sync_root, parent_relative, folder_id).await?;
    let local_dir = local_dir_for_relative(sync_root, parent_relative);
    if std::fs::create_dir_all(&local_dir).is_ok() {
        apply_remote_children(db, parent_relative, &local_dir, &contents);
        reconcile_local_against_remote(db, parent_relative, &local_dir, &contents);
        notify_directory_updated(&local_dir);
    }

    if mirror {
        mirror_files_parallel(api, db, &local_dir, &contents.files, download_sem.clone()).await;
    }

    for folder in &contents.folders {
        let sub_rel = join_my_drive_relative(parent_relative, &folder.name);
        Box::pin(poll_my_drive_folder(
            api,
            db,
            sync_root,
            &sub_rel,
            Some(&folder.id),
            mirror,
            download_sem.clone(),
        ))
        .await?;
    }

    Ok(())
}

/// Create missing local placeholders for remote children (e.g. after Trash→Restore).
/// Re-enables on-demand FETCH when the folder was previously marked fully populated empty.
fn apply_remote_children(
    db: &DbHandle,
    parent_relative: &str,
    local_dir: &Path,
    contents: &crate::api::types::FolderContents,
) {
    let (missing_folders, missing_files) = missing_remote_children(local_dir, contents);
    let had_missing = !missing_folders.is_empty() || !missing_files.is_empty();

    if had_missing {
        if let Err(e) = mark_directory_partially_populated(local_dir) {
            sync_log(format!(
                "My Drive enable on-demand failed {}: {}",
                local_dir.display(),
                e
            ));
        } else {
            sync_log(format!(
                "My Drive re-enabled on-demand population — {}",
                parent_relative
            ));
        }
    }

    match create_placeholders(local_dir, &contents.folders, &contents.files) {
        Ok(stats) => {
            if stats.created > 0 || stats.skipped_duplicates > 0 {
                sync_log(format!(
                    "My Drive placeholders under {} — created={} skipped={}",
                    parent_relative, stats.created, stats.skipped_duplicates
                ));
            }
        }
        Err(e) => {
            sync_log(format!(
                "My Drive create_placeholders failed under {}: {}",
                parent_relative, e
            ));
        }
    }

    if had_missing {
        if let Ok(conn) = db.lock() {
            for folder in &missing_folders {
                let _ = upsert_activity(&conn, &folder.name, "Restored from cloud", 0, "synced");
            }
            for file in &missing_files {
                let _ = upsert_activity(
                    &conn,
                    &file.name,
                    "Restored from cloud",
                    file.size,
                    "synced",
                );
            }
        }
        for folder in &missing_folders {
            sync_log(format!(
                "My Drive restored folder — {}\\{}",
                parent_relative, folder.name
            ));
        }
        for file in &missing_files {
            sync_log(format!(
                "My Drive restored file — {}\\{}",
                parent_relative, file.name
            ));
        }
    }
}

fn missing_remote_children(
    local_dir: &Path,
    contents: &crate::api::types::FolderContents,
) -> (Vec<crate::api::types::Folder>, Vec<crate::api::types::FileRecord>) {
    let mut missing_folders = Vec::new();
    let mut missing_files = Vec::new();
    for folder in &contents.folders {
        let name = sanitize_name(&folder.name);
        if !local_dir.join(&name).exists() {
            missing_folders.push(folder.clone());
        }
    }
    for file in &contents.files {
        let name = sanitize_name(&file.name);
        if !local_dir.join(&name).exists() {
            missing_files.push(file.clone());
        }
    }
    (missing_folders, missing_files)
}

/// Remove local My Drive placeholders that are no longer in the remote listing
/// (e.g. soft-deleted from mobile). Local-only paths without a placeholder row
/// are left alone (pending upload).
fn reconcile_local_against_remote(
    db: &DbHandle,
    parent_relative: &str,
    local_dir: &Path,
    contents: &crate::api::types::FolderContents,
) {
    let mut remote_names: HashSet<String> = HashSet::new();
    for folder in &contents.folders {
        remote_names.insert(sanitize_name(&folder.name).to_ascii_lowercase());
    }
    for file in &contents.files {
        remote_names.insert(sanitize_name(&file.name).to_ascii_lowercase());
    }

    let entries = match std::fs::read_dir(local_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.eq_ignore_ascii_case("desktop.ini") || name.starts_with('.') {
            continue;
        }
        if remote_names.contains(&name.to_ascii_lowercase()) {
            continue;
        }
        let child_relative = join_my_drive_relative(parent_relative, &name);
        let path = entry.path();
        let tracked = {
            let Ok(conn) = db.lock() else {
                continue;
            };
            my_drive_get_placeholder(&conn, &child_relative)
                .ok()
                .flatten()
                .is_some()
        };
        if !tracked {
            continue;
        }
        let remove_result = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        match remove_result {
            Ok(()) => {
                if let Ok(conn) = db.lock() {
                    let _ = my_drive_delete_placeholders_under_prefix(&conn, &child_relative);
                }
                sync_log(format!("My Drive reconcile removed — {}", child_relative));
            }
            Err(e) => {
                sync_log(format!(
                    "My Drive reconcile failed {}: {}",
                    child_relative, e
                ));
            }
        }
    }
}

async fn mirror_files_parallel(
    api: &ApiClient,
    db: &DbHandle,
    local_dir: &Path,
    files: &[crate::api::types::FileRecord],
    download_sem: Arc<Semaphore>,
) {
    let mut join_set = JoinSet::new();

    for file in files {
        while join_set.len() >= DOWNLOAD_CONCURRENCY {
            if let Some(res) = join_set.join_next().await {
                if let Err(e) = res {
                    sync_log(format!("mirror task join error — {}", e));
                }
            }
        }

        let permit = match download_sem.clone().acquire_owned().await {
            Ok(permit) => permit,
            Err(_) => break,
        };
        let api = api.clone();
        let db = db.clone();
        let local_dir = local_dir.to_path_buf();
        let file = file.clone();

        join_set.spawn(async move {
            let _permit = permit;
            if let Err(e) = mirror_file_if_needed(&api, &db, &local_dir, &file).await {
                sync_log(format!("mirror {} failed: {}", file.name, e));
            }
        });
    }

    while let Some(res) = join_set.join_next().await {
        if let Err(e) = res {
            sync_log(format!("mirror task join error — {}", e));
        }
    }
}

async fn mirror_file_if_needed(
    api: &ApiClient,
    db: &DbHandle,
    local_dir: &Path,
    file: &crate::api::types::FileRecord,
) -> AppResult<()> {
    let local_path = local_dir.join(sanitize_name(&file.name));
    let needs = match std::fs::metadata(&local_path) {
        Ok(meta) => meta.len() < file.size.max(0) as u64,
        Err(_) => true,
    };
    if !needs {
        return Ok(());
    }
    let cached = ensure_hydrated_plaintext(api, db, &file.id).await?;
    if let Some(parent) = local_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::copy(&cached, &local_path)?;
    Ok(())
}

pub async fn upload_my_drive_path(api: &ApiClient, db: &DbHandle, path: &Path) -> AppResult<()> {
    if !path.is_file() {
        return Ok(());
    }
    let sync_root = sync_root_dir(false)?;
    let relative = relative_path_from_sync_root(&sync_root, path)
        .ok_or_else(|| AppError::msg("path outside sync root"))?;
    if !is_under_my_drive(&relative) {
        return Ok(());
    }

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    if crate::sync::should_skip_file(&file_name) {
        return Ok(());
    }

    let existing_remote = {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        my_drive_get_placeholder(&conn, &relative)?
            .filter(|(_, item_type)| item_type == "file")
            .map(|(id, _)| id)
    };

    if let Some(remote_id) = existing_remote {
        let existing_key = {
            let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            get_file_key(&conn, &remote_id)?
                .and_then(|k| crate::crypto::key_from_b64url(&k).ok())
        };
        let (rec, key) = api
            .update_file_content(&remote_id, path, &file_name, existing_key, None)
            .await?;
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        store_file_key(&conn, &rec.id, &key_to_b64url(&key))?;
        my_drive_upsert_placeholder(&conn, &relative, &rec.id, "file", None)?;
        sync_log(format!("My Drive updated — {}", file_name));
        return Ok(());
    }

    let parent_folder_id = ensure_my_drive_parent_folder(api, db, &relative).await?;
    let (rec, key) = api
        .upload_file(db, path, &file_name, &parent_folder_id, None)
        .await?;
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    store_file_key(&conn, &rec.id, &key_to_b64url(&key))?;
    my_drive_upsert_placeholder(&conn, &relative, &rec.id, "file", Some(&parent_folder_id))?;
    sync_log(format!("My Drive uploaded — {}", file_name));
    Ok(())
}

pub async fn delete_my_drive_path(api: &ApiClient, db: &DbHandle, path: &Path) -> AppResult<()> {
    let sync_root = sync_root_dir(false)?;
    let relative = relative_path_from_sync_root(&sync_root, path)
        .ok_or_else(|| AppError::msg("path outside sync root"))?;
    if !is_under_my_drive(&relative) {
        return Ok(());
    }

    let remote_id = {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        my_drive_get_placeholder(&conn, &relative)?
            .filter(|(_, item_type)| item_type == "file")
            .map(|(id, _)| id)
    };

    if let Some(remote_id) = remote_id {
        if !remote_id.is_empty() {
            api.delete_file(&remote_id).await?;
        }
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        my_drive_delete_placeholder(&conn, &relative)?;
        sync_log(format!(
            "My Drive deleted — {}",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
        ));
    }
    Ok(())
}

async fn ensure_my_drive_parent_folder(
    api: &ApiClient,
    db: &DbHandle,
    file_relative: &str,
) -> AppResult<String> {
    let parent_relative = Path::new(file_relative)
        .parent()
        .map(|p| p.to_string_lossy().replace('/', "\\"))
        .unwrap_or_else(|| MY_DRIVE_FOLDER_NAME.to_string());

    if parent_relative.eq_ignore_ascii_case(MY_DRIVE_FOLDER_NAME) {
        return resolve_my_drive_root_id(db);
    }

    if let Ok(conn) = db.lock() {
        if let Some((remote_id, item_type)) = my_drive_get_placeholder(&conn, &parent_relative)? {
            if item_type == "folder" {
                return Ok(remote_id);
            }
        }
    }

    let root_id = resolve_my_drive_root_id(db)?;
    let suffix = parent_relative
        .strip_prefix("My Drive\\")
        .or_else(|| parent_relative.strip_prefix("My Drive/"))
        .unwrap_or("");
    let mut current_parent = root_id;
    let mut built_relative = MY_DRIVE_FOLDER_NAME.to_string();

    for component in Path::new(suffix).components() {
        let std::path::Component::Normal(name) = component else {
            continue;
        };
        let part = name.to_string_lossy();
        built_relative = format!("{}\\{}", built_relative, part);
        if let Ok(conn) = db.lock() {
            if let Some((remote_id, item_type)) = my_drive_get_placeholder(&conn, &built_relative)? {
                if item_type == "folder" {
                    current_parent = remote_id;
                    continue;
                }
            }
        }
        let folder = api
            .create_or_resolve_folder(&part, Some(&current_parent))
            .await?;
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        my_drive_upsert_placeholder(
            &conn,
            &built_relative,
            &folder.id,
            "folder",
            Some(&current_parent),
        )?;
        current_parent = folder.id;
    }

    Ok(current_parent)
}

fn local_dir_for_relative(sync_root: &Path, parent_relative: &str) -> PathBuf {
    let mut path = sync_root.to_path_buf();
    for part in parent_relative.split(['\\', '/']).filter(|p| !p.is_empty()) {
        path.push(part);
    }
    path
}

fn join_my_drive_relative(parent_relative: &str, name: &str) -> String {
    format!(
        "{}\\{}",
        parent_relative.trim_end_matches(['\\', '/']),
        name
    )
}

fn sanitize_name(name: &str) -> String {
    name.replace(['/', '\\'], "_")
}
