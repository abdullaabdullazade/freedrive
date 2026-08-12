use crate::api::client::ApiClient;
use crate::db::{
    delete_folder_mapping, delete_sync_state_row, delete_sync_state_row_if_remote_matches,
    mark_journal_done, mark_journal_retry, set_folder_mapping, DbHandle, JournalEntry,
};
use crate::error::{AppError, AppResult};
use crate::sync::engine::SyncEngine;
use crate::sync::log::sync_log;
use std::path::Path;

/// The target is already gone on the server — treat the delete as done.
fn is_not_found(e: &AppError) -> bool {
    let msg = e.to_string().to_lowercase();
    msg.contains("not found") || msg.contains("404")
}

/// After this many failed attempts, skip rename so deletes are not HOL-blocked.
const RENAME_SKIP_AFTER_ATTEMPTS: i32 = 5;

pub async fn process_journal_entry(
    engine: &SyncEngine,
    api: &ApiClient,
    db: &DbHandle,
    entry: &JournalEntry,
) -> AppResult<()> {
    match entry.operation.as_str() {
        "file_delete" => {
            if let Some(ref remote_id) = entry.remote_entity_id {
                match api
                    .delete_file_with_mutation(remote_id, Some(&entry.client_mutation_id))
                    .await
                {
                    Ok(()) => {}
                    Err(e) if is_not_found(&e) => {
                        sync_log(format!("file {} already gone on server", remote_id));
                    }
                    Err(e) => return Err(e),
                }
            }
            {
                let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                if let Some(remote_id) = entry.remote_entity_id.as_deref() {
                    delete_sync_state_row_if_remote_matches(
                        &conn,
                        entry.sync_folder_id,
                        &entry.relative_path,
                        remote_id,
                    )?;
                } else {
                    delete_sync_state_row(&conn, entry.sync_folder_id, &entry.relative_path)?;
                }
                mark_journal_done(&conn, entry.id)?;
            }
            // Emit after releasing db lock — emit_activity_public locks db again.
            let name = Path::new(&entry.relative_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file");
            engine.emit_activity_append(name, "Removed from cloud", 0, "deleted");
        }
        "folder_delete" => {
            if let Some(ref remote_id) = entry.remote_entity_id {
                match api
                    .delete_folder_with_mutation(remote_id, Some(&entry.client_mutation_id))
                    .await
                {
                    Ok(()) => {}
                    Err(e) if is_not_found(&e) => {
                        sync_log(format!("folder {} already gone on server", remote_id));
                    }
                    Err(e) => return Err(e),
                }
            }
            {
                let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                delete_folder_mapping(&conn, entry.sync_folder_id, &entry.relative_path)?;
                clear_sync_prefix(&conn, entry.sync_folder_id, &entry.relative_path)?;
                mark_journal_done(&conn, entry.id)?;
            }
            // Emit after releasing db lock — emit_activity_append locks db again.
            let name = Path::new(&entry.relative_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("folder");
            engine.emit_activity_append(name, "Removed from cloud", 0, "deleted");
        }
        "file_rename" => {
            let remote_id = entry
                .remote_entity_id
                .as_deref()
                .ok_or_else(|| AppError::msg("file rename journal missing remote id"))?;
            let new_name = Path::new(&entry.relative_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file");
            match api
                .patch_file(
                    remote_id,
                    Some(new_name),
                    None,
                    Some(&entry.client_mutation_id),
                )
                .await
            {
                Ok(_) => {}
                Err(e) if is_not_found(&e) => {
                    sync_log(format!(
                        "file rename {} already gone on server — marking done",
                        remote_id
                    ));
                }
                Err(e) if entry.attempts >= RENAME_SKIP_AFTER_ATTEMPTS => {
                    sync_log(format!(
                        "file rename {} skipped after {} attempts: {}",
                        entry.id, entry.attempts, e
                    ));
                }
                Err(e) => return Err(e),
            }
            let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            if let Some(old) = &entry.old_relative_path {
                delete_sync_state_row(&conn, entry.sync_folder_id, old)?;
            }
            mark_journal_done(&conn, entry.id)?;
        }
        "folder_rename" => {
            let remote_id = entry
                .remote_entity_id
                .as_deref()
                .ok_or_else(|| AppError::msg("folder rename journal missing remote id"))?;
            let new_name = Path::new(&entry.relative_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("folder");
            match api
                .patch_folder(
                    remote_id,
                    Some(new_name),
                    None,
                    Some(&entry.client_mutation_id),
                )
                .await
            {
                Ok(_) => {}
                Err(e) if is_not_found(&e) => {
                    sync_log(format!(
                        "folder rename {} already gone on server — marking done",
                        remote_id
                    ));
                }
                Err(e) if entry.attempts >= RENAME_SKIP_AFTER_ATTEMPTS => {
                    sync_log(format!(
                        "folder rename {} skipped after {} attempts: {}",
                        entry.id, entry.attempts, e
                    ));
                }
                Err(e) => return Err(e),
            }
            let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            if let Some(old) = &entry.old_relative_path {
                delete_folder_mapping(&conn, entry.sync_folder_id, old)?;
                set_folder_mapping(&conn, entry.sync_folder_id, &entry.relative_path, remote_id)?;
            }
            mark_journal_done(&conn, entry.id)?;
        }
        "folder_create" => {
            engine
                .ensure_folder_remote_path(entry.sync_folder_id, &entry.relative_path)
                .await?;
            let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            mark_journal_done(&conn, entry.id)?;
        }
        _ => {
            let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            mark_journal_done(&conn, entry.id)?;
        }
    }
    Ok(())
}

pub async fn drain_journal(engine: &SyncEngine, api: &ApiClient, db: &DbHandle) -> AppResult<u32> {
    if engine.journal_backoff_active() {
        return Ok(0);
    }
    let _drain_guard = engine.journal_drain_lock.lock().await;
    if engine.journal_backoff_active() {
        return Ok(0);
    }

    // Once per process: clear poisoned renames + collapse duplicate deletes.
    {
        static CLEANED: std::sync::Once = std::sync::Once::new();
        CLEANED.call_once(|| {
            if let Ok(conn) = db.lock() {
                match crate::db::cleanup_stuck_journal(&conn) {
                    Ok((renames, deletes)) if renames > 0 || deletes > 0 => {
                        sync_log(format!(
                            "journal cleanup — skipped {} stuck rename(s), deduped {} file_delete(s)",
                            renames, deletes
                        ));
                    }
                    Ok(_) => {}
                    Err(e) => sync_log(format!("journal cleanup failed: {}", e)),
                }
            }
        });
    }

    let entries = {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        crate::db::list_pending_journal(&conn, 50)?
    };
    let mut processed = 0u32;
    for entry in entries {
        match process_journal_entry(engine, api, db, &entry).await {
            Ok(()) => processed += 1,
            Err(e) => {
                let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                mark_journal_retry(&conn, entry.id, entry.attempts)?;
                drop(conn);
                engine.pause_journal_after_error();
                sync_log(format!(
                    "journal drain paused after entry {} failed: {}",
                    entry.id, e
                ));
                break;
            }
        }
    }
    Ok(processed)
}

fn clear_sync_prefix(
    conn: &rusqlite::Connection,
    sync_folder_id: i64,
    relative_prefix: &str,
) -> AppResult<()> {
    if relative_prefix.is_empty() {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM sync_state WHERE sync_folder_id = ?1 AND (relative_path = ?2 OR relative_path LIKE ?3)",
        rusqlite::params![
            sync_folder_id,
            relative_prefix,
            format!("{}/%", relative_prefix)
        ],
    )?;
    Ok(())
}

pub fn enqueue_file_delete(
    db: &DbHandle,
    sync_folder_id: i64,
    relative_path: &str,
    remote_file_id: &str,
) -> AppResult<()> {
    let mutation_id = uuid::Uuid::new_v4().to_string();
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    if crate::db::has_pending_file_delete_for_remote(&conn, sync_folder_id, remote_file_id)? {
        return Ok(());
    }
    crate::db::insert_journal_entry(
        &conn,
        sync_folder_id,
        "file_delete",
        relative_path,
        None,
        Some(remote_file_id),
        Some("file"),
        &mutation_id,
        "{}",
    )?;
    Ok(())
}

pub fn enqueue_folder_delete(
    db: &DbHandle,
    sync_folder_id: i64,
    relative_path: &str,
    remote_folder_id: &str,
) -> AppResult<()> {
    let mutation_id = uuid::Uuid::new_v4().to_string();
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    crate::db::insert_journal_entry(
        &conn,
        sync_folder_id,
        "folder_delete",
        relative_path,
        None,
        Some(remote_folder_id),
        Some("folder"),
        &mutation_id,
        "{}",
    )?;
    Ok(())
}

pub fn enqueue_rename(
    db: &DbHandle,
    sync_folder_id: i64,
    new_relative: &str,
    old_relative: &str,
    remote_entity_id: &str,
    entity_type: &str,
) -> AppResult<()> {
    let op = if entity_type == "folder" {
        "folder_rename"
    } else {
        "file_rename"
    };
    let mutation_id = uuid::Uuid::new_v4().to_string();
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    crate::db::insert_journal_entry(
        &conn,
        sync_folder_id,
        op,
        new_relative,
        Some(old_relative),
        Some(remote_entity_id),
        Some(entity_type),
        &mutation_id,
        "{}",
    )?;
    Ok(())
}

pub fn enqueue_folder_create(
    db: &DbHandle,
    sync_folder_id: i64,
    relative_path: &str,
) -> AppResult<()> {
    let mutation_id = uuid::Uuid::new_v4().to_string();
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    crate::db::insert_journal_entry(
        &conn,
        sync_folder_id,
        "folder_create",
        relative_path,
        None,
        None,
        Some("folder"),
        &mutation_id,
        "{}",
    )?;
    Ok(())
}
