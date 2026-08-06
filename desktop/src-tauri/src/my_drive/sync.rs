use crate::api::ApiClient;
use crate::auth_store::sync_root_dir;
use crate::cfapi::{
    create_file_placeholder, create_named_folder_placeholder, ensure_cloud_placeholder,
    is_duplicate_placeholder_error, mark_directory_partially_populated, notify_directory_updated,
    MY_DRIVE_FOLDER_NAME,
};
use crate::crypto::key_to_b64url;
use crate::db::{
    get_file_key, insert_activity, my_drive_delete_placeholder,
    my_drive_delete_placeholders_under_prefix, my_drive_get_placeholder,
    my_drive_upsert_placeholder, store_file_key, DbHandle,
};
use crate::error::{AppError, AppResult};
use crate::my_drive::{
    api_folder_parent_id, ensure_hydrated_plaintext, fetch_folder_contents, is_under_my_drive,
    relative_path_from_sync_root, resolve_my_drive_root_id,
};
use crate::sync::log::sync_log;
use crate::sync::suppress::WatcherSuppress;
use crate::sync::{DOWNLOAD_CONCURRENCY, UPLOAD_CONCURRENCY};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

/// Callback when My Drive starts transferring (upload/download/folder create).
pub type MyDriveBusyCb = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Debug, Default, Clone)]
pub struct MyDrivePollStats {
    pub folders_created: u32,
    pub files_uploaded: u32,
    pub files_mirrored: u32,
    pub errors: u32,
}

impl MyDrivePollStats {
    pub fn did_work(&self) -> bool {
        self.folders_created > 0 || self.files_uploaded > 0 || self.files_mirrored > 0
    }
}

fn notify_my_drive_busy(on_busy: &Option<MyDriveBusyCb>) {
    if let Some(cb) = on_busy {
        cb("Syncing My Drive…");
    }
}

pub async fn poll_my_drive(
    api: &ApiClient,
    db: &DbHandle,
    mirror: bool,
    download_sem: Arc<Semaphore>,
    upload_sem: Arc<Semaphore>,
    suppress: Option<&WatcherSuppress>,
    on_busy: Option<MyDriveBusyCb>,
) -> AppResult<MyDrivePollStats> {
    let sync_root = sync_root_dir(false)?;
    sync_log(&format!("poll My Drive started (mirror={})", mirror));
    let mut stats = MyDrivePollStats::default();
    poll_my_drive_folder(
        api,
        db,
        &sync_root,
        MY_DRIVE_FOLDER_NAME,
        None,
        mirror,
        download_sem,
        upload_sem,
        suppress,
        &on_busy,
        &mut stats,
    )
    .await?;
    notify_directory_updated(&local_dir_for_relative(&sync_root, MY_DRIVE_FOLDER_NAME));
    sync_log(format!(
        "poll My Drive finished (folders={} uploaded={} mirrored={} errors={})",
        stats.folders_created, stats.files_uploaded, stats.files_mirrored, stats.errors
    ));
    Ok(stats)
}

async fn poll_my_drive_folder(
    api: &ApiClient,
    db: &DbHandle,
    sync_root: &Path,
    parent_relative: &str,
    folder_id: Option<&str>,
    mirror: bool,
    download_sem: Arc<Semaphore>,
    upload_sem: Arc<Semaphore>,
    suppress: Option<&WatcherSuppress>,
    on_busy: &Option<MyDriveBusyCb>,
    stats: &mut MyDrivePollStats,
) -> AppResult<()> {
    let contents =
        fetch_folder_contents(api, db, sync_root, parent_relative, folder_id).await?;
    let local_dir = local_dir_for_relative(sync_root, parent_relative);
    let mut local_only_folders = Vec::new();
    if std::fs::create_dir_all(&local_dir).is_ok() {
        apply_remote_children(db, parent_relative, &local_dir, &contents, suppress);
        reconcile_local_against_remote(db, parent_relative, &local_dir, &contents, suppress);
        let parent_id = match folder_id {
            Some(id) => id.to_string(),
            None => resolve_my_drive_root_id(db)?,
        };
        local_only_folders = upload_local_only_children(
            api,
            db,
            parent_relative,
            &parent_id,
            &local_dir,
            &contents,
            upload_sem.clone(),
            on_busy,
            stats,
        )
        .await;
        notify_directory_updated(&local_dir);
    }

    if mirror {
        mirror_files_parallel(
            api,
            db,
            &local_dir,
            &contents.files,
            download_sem.clone(),
            on_busy,
            stats,
        )
        .await;
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
            upload_sem.clone(),
            suppress,
            on_busy,
            stats,
        ))
        .await?;
    }

    for (sub_rel, folder_remote_id) in local_only_folders {
        Box::pin(poll_my_drive_folder(
            api,
            db,
            sync_root,
            &sub_rel,
            Some(&folder_remote_id),
            mirror,
            download_sem.clone(),
            upload_sem.clone(),
            suppress,
            on_busy,
            stats,
        ))
        .await?;
    }

    Ok(())
}

