use crate::api::client::ApiClient;
use crate::api::types::SyncChange;
use crate::db::{
    delete_folder_mapping, delete_sync_state_row, list_folder_mappings, list_sync_folders,
    set_folder_mapping, upsert_sync_state_with_version, DbHandle,
};
use crate::error::{AppError, AppResult};
use crate::sync::engine::SyncEngine;
use crate::sync::log::sync_log;
use crate::sync::suppress::WatcherSuppress;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn is_windows_reserved_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn validate_path_component(component: &str) -> AppResult<()> {
    if component.is_empty()
        || component == "."
        || component == ".."
        || component.ends_with([' ', '.'])
        || component.chars().any(|c| c.is_control() || r#"<>:"|?*"#.contains(c))
        || is_windows_reserved_name(component)
    {
        return Err(AppError::msg("unsafe remote path component"));
    }
    Ok(())
}

fn safe_join(root: &str, relative: &str) -> AppResult<PathBuf> {
    if relative.trim().is_empty() {
        return Err(AppError::msg("empty remote path"));
    }
    let mut out = PathBuf::from(root);
    let mut count = 0usize;
    for component in relative.split(['/', '\\']) {
        validate_path_component(component)?;
        out.push(component);
        count += 1;
    }
    if count == 0 {
        return Err(AppError::msg("empty remote path"));
    }
    Ok(out)
}

fn current_user_id() -> AppResult<String> {
    crate::auth_store::load_auth()
        .ok()
        .flatten()
        .and_then(|a| serde_json::from_str::<serde_json::Value>(&a.user_json).ok())
        .and_then(|v| {
            v.get("id")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| AppError::msg("not authenticated"))
}

pub async fn apply_remote_change(
    engine: &SyncEngine,
    api: &ApiClient,
    db: &DbHandle,
    suppress: &WatcherSuppress,
    computer_root_id: &str,
    change: &SyncChange,
) -> AppResult<()> {
    if change.operation == "snapshot" {
        return Ok(());
    }

    match change.operation.as_str() {
        "create" | "update" | "restore" => {
            if change.entity_type == "file" {
                apply_remote_file(engine, api, db, suppress, computer_root_id, change).await
            } else {
                apply_remote_folder_create(db, suppress, computer_root_id, change)
            }
        }
        "rename" | "move" => {
            if change.entity_type == "file" {
                apply_remote_file_rename(db, suppress, computer_root_id, change)
            } else {
                apply_remote_folder_rename(db, suppress, computer_root_id, change)
            }
        }
        "trash" | "permanent_delete" => apply_remote_delete(db, suppress, change),
        _ => Ok(()),
    }
}

fn resolve_sync_context(
    conn: &rusqlite::Connection,
    computer_root_id: &str,
    parent_id: Option<&str>,
    name: &str,
) -> AppResult<Option<(i64, String, String)>> {
    let parent_id = match parent_id {
        Some(id) if !id.is_empty() => id,
        _ => computer_root_id,
    };

    let folders = list_sync_folders(conn)?;
    let mut remote_to_relative: HashMap<String, (i64, String)> = HashMap::new();
    for sf in &folders {
        if crate::db::is_pending_remote_folder(&sf.remote_folder_id) {
            continue;
        }
        remote_to_relative.insert(sf.remote_folder_id.clone(), (sf.id, String::new()));
        for mapping in list_folder_mappings(conn, sf.id)? {
            remote_to_relative.insert(mapping.remote_folder_id, (sf.id, mapping.relative_path));
        }
    }

    let (sync_folder_id, parent_relative) = match remote_to_relative.get(parent_id) {
        Some(v) => v.clone(),
        None => return Ok(None),
    };

    let relative = if parent_relative.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", parent_relative, name)
    };

    let local_root = folders
        .iter()
        .find(|f| f.id == sync_folder_id)
        .map(|f| f.local_path.clone())
        .unwrap_or_default();

    Ok(Some((sync_folder_id, local_root, relative)))
}

async fn apply_remote_file(
    engine: &SyncEngine,
    api: &ApiClient,
    db: &DbHandle,
    suppress: &WatcherSuppress,
    computer_root_id: &str,
    change: &SyncChange,
) -> AppResult<()> {
    // Skip download when local copy is already at this remote version.
    // Legacy rows (remote_version=0) with a matching remote_file_id are treated as
    // up-to-date only when the server version is still the initial create (≤1).
    {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        if let Some((_sf_id, _rel, local_path, remote_version)) =
            crate::db::get_sync_state_detail_by_remote_file_id(&conn, &change.entity_id)?
        {
            if Path::new(&local_path).is_file()
                && (remote_version >= change.version
                    || (remote_version == 0 && change.version <= 1))
            {
                return Ok(());
            }
        }
    }

    let (sync_folder_id, local_root, relative) = {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        match resolve_sync_context(
            &conn,
            computer_root_id,
            change.parent_id.as_deref(),
            &change.name,
        )? {
            Some(ctx) => ctx,
            None => return Ok(()),
        }
    };

    let local_path = safe_join(&local_root, &relative)?;
    let mut download_path = local_path.clone();
    let mut is_conflict = false;

    let pending_local = {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        crate::db::has_pending_journal_for_path(&conn, sync_folder_id, &relative)?
    };
    if pending_local {
        return Ok(());
    }

    // Path-based safeguards: never clobber newer local content. Previously-synced
    // files deleted locally (Some + missing) propagate a server delete. Untracked
    // remotes (None + missing) are downloaded — restore / web create while offline.
    let is_restore = change.operation.eq_ignore_ascii_case("restore");
    let state_row = {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        crate::db::get_sync_state(&conn, sync_folder_id, &relative)?
    };
    let file_exists = local_path.is_file();
    match &state_row {
        Some((stored_remote_id, _hash, stored_mtime, _status)) => {
            if file_exists {
                if let Some(rid) = stored_remote_id {
                    if rid != &change.entity_id {
                        sync_log(format!(
                            "skip remote file {} -> {} (duplicate on server, local tracks {})",
                            change.entity_id, relative, rid
                        ));
                        return Ok(());
                    }
                }
                let current_mtime = local_path
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64);
                if stored_mtime.is_some() && current_mtime != *stored_mtime {
                    sync_log(format!(
                        "preserve remote file {} -> {} (local copy also modified)",
                        change.entity_id, relative
                    ));
                    download_path = conflict_copy_path(&local_path);
                    is_conflict = true;
                }
            } else if !is_restore && Path::new(&local_root).exists() {
                // File was synced before and is now gone locally: the user deleted
                // it while the app was not watching. Propagate the delete instead
                // of re-downloading. (Skipped for restore — download below.)
                if let Some(rid) = stored_remote_id.clone() {
                    crate::sync::journal::enqueue_file_delete(
                        db,
                        sync_folder_id,
                        &relative,
                        &rid,
                    )?;
                    sync_log(format!(
                        "remote file {} -> {} deleted locally, queued server delete",
                        change.entity_id, relative
                    ));
                } else {
                    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                    delete_sync_state_row(&conn, sync_folder_id, &relative)?;
                }
                return Ok(());
            }
        }
        None => {
            if file_exists {
                // Local file exists but was never synced — the upload scan will
                // reconcile it. Downloading now could overwrite newer content.
                sync_log(format!(
                    "skip remote file {} -> {} (untracked local copy exists)",
                    change.entity_id, relative
                ));
                return Ok(());
            }
            // No sync_state and no local file: new / restored / uploaded-via-web.
            // Download below — do NOT trash on the server (that re-trashed restores
            // done while the desktop app was offline). Genuine local deletes of
            // previously synced files are handled by the Some branch and by
            // reconcile_local_deletions.
        }
    }

    if is_restore {
        sync_log(format!(
            "remote file {} -> {} restored, downloading",
            change.entity_id, relative
        ));
    }

    if let Some(parent) = download_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let user_id = match current_user_id() {
        Ok(id) => id,
        Err(e) => {
            sync_log(format!(
                "skip remote file {}: {}",
                change.entity_id, e
            ));
            return Ok(());
        }
    };
    let key_b64url =
        match crate::account_crypto::resolve_file_key(api, db, &user_id, &change.entity_id).await {
            Ok(key) => key,
            Err(e) => {
                sync_log(format!(
                    "skip remote file {} (no encryption key): {}",
                    change.entity_id, e
                ));
                return Ok(());
            }
        };

    suppress.run_suppressed(&download_path, || {});
    let plaintext = api
        .download_file(&change.entity_id, Some(&key_b64url))
        .await?;
    let tmp = download_path.with_extension("freedrive.tmp");
    std::fs::write(&tmp, &plaintext)?;
    std::fs::rename(&tmp, &download_path)?;

    if is_conflict {
        let name = download_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("conflict copy");
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        crate::db::insert_activity(
            &conn,
            name,
            "Both local and cloud changed; kept both copies",
            plaintext.len() as i64,
            "conflict",
        )?;
        sync_log(format!(
            "created conflict copy {} for remote file {}",
            download_path.display(),
            change.entity_id
        ));
        return Ok(());
    }

    let mtime = local_path
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);

    {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        upsert_sync_state_with_version(
            &conn,
            sync_folder_id,
            &relative,
            &local_path.to_string_lossy(),
            Some(&change.entity_id),
            None,
            mtime,
            Some(&change.occurred_at),
            change.version,
            "synced",
        )?;
    }

    sync_log(format!("applied remote file {} -> {}", change.entity_id, relative));
    if is_restore {
        let name = Path::new(&relative)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(change.name.as_str());
        // Must not hold db lock — emit_activity_append locks again.
        engine.emit_activity_append(name, "Restored from cloud", 0, "synced");
    }
    Ok(())
}

