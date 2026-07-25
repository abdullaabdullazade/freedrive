use crate::api::client::ApiClient;
use crate::db::{
    delete_folder_mapping, delete_sync_state_row, mark_journal_done, mark_journal_retry,
    set_folder_mapping, DbHandle, JournalEntry,
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
                delete_sync_state_row(&conn, entry.sync_folder_id, &entry.relative_path)?;
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
            api.patch_file(
                remote_id,
                Some(new_name),
                None,
                Some(&entry.client_mutation_id),
            )
            .await?;
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
            api.patch_folder(
                remote_id,
                Some(new_name),
                None,
                Some(&entry.client_mutation_id),
            )
            .await?;
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
    let entries = {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        crate::db::list_pending_journal(&conn, 50)?
    };
    let mut processed = 0u32;
    for entry in entries {
        match process_journal_entry(engine, api, db, &entry).await {
            Ok(()) => processed += 1,
            Err(e) => {
                sync_log(format!("journal entry {} failed: {}", entry.id, e));
                let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                mark_journal_retry(&conn, entry.id, entry.attempts)?;
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