/// Upload local-only files and register local-only folders under one My Drive directory.
/// Returns newly registered folders `(relative, remote_id)` for recursion in the same poll.
async fn upload_local_only_children(
    api: &ApiClient,
    db: &DbHandle,
    parent_relative: &str,
    parent_folder_id: &str,
    local_dir: &Path,
    contents: &crate::api::types::FolderContents,
    upload_sem: Arc<Semaphore>,
    on_busy: &Option<MyDriveBusyCb>,
    stats: &mut MyDrivePollStats,
) -> Vec<(String, String)> {
    let mut remote_names: HashSet<String> = HashSet::new();
    for folder in &contents.folders {
        remote_names.insert(sanitize_name(&folder.name).to_ascii_lowercase());
    }
    for file in &contents.files {
        remote_names.insert(sanitize_name(&file.name).to_ascii_lowercase());
    }

    let entries = match std::fs::read_dir(local_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut folders_to_register: Vec<(String, PathBuf, String)> = Vec::new();
    let mut files_to_upload: Vec<PathBuf> = Vec::new();

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
        if tracked {
            continue;
        }
        if path.is_dir() {
            folders_to_register.push((name, path, child_relative));
        } else if path.is_file() {
            if crate::sync::should_skip_file(&name) {
                continue;
            }
            // Skip orphan CfAPI dehydrate placeholders (reparse) without a DB row.
            if path_has_reparse_point(&path) {
                continue;
            }
            files_to_upload.push(path);
        }
    }

    if !folders_to_register.is_empty() || !files_to_upload.is_empty() {
        notify_my_drive_busy(on_busy);
    }

    let mut registered_folders = Vec::new();
    for (name, path, child_relative) in folders_to_register {
        match api
            .create_or_resolve_folder(&name, api_folder_parent_id(parent_folder_id))
            .await
        {
            Ok(folder) => {
                if let Ok(conn) = db.lock() {
                    let _ = my_drive_upsert_placeholder(
                        &conn,
                        &child_relative,
                        &folder.id,
                        "folder",
                        api_folder_parent_id(parent_folder_id),
                    );
                }
                if let Err(e) = ensure_cloud_placeholder(&path, "folder", &folder.id) {
                    sync_log(format!(
                        "My Drive local-scan folder placeholder {}: {}",
                        path.display(),
                        e
                    ));
                }
                sync_log(format!(
                    "My Drive folder created (local scan) — {}",
                    child_relative
                ));
                stats.folders_created += 1;
                registered_folders.push((child_relative, folder.id));
            }
            Err(e) => {
                stats.errors += 1;
                sync_log(format!(
                    "My Drive local-scan folder failed {}\\{}: {}",
                    parent_relative, name, e
                ));
            }
        }
    }

    let uploaded = Arc::new(AtomicU32::new(0));
    let upload_errors = Arc::new(AtomicU32::new(0));
    let mut join_set = JoinSet::new();
    for path in files_to_upload {
        while join_set.len() >= UPLOAD_CONCURRENCY {
            if let Some(res) = join_set.join_next().await {
                if let Err(e) = res {
                    upload_errors.fetch_add(1, Ordering::Relaxed);
                    sync_log(format!("My Drive local-scan upload join error — {}", e));
                }
            }
        }
        let permit = match upload_sem.clone().acquire_owned().await {
            Ok(permit) => permit,
            Err(_) => break,
        };
        let api = api.clone();
        let db = db.clone();
        let uploaded = Arc::clone(&uploaded);
        let upload_errors = Arc::clone(&upload_errors);
        join_set.spawn(async move {
            let _permit = permit;
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
                .to_string();
            match upload_my_drive_path(&api, &db, &path).await {
                Ok(()) => {
                    uploaded.fetch_add(1, Ordering::Relaxed);
                    sync_log(format!("My Drive uploaded (local scan) — {}", name));
                }
                Err(e) => {
                    upload_errors.fetch_add(1, Ordering::Relaxed);
                    sync_log(format!(
                        "My Drive local-scan upload failed {}: {}",
                        path.display(),
                        e
                    ));
                }
            }
        });
    }
    while let Some(res) = join_set.join_next().await {
        if let Err(e) = res {
            upload_errors.fetch_add(1, Ordering::Relaxed);
            sync_log(format!("My Drive local-scan upload join error — {}", e));
        }
    }
    stats.files_uploaded += uploaded.load(Ordering::Relaxed);
    stats.errors += upload_errors.load(Ordering::Relaxed);

    registered_folders
}