fn conflict_copy_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let extension = path.extension().and_then(|value| value.to_str());
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H%M%S");
    for suffix in 0..1000u32 {
        let marker = if suffix == 0 {
            String::new()
        } else {
            format!(" {suffix}")
        };
        let name = match extension {
            Some(ext) => format!("{stem} (FreeDrive conflict {timestamp}){marker}.{ext}"),
            None => format!("{stem} (FreeDrive conflict {timestamp}){marker}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem} (FreeDrive conflict {}).copy", uuid::Uuid::new_v4()))
}

fn apply_remote_folder_create(
    db: &DbHandle,
    suppress: &WatcherSuppress,
    computer_root_id: &str,
    change: &SyncChange,
) -> AppResult<()> {
    let (sync_folder_id, local_root, relative) = {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        match resolve_sync_context(
            &conn,
            computer_root_id,
            change.parent_id.as_deref(),
            &change.name,
        )? {
            Some(ctx) => ctx,
            None => return Ok(()),
        }
    };

    let local_path = safe_join(&local_root, &relative)?;
    suppress.run_suppressed(&local_path, || {
        std::fs::create_dir_all(&local_path).ok();
    });

    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    set_folder_mapping(&conn, sync_folder_id, &relative, &change.entity_id)?;
    Ok(())
}

fn apply_remote_file_rename(
    db: &DbHandle,
    suppress: &WatcherSuppress,
    computer_root_id: &str,
    change: &SyncChange,
) -> AppResult<()> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    if let Some((sync_folder_id, old_relative)) =
        crate::db::get_sync_state_by_remote_file_id(&conn, &change.entity_id)?
    {
        let sf = list_sync_folders(&conn)?
            .into_iter()
            .find(|f| f.id == sync_folder_id);
        if let Some(sf) = sf {
            let old_path = safe_join(&sf.local_path, &old_relative)?;
            let new_relative = if change.parent_id.is_some() {
                resolve_sync_context(
                    &conn,
                    computer_root_id,
                    change.parent_id.as_deref(),
                    &change.name,
                )?
                .map(|(_, _, r)| r)
                .unwrap_or_else(|| change.name.clone())
            } else {
                Path::new(&old_relative)
                    .parent()
                    .map(|p| {
                        let parent = p.to_string_lossy().replace('\\', "/");
                        if parent.is_empty() {
                            change.name.clone()
                        } else {
                            format!("{}/{}", parent, change.name)
                        }
                    })
                    .unwrap_or_else(|| change.name.clone())
            };
            let new_path = safe_join(&sf.local_path, &new_relative)?;
            suppress.run_suppressed(&new_path, || {
                if old_path.exists() {
                    if let Some(parent) = new_path.parent() {
                        std::fs::create_dir_all(parent).ok();
                    }
                    let _ = std::fs::rename(&old_path, &new_path);
                }
            });
            delete_sync_state_row(&conn, sync_folder_id, &old_relative)?;
            upsert_sync_state_with_version(
                &conn,
                sync_folder_id,
                &new_relative,
                &new_path.to_string_lossy(),
                Some(&change.entity_id),
                None,
                None,
                Some(&change.occurred_at),
                change.version,
                "synced",
            )?;
        }
    }
    Ok(())
}

fn apply_remote_folder_rename(
    db: &DbHandle,
    suppress: &WatcherSuppress,
    _computer_root_id: &str,
    change: &SyncChange,
) -> AppResult<()> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    let folders = list_sync_folders(&conn)?;
    for sf in folders {
        if let Some(old_rel) = find_relative_for_remote_folder(&conn, sf.id, &change.entity_id)? {
            let old_path = safe_join(&sf.local_path, &old_rel)?;
            let parent_relative = Path::new(&old_rel)
                .parent()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let new_relative = if parent_relative.is_empty() {
                change.name.clone()
            } else {
                format!("{}/{}", parent_relative, change.name)
            };
            let new_path = safe_join(&sf.local_path, &new_relative)?;
            suppress.run_suppressed(&new_path, || {
                if old_path.exists() {
                    if let Some(parent) = new_path.parent() {
                        std::fs::create_dir_all(parent).ok();
                    }
                    let _ = std::fs::rename(&old_path, &new_path);
                }
            });
            delete_folder_mapping(&conn, sf.id, &old_rel)?;
            set_folder_mapping(&conn, sf.id, &new_relative, &change.entity_id)?;
            break;
        }
    }
    Ok(())
}