fn path_has_reparse_point(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        std::fs::metadata(path)
            .map(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

/// Create missing local placeholders for remote children (e.g. after Trash→Restore).
/// Re-enables on-demand FETCH when the folder was previously marked fully populated empty.
fn apply_remote_children(
    db: &DbHandle,
    parent_relative: &str,
    local_dir: &Path,
    contents: &crate::api::types::FolderContents,
    suppress: Option<&WatcherSuppress>,
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

    let mut created = 0u32;
    let mut skipped = 0u32;

    for folder in &contents.folders {
        let name = sanitize_name(&folder.name);
        let folder_path = local_dir.join(&name);
        match create_named_folder_placeholder(local_dir, &name, &folder.id) {
            Ok(()) => created += 1,
            Err(e) if is_duplicate_placeholder_error(&e) => {
                skipped += 1;
                ensure_or_replace_folder_placeholder(
                    local_dir,
                    &folder_path,
                    &name,
                    &folder.id,
                    suppress,
                );
            }
            Err(e) => {
                sync_log(format!(
                    "My Drive folder placeholder failed {}\\{}: {}",
                    parent_relative, name, e
                ));
            }
        }
    }

    // Ensure parent is a cloud placeholder before creating file children.
    if let Ok(conn) = db.lock() {
        if let Ok(Some((remote_id, _))) = my_drive_get_placeholder(&conn, parent_relative) {
            if let Err(e) = ensure_cloud_placeholder(local_dir, "folder", &remote_id) {
                sync_log(format!(
                    "My Drive ensure parent cloud placeholder {}: {}",
                    local_dir.display(),
                    e
                ));
            }
        }
    }

    for file in &contents.files {
        match create_file_placeholder(local_dir, file) {
            Ok(()) => created += 1,
            Err(e) if is_duplicate_placeholder_error(&e) => skipped += 1,
            Err(e) => {
                sync_log(format!(
                    "My Drive file placeholder failed {}\\{}: {}",
                    parent_relative, file.name, e
                ));
            }
        }
    }

    if created > 0 || skipped > 0 {
        sync_log(format!(
            "My Drive placeholders under {} — created={} skipped={}",
            parent_relative, created, skipped
        ));
    }

    if had_missing {
        if let Ok(conn) = db.lock() {
            for folder in &missing_folders {
                let _ = insert_activity(&conn, &folder.name, "Restored from cloud", 0, "synced");
            }
            for file in &missing_files {
                let _ = insert_activity(
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

/// When a leftover plain directory blocks CfCreatePlaceholders, convert it to a
/// cloud placeholder — or replace an empty leftover if convert fails.
fn ensure_or_replace_folder_placeholder(
    parent_dir: &Path,
    folder_path: &Path,
    name: &str,
    remote_id: &str,
    suppress: Option<&WatcherSuppress>,
) {
    if let Err(e) = ensure_cloud_placeholder(folder_path, "folder", remote_id) {
        sync_log(format!(
            "My Drive ensure_cloud_placeholder {}: {}",
            folder_path.display(),
            e
        ));
    }

    // Already a usable cloud folder?
    if mark_directory_partially_populated(folder_path).is_ok() {
        return;
    }

    let is_empty = folder_path.is_dir()
        && std::fs::read_dir(folder_path)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);
    if !is_empty {
        sync_log(format!(
            "My Drive leftover folder not cloud and not empty — {}",
            folder_path.display()
        ));
        return;
    }

    let remove_ok = if let Some(suppress) = suppress {
        suppress.run_suppressed(folder_path, || std::fs::remove_dir_all(folder_path).is_ok())
    } else {
        std::fs::remove_dir_all(folder_path).is_ok()
    };
    if !remove_ok {
        sync_log(format!(
            "My Drive failed to remove leftover folder — {}",
            folder_path.display()
        ));
        return;
    }
    match create_named_folder_placeholder(parent_dir, name, remote_id) {
        Ok(()) => sync_log(format!(
            "My Drive replaced leftover folder — {}",
            folder_path.display()
        )),
        Err(e) => sync_log(format!(
            "My Drive recreate folder after replace failed {}: {}",
            folder_path.display(),
            e
        )),
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
/// are left for `upload_local_only_children` (pending upload).
fn reconcile_local_against_remote(
    db: &DbHandle,
    parent_relative: &str,
    local_dir: &Path,
    contents: &crate::api::types::FolderContents,
    suppress: Option<&WatcherSuppress>,
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
        // Clear DB first so NOTIFY_DELETE / watcher cannot re-trash on the server.
        if let Ok(conn) = db.lock() {
            let _ = my_drive_delete_placeholders_under_prefix(&conn, &child_relative);
        }
        let remove_ok = if let Some(suppress) = suppress {
            suppress.run_suppressed(&path, || {
                if path.is_dir() {
                    std::fs::remove_dir_all(&path).is_ok()
                } else {
                    std::fs::remove_file(&path).is_ok()
                }
            })
        } else if path.is_dir() {
            std::fs::remove_dir_all(&path).is_ok()
        } else {
            std::fs::remove_file(&path).is_ok()
        };
        if remove_ok {
            sync_log(format!("My Drive reconcile removed — {}", child_relative));
        } else {
            sync_log(format!(
                "My Drive reconcile failed to remove disk path — {}",
                child_relative
            ));
        }
    }
}

async fn mirror_files_parallel(
    api: &ApiClient,
    db: &DbHandle,
    local_dir: &Path,
    files: &[crate::api::types::FileRecord],
    download_sem: Arc<Semaphore>,
    on_busy: &Option<MyDriveBusyCb>,
    stats: &mut MyDrivePollStats,
) {
    let needs_any = files.iter().any(|file| {
        let local_path = local_dir.join(sanitize_name(&file.name));
        match std::fs::metadata(&local_path) {
            Ok(meta) => meta.len() < file.size.max(0) as u64,
            Err(_) => true,
        }
    });
    if needs_any {
        notify_my_drive_busy(on_busy);
    }

    let mirrored = Arc::new(AtomicU32::new(0));
    let mirror_errors = Arc::new(AtomicU32::new(0));
    let mut join_set = JoinSet::new();

    for file in files {
        while join_set.len() >= DOWNLOAD_CONCURRENCY {
            if let Some(res) = join_set.join_next().await {
                if let Err(e) = res {
                    mirror_errors.fetch_add(1, Ordering::Relaxed);
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
        let mirrored = Arc::clone(&mirrored);
        let mirror_errors = Arc::clone(&mirror_errors);

        join_set.spawn(async move {
            let _permit = permit;
            match mirror_file_if_needed(&api, &db, &local_dir, &file).await {
                Ok(true) => {
                    mirrored.fetch_add(1, Ordering::Relaxed);
                }
                Ok(false) => {}
                Err(e) => {
                    mirror_errors.fetch_add(1, Ordering::Relaxed);
                    sync_log(format!("mirror {} failed: {}", file.name, e));
                }
            }
        });
    }

    while let Some(res) = join_set.join_next().await {
        if let Err(e) = res {
            mirror_errors.fetch_add(1, Ordering::Relaxed);
            sync_log(format!("mirror task join error — {}", e));
        }
    }
    stats.files_mirrored += mirrored.load(Ordering::Relaxed);
    stats.errors += mirror_errors.load(Ordering::Relaxed);
}

/// Returns `true` when plaintext was copied into the local My Drive path.
async fn mirror_file_if_needed(
    api: &ApiClient,
    db: &DbHandle,
    local_dir: &Path,
    file: &crate::api::types::FileRecord,
) -> AppResult<bool> {
    let local_path = local_dir.join(sanitize_name(&file.name));
    let needs = match std::fs::metadata(&local_path) {
        Ok(meta) => meta.len() < file.size.max(0) as u64,
        Err(_) => true,
    };
    if !needs {
        return Ok(false);
    }
    let cached = ensure_hydrated_plaintext(api, db, &file.id).await?;
    if let Some(parent) = local_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::copy(&cached, &local_path)?;
    Ok(true)
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
    let api_parent = api_folder_parent_id(&parent_folder_id);
    let (rec, key) = api
        .upload_file(db, path, &file_name, api_parent, None)
        .await?;
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    store_file_key(&conn, &rec.id, &key_to_b64url(&key))?;
    my_drive_upsert_placeholder(&conn, &relative, &rec.id, "file", api_parent)?;
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
    ensure_my_drive_folder_relative(api, db, &parent_relative).await
}

/// Ensure a My Drive folder (and its parents) exist on the server; return remote id.
pub async fn ensure_my_drive_folder_relative(
    api: &ApiClient,
    db: &DbHandle,
    folder_relative: &str,
) -> AppResult<String> {
    let folder_relative = folder_relative.replace('/', "\\");
    if folder_relative.eq_ignore_ascii_case(MY_DRIVE_FOLDER_NAME) {
        return resolve_my_drive_root_id(db);
    }

    if let Ok(conn) = db.lock() {
        if let Some((remote_id, item_type)) = my_drive_get_placeholder(&conn, &folder_relative)? {
            if item_type == "folder" {
                return Ok(remote_id);
            }
        }
    }

    let root_id = resolve_my_drive_root_id(db)?;
    let suffix = folder_relative
        .strip_prefix("My Drive\\")
        .or_else(|| folder_relative.strip_prefix("My Drive/"))
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
            .create_or_resolve_folder(&part, api_folder_parent_id(&current_parent))
            .await?;
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        my_drive_upsert_placeholder(
            &conn,
            &built_relative,
            &folder.id,
            "folder",
            api_folder_parent_id(&current_parent),
        )?;
        current_parent = folder.id;
    }

    Ok(current_parent)
}

/// Create/resolve a local My Drive folder path on the server and mark it as a cloud folder.
pub async fn ensure_my_drive_folder_path(
    api: &ApiClient,
    db: &DbHandle,
    path: &Path,
) -> AppResult<String> {
    let sync_root = sync_root_dir(false)?;
    let relative = relative_path_from_sync_root(&sync_root, path)
        .ok_or_else(|| AppError::msg("path outside sync root"))?;
    if !is_under_my_drive(&relative) {
        return Err(AppError::msg("path not under My Drive"));
    }
    let remote_id = ensure_my_drive_folder_relative(api, db, &relative).await?;
    if let Err(e) = ensure_cloud_placeholder(path, "folder", &remote_id) {
        sync_log(format!(
            "My Drive ensure folder cloud placeholder {}: {}",
            path.display(),
            e
        ));
    }
    sync_log(format!("My Drive folder ensured — {}", relative));
    Ok(remote_id)
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