fn find_relative_for_remote_folder(
    conn: &rusqlite::Connection,
    sync_folder_id: i64,
    remote_folder_id: &str,
) -> AppResult<Option<String>> {
    let sf = list_sync_folders(conn)?
        .into_iter()
        .find(|f| f.id == sync_folder_id);
    if let Some(sf) = sf {
        if sf.remote_folder_id == remote_folder_id {
            return Ok(Some(String::new()));
        }
    }
    for mapping in list_folder_mappings(conn, sync_folder_id)? {
        if mapping.remote_folder_id == remote_folder_id {
            return Ok(Some(mapping.relative_path));
        }
    }
    Ok(None)
}

fn apply_remote_delete(
    db: &DbHandle,
    suppress: &WatcherSuppress,
    change: &SyncChange,
) -> AppResult<()> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    if change.entity_type == "file" {
        if let Some((sync_folder_id, relative)) =
            crate::db::get_sync_state_by_remote_file_id(&conn, &change.entity_id)?
        {
            let sf = list_sync_folders(&conn)?
                .into_iter()
                .find(|f| f.id == sync_folder_id);
            if let Some(sf) = sf {
                let local_path = safe_join(&sf.local_path, &relative)?;
                suppress.run_suppressed(&local_path, || {
                    let _ = std::fs::remove_file(&local_path);
                });
                delete_sync_state_row(&conn, sync_folder_id, &relative)?;
            }
        }
    } else if change.entity_type == "folder" {
        let folders = list_sync_folders(&conn)?;
        for sf in folders {
            if let Some(rel) = find_relative_for_remote_folder(&conn, sf.id, &change.entity_id)? {
                let local_path = safe_join(&sf.local_path, &rel)?;
                suppress.run_suppressed(&local_path, || {
                    let _ = std::fs::remove_dir_all(&local_path);
                });
                delete_folder_mapping(&conn, sf.id, &rel)?;
                conn.execute(
                    "DELETE FROM sync_state WHERE sync_folder_id = ?1 AND (relative_path = ?2 OR relative_path LIKE ?3)",
                    rusqlite::params![sf.id, rel, format!("{}/%", rel)],
                )?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod path_tests {
    use super::{conflict_copy_path, safe_join};

    #[test]
    fn safe_join_rejects_traversal_and_windows_special_names() {
        for bad in ["../outside.txt", "dir\\..\\outside.txt", "C:/boot.ini", "CON", "safe/NUL.txt", ""] {
            assert!(safe_join("C:\\sync", bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn safe_join_accepts_normal_nested_path() {
        let path = safe_join("C:\\sync", "docs/report.txt").unwrap();
        assert!(path.ends_with(PathBuf::from("docs").join("report.txt")));
    }

    #[test]
    fn conflict_copy_preserves_extension_and_name() {
        let path = conflict_copy_path(std::path::Path::new("docs/report.pdf"));
        let name = path.file_name().unwrap().to_string_lossy();
        assert!(name.starts_with("report (FreeDrive conflict "));
        assert!(name.ends_with(".pdf"));
    }

    use std::path::PathBuf;
}

pub async fn apply_snapshot(
    engine: &SyncEngine,
    api: &ApiClient,
    db: &DbHandle,
    suppress: &WatcherSuppress,
    computer_root_id: &str,
    snapshot: &crate::api::types::ComputerSnapshot,
) -> AppResult<()> {
    for folder in &snapshot.folders {
        if folder.id == computer_root_id {
            continue;
        }
        let change = SyncChange {
            seq: 0,
            entity_type: "folder".into(),
            entity_id: folder.id.clone(),
            parent_id: folder.parent_id.clone(),
            operation: "create".into(),
            name: folder.name.clone(),
            version: 0,
            occurred_at: String::new(),
            payload: None,
            is_tombstone: false,
        };
        if let Err(e) = apply_remote_folder_create(db, suppress, computer_root_id, &change) {
            sync_log(format!(
                "snapshot folder {} failed: {}",
                folder.id, e
            ));
        }
    }
    for file in &snapshot.files {
        let change = SyncChange {
            seq: 0,
            entity_type: "file".into(),
            entity_id: file.id.clone(),
            parent_id: file.folder_id.clone(),
            operation: "create".into(),
            name: file.name.clone(),
            version: file.version,
            occurred_at: file.updated_at.clone(),
            payload: None,
            is_tombstone: false,
        };
        if let Err(e) =
            apply_remote_file(engine, api, db, suppress, computer_root_id, &change).await
        {
            sync_log(format!("snapshot file {} failed: {}", file.id, e));
        }
    }
    Ok(())
}
