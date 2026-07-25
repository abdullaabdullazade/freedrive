use crate::error::AppResult;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub type DbHandle = Arc<Mutex<Connection>>;

pub fn open_db() -> AppResult<DbHandle> {
    let path = crate::auth_store::data_dir()?.join("sync.db");
    let conn = Connection::open(path)?;
    init_schema(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

fn init_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS app_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            local_path TEXT NOT NULL UNIQUE,
            remote_folder_id TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS folder_mappings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sync_folder_id INTEGER NOT NULL,
            relative_path TEXT NOT NULL,
            remote_folder_id TEXT NOT NULL,
            UNIQUE(sync_folder_id, relative_path)
        );
        CREATE TABLE IF NOT EXISTS sync_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sync_folder_id INTEGER NOT NULL,
            relative_path TEXT NOT NULL,
            local_path TEXT NOT NULL,
            remote_file_id TEXT,
            content_hash TEXT,
            local_mtime INTEGER,
            remote_updated_at TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            UNIQUE(sync_folder_id, relative_path)
        );
        CREATE TABLE IF NOT EXISTS sync_activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '',
            file_size INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS file_keys (
            remote_file_id TEXT PRIMARY KEY,
            key_b64url TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pending_file_keys (
            folder_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            key_b64url TEXT NOT NULL,
            PRIMARY KEY (folder_id, file_name)
        );
        CREATE TABLE IF NOT EXISTS pending_key_uploads (
            remote_file_id TEXT PRIMARY KEY,
            key_b64url TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS my_drive_placeholders (
            relative_path TEXT PRIMARY KEY,
            remote_id TEXT NOT NULL,
            item_type TEXT NOT NULL,
            parent_remote_id TEXT
        );
        "#,
    )?;
    purge_mirror_sync_state_once(conn)?;
    migrate_bidir_schema(conn)?;
    Ok(())
}

fn migrate_bidir_schema(conn: &Connection) -> AppResult<()> {
    if config_get(conn, "bidir_schema_v1")?.as_deref() == Some("true") {
        return Ok(());
    }
    let _ = conn.execute_batch(
        r#"
        ALTER TABLE sync_state ADD COLUMN remote_version INTEGER NOT NULL DEFAULT 0;
        "#,
    );
    let _ = conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS sync_journal (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sync_folder_id INTEGER NOT NULL,
            operation TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            old_relative_path TEXT,
            remote_entity_id TEXT,
            remote_entity_type TEXT,
            client_mutation_id TEXT NOT NULL UNIQUE,
            payload TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            next_retry_at TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_journal_status ON sync_journal(status, next_retry_at);
        "#,
    );
    config_set(conn, "bidir_schema_v1", "true")?;
    conn.execute(
        "UPDATE sync_activity SET status = 'deleted' WHERE detail = 'Removed from cloud' AND status = 'synced'",
        [],
    )?;
    Ok(())
}

pub fn sync_cursor_key(computer_id: &str) -> String {
    format!("sync_cursor_{}", computer_id)
}

pub fn get_sync_cursor(conn: &Connection, computer_id: &str) -> AppResult<i64> {
    Ok(config_get(conn, &sync_cursor_key(computer_id))?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0))
}

pub fn set_sync_cursor(conn: &Connection, computer_id: &str, cursor: i64) -> AppResult<()> {
    config_set(conn, &sync_cursor_key(computer_id), &cursor.to_string())
}

#[derive(Debug, Clone)]
pub struct JournalEntry {
    pub id: i64,
    pub sync_folder_id: i64,
    pub operation: String,
    pub relative_path: String,
    pub old_relative_path: Option<String>,
    pub remote_entity_id: Option<String>,
    pub remote_entity_type: Option<String>,
    pub client_mutation_id: String,
    pub payload: String,
    pub status: String,
    pub attempts: i32,
}

pub fn insert_journal_entry(
    conn: &Connection,
    sync_folder_id: i64,
    operation: &str,
    relative_path: &str,
    old_relative_path: Option<&str>,
    remote_entity_id: Option<&str>,
    remote_entity_type: Option<&str>,
    client_mutation_id: &str,
    payload: &str,
) -> AppResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO sync_journal (
            sync_folder_id, operation, relative_path, old_relative_path,
            remote_entity_id, remote_entity_type, client_mutation_id, payload, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            sync_folder_id,
            operation,
            relative_path,
            old_relative_path,
            remote_entity_id,
            remote_entity_type,
            client_mutation_id,
            payload,
            now
        ],
    )?;
    Ok(())
}

pub fn list_pending_journal(conn: &Connection, limit: usize) -> AppResult<Vec<JournalEntry>> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut stmt = conn.prepare(
        "SELECT id, sync_folder_id, operation, relative_path, old_relative_path,
                remote_entity_id, remote_entity_type, client_mutation_id, payload, status, attempts
         FROM sync_journal
         WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?1)
         ORDER BY id ASC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![now, limit as i64], |row| {
        Ok(JournalEntry {
            id: row.get(0)?,
            sync_folder_id: row.get(1)?,
            operation: row.get(2)?,
            relative_path: row.get(3)?,
            old_relative_path: row.get(4)?,
            remote_entity_id: row.get(5)?,
            remote_entity_type: row.get(6)?,
            client_mutation_id: row.get(7)?,
            payload: row.get(8)?,
            status: row.get(9)?,
            attempts: row.get(10)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn has_pending_journal_for_path(
    conn: &Connection,
    sync_folder_id: i64,
    relative_path: &str,
) -> AppResult<bool> {
    let mut stmt = conn.prepare(
        "SELECT 1 FROM sync_journal
         WHERE sync_folder_id = ?1 AND relative_path = ?2 AND status = 'pending'
         LIMIT 1",
    )?;
    let mut rows = stmt.query(params![sync_folder_id, relative_path])?;
    Ok(rows.next()?.is_some())
}

/// Returns (sync_folder_id, relative_path, local_path, remote_version) for a remote file id.
pub fn get_sync_state_detail_by_remote_file_id(
    conn: &Connection,
    remote_file_id: &str,
) -> AppResult<Option<(i64, String, String, i32)>> {
    let mut stmt = conn.prepare(
        "SELECT sync_folder_id, relative_path, local_path, remote_version
         FROM sync_state WHERE remote_file_id = ?1 LIMIT 1",
    )?;
    let mut rows = stmt.query(params![remote_file_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
    } else {
        Ok(None)
    }
}

pub fn mark_journal_done(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE sync_journal SET status = 'done' WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn mark_journal_retry(conn: &Connection, id: i64, attempts: i32) -> AppResult<()> {
    let delay_secs = (2_i64.pow(attempts.min(6) as u32)).min(300);
    let next = chrono::Utc::now() + chrono::Duration::seconds(delay_secs);
    conn.execute(
        "UPDATE sync_journal SET attempts = ?1, next_retry_at = ?2 WHERE id = ?3",
        params![attempts + 1, next.to_rfc3339(), id],
    )?;
    Ok(())
}

pub fn upsert_sync_state_with_version(
    conn: &Connection,
    sync_folder_id: i64,
    relative_path: &str,
    local_path: &str,
    remote_file_id: Option<&str>,
    content_hash: Option<&str>,
    local_mtime: Option<i64>,
    remote_updated_at: Option<&str>,
    remote_version: i32,
    status: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_state (
            sync_folder_id, relative_path, local_path, remote_file_id, content_hash,
            local_mtime, remote_updated_at, remote_version, status
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(sync_folder_id, relative_path) DO UPDATE SET
          local_path = excluded.local_path,
          remote_file_id = COALESCE(excluded.remote_file_id, sync_state.remote_file_id),
          content_hash = excluded.content_hash,
          local_mtime = excluded.local_mtime,
          remote_updated_at = excluded.remote_updated_at,
          remote_version = excluded.remote_version,
          status = excluded.status",
        params![
            sync_folder_id,
            relative_path,
            local_path,
            remote_file_id,
            content_hash,
            local_mtime,
            remote_updated_at,
            remote_version,
            status
        ],
    )?;
    Ok(())
}

pub fn find_sync_folder_for_remote_prefix(
    conn: &Connection,
    remote_folder_id: &str,
) -> AppResult<Option<(i64, String)>> {
    let folders = list_sync_folders(conn)?;
    let mut best: Option<(i64, String, usize)> = None;
    for sf in folders {
        if is_pending_remote_folder(&sf.remote_folder_id) {
            continue;
        }
        if remote_folder_id == sf.remote_folder_id {
            let len = 0;
            if best.as_ref().map(|(_, _, l)| len >= *l).unwrap_or(true) {
                best = Some((sf.id, sf.local_path.clone(), len));
            }
            continue;
        }
        if let Some(mapping) = get_folder_mapping(conn, sf.id, "")? {
            let _ = mapping;
        }
        for mapping in list_folder_mappings(conn, sf.id)? {
            if mapping.remote_folder_id == remote_folder_id {
                let len = mapping.relative_path.len();
                if best.as_ref().map(|(_, _, l)| len > *l).unwrap_or(true) {
                    best = Some((sf.id, sf.local_path.clone(), len));
                }
            }
        }
    }
    Ok(best.map(|(id, path, _)| (id, path)))
}

#[derive(Debug, Clone)]
pub struct FolderMappingRow {
    pub relative_path: String,
    pub remote_folder_id: String,
}

pub fn list_folder_mappings(conn: &Connection, sync_folder_id: i64) -> AppResult<Vec<FolderMappingRow>> {
    let mut stmt = conn.prepare(
        "SELECT relative_path, remote_folder_id FROM folder_mappings WHERE sync_folder_id = ?1",
    )?;
    let rows = stmt.query_map(params![sync_folder_id], |row| {
        Ok(FolderMappingRow {
            relative_path: row.get(0)?,
            remote_folder_id: row.get(1)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn get_sync_state_by_remote_file_id(
    conn: &Connection,
    remote_file_id: &str,
) -> AppResult<Option<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT sync_folder_id, relative_path FROM sync_state WHERE remote_file_id = ?1 LIMIT 1",
    )?;
    let mut rows = stmt.query(params![remote_file_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some((row.get(0)?, row.get(1)?)))
    } else {
        Ok(None)
    }
}

/// One-time migration: remove sync_state rows that pointed at ~/FreeDrive mirror paths.
fn purge_mirror_sync_state_once(conn: &Connection) -> AppResult<()> {
    if config_get(conn, "mirror_state_purged")?.as_deref() == Some("true") {
        return Ok(());
    }
    purge_mirror_sync_state(conn)?;
    config_set(conn, "mirror_state_purged", "true")?;
    Ok(())
}

/// Remove sync_state rows that point at the ~/FreeDrive mirror cache instead of real source folders.
pub fn purge_mirror_sync_state(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "DELETE FROM sync_state WHERE local_path LIKE '%\\FreeDrive\\%' OR local_path LIKE '%/FreeDrive/%'",
        [],
    )?;
    Ok(())
}

pub fn get_sync_folder_by_id(conn: &Connection, id: i64) -> AppResult<Option<SyncFolderRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, local_path, remote_folder_id, label FROM sync_folders WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(SyncFolderRow {
            id: row.get(0)?,
            local_path: row.get(1)?,
            remote_folder_id: row.get(2)?,
            label: row.get(3)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn delete_sync_folder(conn: &Connection, id: i64) -> AppResult<bool> {
    clear_folder_mappings(conn, id)?;
    clear_sync_state_for_folder(conn, id)?;
    let deleted = conn.execute("DELETE FROM sync_folders WHERE id = ?1", params![id])?;
    Ok(deleted > 0)
}

pub fn get_sync_folder_by_path(
    conn: &Connection,
    local_path: &str,
) -> AppResult<Option<SyncFolderRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, local_path, remote_folder_id, label FROM sync_folders WHERE local_path = ?1",
    )?;
    let mut rows = stmt.query(params![local_path])?;
    if let Some(row) = rows.next()? {
        Ok(Some(SyncFolderRow {
            id: row.get(0)?,
            local_path: row.get(1)?,
            remote_folder_id: row.get(2)?,
            label: row.get(3)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn config_get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM app_config WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn config_set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO app_config (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncFolderRow {
    pub id: i64,
    pub local_path: String,
    pub remote_folder_id: String,
    pub label: String,
}

pub fn list_sync_folders(conn: &Connection) -> AppResult<Vec<SyncFolderRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, local_path, remote_folder_id, label FROM sync_folders ORDER BY id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SyncFolderRow {
            id: row.get(0)?,
            local_path: row.get(1)?,
            remote_folder_id: row.get(2)?,
            label: row.get(3)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn insert_sync_folder(
    conn: &Connection,
    local_path: &str,
    remote_folder_id: &str,
    label: &str,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO sync_folders (local_path, remote_folder_id, label) VALUES (?1, ?2, ?3)
         ON CONFLICT(local_path) DO UPDATE SET
           remote_folder_id = excluded.remote_folder_id,
           label = excluded.label",
        params![local_path, remote_folder_id, label],
    )?;
    let mut stmt = conn.prepare("SELECT id FROM sync_folders WHERE local_path = ?1")?;
    let id: i64 = stmt.query_row(params![local_path], |row| row.get(0))?;
    Ok(id)
}

pub const PENDING_REMOTE_FOLDER_ID: &str = "pending";

pub fn is_pending_remote_folder(remote_folder_id: &str) -> bool {
    remote_folder_id.is_empty() || remote_folder_id == PENDING_REMOTE_FOLDER_ID
}

/// Persist chosen local folders immediately (before remote API setup).
pub fn save_local_sync_folders(conn: &Connection, folders: &[(String, String)]) -> AppResult<()> {
    for (local_path, label) in folders {
        if get_sync_folder_by_path(conn, local_path)?.is_some() {
            continue;
        }
        insert_sync_folder(conn, local_path, PENDING_REMOTE_FOLDER_ID, label)?;
    }
    Ok(())
}

pub struct LoginSessionReset {
    pub folders_to_remap: Vec<(String, String)>,
}

fn clear_sync_data(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
        DELETE FROM sync_state;
        DELETE FROM folder_mappings;
        DELETE FROM sync_folders;
        DELETE FROM sync_activity;
        DELETE FROM file_keys;
        DELETE FROM pending_file_keys;
        DELETE FROM sync_journal;
        DELETE FROM app_config WHERE key LIKE 'sync_cursor_%' OR key IN ('computer_id', 'computer_root_id', 'initial_sync_complete');
        "#,
    )?;
    Ok(())
}

/// Clears sync state on logout. Keeps device registration and folder config so the
/// same user can log back in without creating duplicate computer entries.
pub fn reset_session_on_logout(conn: &Connection) -> AppResult<()> {
    let _ = conn;
    Ok(())
}

/// Prepare local sync state for a login. Resets onboarding when the account changes;
/// remaps folders when only the server URL changes (same account).
pub fn prepare_login_session(
    conn: &Connection,
    user_id: &str,
    new_server_url: &str,
) -> AppResult<LoginSessionReset> {
    // Drop sync folders whose local path no longer exists (e.g. after partial uninstall).
    prune_orphaned_sync_folders(conn)?;

    let old_user_id = config_get(conn, "last_user_id")?;
    let old_server_url = config_get(conn, "sync_server_url")?;

    let user_changed = old_user_id
        .as_deref()
        .is_some_and(|old| old != user_id);
    let server_changed = old_server_url.as_deref() != Some(new_server_url);

    let folders_to_remap = if user_changed {
        clear_sync_data(conn)?;
        config_set(conn, "onboarding_complete", "false")?;
        Vec::new()
    } else if server_changed {
        let folders: Vec<(String, String)> = list_sync_folders(conn)?
            .into_iter()
            .map(|f| (f.local_path, f.label))
            .collect();

        if old_server_url.is_some() {
            clear_sync_data(conn)?;
        }
        folders
    } else {
        Vec::new()
    };

    config_set(conn, "last_user_id", user_id)?;
    config_set(conn, "sync_server_url", new_server_url)?;

    Ok(LoginSessionReset { folders_to_remap })
}

fn prune_orphaned_sync_folders(conn: &Connection) -> AppResult<()> {
    for folder in list_sync_folders(conn)? {
        if !std::path::Path::new(&folder.local_path).exists() {
            let _ = delete_sync_folder(conn, folder.id)?;
        }
    }
    Ok(())
}

pub fn get_folder_mapping(
    conn: &Connection,
    sync_folder_id: i64,
    relative_path: &str,
) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT remote_folder_id FROM folder_mappings WHERE sync_folder_id = ?1 AND relative_path = ?2",
    )?;
    let mut rows = stmt.query(params![sync_folder_id, relative_path])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn set_folder_mapping(
    conn: &Connection,
    sync_folder_id: i64,
    relative_path: &str,
    remote_folder_id: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO folder_mappings (sync_folder_id, relative_path, remote_folder_id)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(sync_folder_id, relative_path) DO UPDATE SET remote_folder_id = excluded.remote_folder_id",
        params![sync_folder_id, relative_path, remote_folder_id],
    )?;
    Ok(())
}

pub fn update_sync_folder_remote_id(
    conn: &Connection,
    sync_folder_id: i64,
    new_remote_id: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE sync_folders SET remote_folder_id = ?1 WHERE id = ?2",
        params![new_remote_id, sync_folder_id],
    )?;
    Ok(())
}

pub fn clear_folder_mappings(conn: &Connection, sync_folder_id: i64) -> AppResult<()> {
    conn.execute(
        "DELETE FROM folder_mappings WHERE sync_folder_id = ?1",
        params![sync_folder_id],
    )?;
    Ok(())
}

pub fn delete_folder_mapping(
    conn: &Connection,
    sync_folder_id: i64,
    relative_path: &str,
) -> AppResult<()> {
    conn.execute(
        "DELETE FROM folder_mappings WHERE sync_folder_id = ?1 AND relative_path = ?2",
        params![sync_folder_id, relative_path],
    )?;
    Ok(())
}

pub fn clear_sync_state_for_folder(conn: &Connection, sync_folder_id: i64) -> AppResult<()> {
    conn.execute(
        "DELETE FROM sync_state WHERE sync_folder_id = ?1",
        params![sync_folder_id],
    )?;
    Ok(())
}

pub fn clear_folder_mapping_prefix(
    conn: &Connection,
    sync_folder_id: i64,
    relative_prefix: &str,
) -> AppResult<()> {
    if relative_prefix.is_empty() {
        return clear_folder_mappings(conn, sync_folder_id);
    }
    conn.execute(
        "DELETE FROM folder_mappings WHERE sync_folder_id = ?1 AND (relative_path = ?2 OR relative_path LIKE ?3)",
        params![
            sync_folder_id,
            relative_prefix,
            format!("{}/%", relative_prefix)
        ],
    )?;
    Ok(())
}

pub fn clear_sync_state_remote_file(
    conn: &Connection,
    sync_folder_id: i64,
    relative_path: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE sync_state SET remote_file_id = NULL WHERE sync_folder_id = ?1 AND relative_path = ?2",
        params![sync_folder_id, relative_path],
    )?;
    Ok(())
}

pub fn delete_sync_state_row(
    conn: &Connection,
    sync_folder_id: i64,
    relative_path: &str,
) -> AppResult<()> {
    conn.execute(
        "DELETE FROM sync_state WHERE sync_folder_id = ?1 AND relative_path = ?2",
        params![sync_folder_id, relative_path],
    )?;
    Ok(())
}

pub fn my_drive_delete_placeholder(conn: &Connection, relative_path: &str) -> AppResult<()> {
    let relative_path = normalize_my_drive_relative_path(relative_path);
    conn.execute(
        "DELETE FROM my_drive_placeholders WHERE relative_path = ?1 COLLATE NOCASE",
        params![relative_path],
    )?;
    Ok(())
}

/// Delete a placeholder and every descendant under that relative path (folder trash reconcile).
pub fn my_drive_delete_placeholders_under_prefix(
    conn: &Connection,
    relative_path: &str,
) -> AppResult<usize> {
    let relative_path = normalize_my_drive_relative_path(relative_path);
    let like = format!("{}\\%", relative_path.trim_end_matches(['\\', '/']));
    let n = conn.execute(
        "DELETE FROM my_drive_placeholders
         WHERE relative_path = ?1 COLLATE NOCASE
            OR relative_path LIKE ?2 COLLATE NOCASE",
        params![relative_path, like],
    )?;
    Ok(n)
}

pub fn get_sync_state(
    conn: &Connection,
    sync_folder_id: i64,
    relative_path: &str,
) -> AppResult<Option<(Option<String>, Option<String>, Option<i64>, String)>> {
    let mut stmt = conn.prepare(
        "SELECT remote_file_id, content_hash, local_mtime, status FROM sync_state
         WHERE sync_folder_id = ?1 AND relative_path = ?2",
    )?;
    let mut rows = stmt.query(params![sync_folder_id, relative_path])?;
    if let Some(row) = rows.next()? {
        Ok(Some((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
    } else {
        Ok(None)
    }
}

pub fn upsert_sync_state(
    conn: &Connection,
    sync_folder_id: i64,
    relative_path: &str,
    local_path: &str,
    remote_file_id: Option<&str>,
    content_hash: Option<&str>,
    local_mtime: Option<i64>,
    remote_updated_at: Option<&str>,
    status: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_state (sync_folder_id, relative_path, local_path, remote_file_id, content_hash, local_mtime, remote_updated_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(sync_folder_id, relative_path) DO UPDATE SET
           local_path = excluded.local_path,
           remote_file_id = COALESCE(excluded.remote_file_id, sync_state.remote_file_id),
           content_hash = excluded.content_hash,
           local_mtime = excluded.local_mtime,
           remote_updated_at = excluded.remote_updated_at,
           status = excluded.status",
        params![
            sync_folder_id,
            relative_path,
            local_path,
            remote_file_id,
            content_hash,
            local_mtime,
            remote_updated_at,
            status
        ],
    )?;
    Ok(())
}

pub fn insert_activity(
    conn: &Connection,
    name: &str,
    detail: &str,
    file_size: i64,
    status: &str,
) -> AppResult<i64> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO sync_activity (name, detail, file_size, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![name, detail, file_size, status, now],
    )?;
    let id = conn.last_insert_rowid();
    prune_activity(conn)?;
    Ok(id)
}

fn prune_activity(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "DELETE FROM sync_activity WHERE id NOT IN (
            SELECT id FROM sync_activity ORDER BY id DESC LIMIT 200
        )",
        [],
    )?;
    Ok(())
}

pub fn clear_stale_activity(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "UPDATE sync_activity SET status = 'synced', detail = 'Up to date'
         WHERE status = 'uploading'
            OR detail LIKE 'Hashing%'
            OR detail LIKE 'Updating%'",
        [],
    )?;
    Ok(())
}

/// Update the latest activity row for `name`, or insert if none exists.
pub fn upsert_activity(
    conn: &Connection,
    name: &str,
    detail: &str,
    file_size: i64,
    status: &str,
) -> AppResult<i64> {
    let now = chrono::Utc::now().to_rfc3339();
    let updated = conn.execute(
        "UPDATE sync_activity SET detail = ?2, file_size = ?3, status = ?4, created_at = ?5
         WHERE id = (
             SELECT id FROM sync_activity WHERE name = ?1 ORDER BY id DESC LIMIT 1
         )",
        params![name, detail, file_size, status, now],
    )?;
    if updated > 0 {
        let mut stmt = conn.prepare(
            "SELECT id FROM sync_activity WHERE name = ?1 ORDER BY id DESC LIMIT 1",
        )?;
        let id: i64 = stmt.query_row(params![name], |row| row.get(0))?;
        prune_activity(conn)?;
        return Ok(id);
    }
    insert_activity(conn, name, detail, file_size, status)
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityRow {
    pub id: i64,
    pub name: String,
    pub detail: String,
    pub file_size: i64,
    pub status: String,
    pub created_at: String,
}

pub fn list_activity(conn: &Connection, limit: i64) -> AppResult<Vec<ActivityRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, detail, file_size, status, created_at FROM sync_activity
         ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |row| {
        Ok(ActivityRow {
            id: row.get(0)?,
            name: row.get(1)?,
            detail: row.get(2)?,
            file_size: row.get(3)?,
            status: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Returns (relative_path, local_path, remote_file_id) rows for one sync folder.
pub fn list_sync_states_for_folder(
    conn: &Connection,
    sync_folder_id: i64,
) -> AppResult<Vec<(String, String, Option<String>)>> {
    let mut stmt = conn.prepare(
        "SELECT relative_path, local_path, remote_file_id FROM sync_state WHERE sync_folder_id = ?1",
    )?;
    let rows = stmt.query_map(params![sync_folder_id], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn list_all_sync_states(conn: &Connection) -> AppResult<Vec<(i64, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT sync_folder_id, relative_path, local_path FROM sync_state WHERE remote_file_id IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn store_file_key(conn: &Connection, remote_file_id: &str, key_b64url: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO file_keys (remote_file_id, key_b64url) VALUES (?1, ?2)
         ON CONFLICT(remote_file_id) DO UPDATE SET key_b64url = excluded.key_b64url",
        params![remote_file_id, key_b64url],
    )?;
    Ok(())
}

pub fn import_file_keys(
    conn: &Connection,
    keys: &std::collections::HashMap<String, String>,
) -> AppResult<usize> {
    let mut count = 0usize;
    for (remote_file_id, key_b64url) in keys {
        if remote_file_id.is_empty() || key_b64url.is_empty() {
            continue;
        }
        store_file_key(conn, remote_file_id, key_b64url)?;
        count += 1;
    }
    Ok(count)
}

pub fn list_all_file_keys(conn: &Connection) -> AppResult<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT remote_file_id, key_b64url FROM file_keys")?;
    let mut rows = stmt.query([])?;
    let mut keys = HashMap::new();
    while let Some(row) = rows.next()? {
        keys.insert(row.get(0)?, row.get(1)?);
    }
    Ok(keys)
}

pub fn get_file_key(conn: &Connection, remote_file_id: &str) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT key_b64url FROM file_keys WHERE remote_file_id = ?1")?;
    let mut rows = stmt.query(params![remote_file_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn delete_file_key(conn: &Connection, remote_file_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM file_keys WHERE remote_file_id = ?1",
        params![remote_file_id],
    )?;
    Ok(())
}

pub fn store_pending_file_key(
    conn: &Connection,
    folder_id: &str,
    file_name: &str,
    key_b64url: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO pending_file_keys (folder_id, file_name, key_b64url) VALUES (?1, ?2, ?3)
         ON CONFLICT(folder_id, file_name) DO UPDATE SET key_b64url = excluded.key_b64url",
        params![folder_id, file_name, key_b64url],
    )?;
    Ok(())
}

pub fn get_pending_file_key(
    conn: &Connection,
    folder_id: &str,
    file_name: &str,
) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT key_b64url FROM pending_file_keys WHERE folder_id = ?1 AND file_name = ?2",
    )?;
    let mut rows = stmt.query(params![folder_id, file_name])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn delete_pending_file_key(
    conn: &Connection,
    folder_id: &str,
    file_name: &str,
) -> AppResult<()> {
    conn.execute(
        "DELETE FROM pending_file_keys WHERE folder_id = ?1 AND file_name = ?2",
        params![folder_id, file_name],
    )?;
    Ok(())
}

pub fn has_any_pending_file_key(conn: &Connection, file_name: &str) -> AppResult<bool> {
    let mut stmt = conn.prepare(
        "SELECT 1 FROM pending_file_keys WHERE file_name = ?1 LIMIT 1",
    )?;
    let mut rows = stmt.query(params![file_name])?;
    Ok(rows.next()?.is_some())
}

pub fn store_pending_key_upload(
    conn: &Connection,
    remote_file_id: &str,
    key_b64url: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO pending_key_uploads (remote_file_id, key_b64url) VALUES (?1, ?2)
         ON CONFLICT(remote_file_id) DO UPDATE SET key_b64url = excluded.key_b64url",
        params![remote_file_id, key_b64url],
    )?;
    Ok(())
}

pub fn list_pending_key_uploads(conn: &Connection) -> AppResult<Vec<(String, String)>> {
    let mut stmt =
        conn.prepare("SELECT remote_file_id, key_b64url FROM pending_key_uploads")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push((row.get(0)?, row.get(1)?));
    }
    Ok(out)
}

pub fn delete_pending_key_upload(conn: &Connection, remote_file_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM pending_key_uploads WHERE remote_file_id = ?1",
        params![remote_file_id],
    )?;
    Ok(())
}

pub fn has_pending_key_upload(conn: &Connection, remote_file_id: &str) -> AppResult<bool> {
    let mut stmt = conn.prepare(
        "SELECT 1 FROM pending_key_uploads WHERE remote_file_id = ?1 LIMIT 1",
    )?;
    let mut rows = stmt.query(params![remote_file_id])?;
    Ok(rows.next()?.is_some())
}

fn normalize_my_drive_relative_path(relative_path: &str) -> String {
    relative_path.replace('/', "\\")
}

pub fn my_drive_upsert_placeholder(
    conn: &Connection,
    relative_path: &str,
    remote_id: &str,
    item_type: &str,
    parent_remote_id: Option<&str>,
) -> AppResult<()> {
    let relative_path = normalize_my_drive_relative_path(relative_path);
    conn.execute(
        "INSERT INTO my_drive_placeholders (relative_path, remote_id, item_type, parent_remote_id)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(relative_path) DO UPDATE SET
           remote_id = excluded.remote_id,
           item_type = excluded.item_type,
           parent_remote_id = excluded.parent_remote_id",
        params![relative_path, remote_id, item_type, parent_remote_id],
    )?;
    Ok(())
}

pub fn my_drive_get_placeholder(
    conn: &Connection,
    relative_path: &str,
) -> AppResult<Option<(String, String)>> {
    let relative_path = normalize_my_drive_relative_path(relative_path);
    let mut stmt = conn.prepare(
        "SELECT remote_id, item_type FROM my_drive_placeholders WHERE relative_path = ?1 COLLATE NOCASE",
    )?;
    let mut rows = stmt.query(params![relative_path])?;
    if let Some(row) = rows.next()? {
        Ok(Some((row.get(0)?, row.get(1)?)))
    } else {
        Ok(None)
    }
}

pub fn my_drive_get_placeholder_by_remote_id(
    conn: &Connection,
    remote_id: &str,
) -> AppResult<Option<(String, String, Option<String>)>> {
    let mut stmt = conn.prepare(
        "SELECT relative_path, item_type, parent_remote_id FROM my_drive_placeholders WHERE remote_id = ?1",
    )?;
    let mut rows = stmt.query(params![remote_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some((row.get(0)?, row.get(1)?, row.get(2)?)))
    } else {
        Ok(None)
    }
}

pub fn my_drive_clear_placeholders(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM my_drive_placeholders", [])?;
    Ok(())
}

#[cfg(test)]
pub fn in_memory_db() -> DbHandle {
    let conn = Connection::open_in_memory().expect("in-memory db");
    init_schema(&conn).expect("schema");
    Arc::new(Mutex::new(conn))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn first_login_leaves_onboarding_unset() {
        let conn = test_conn();
        let reset = prepare_login_session(&conn, "user-a", "http://localhost").unwrap();
        assert!(reset.folders_to_remap.is_empty());
        assert_eq!(config_get(&conn, "onboarding_complete").unwrap(), None);
        assert_eq!(
            config_get(&conn, "last_user_id").unwrap().as_deref(),
            Some("user-a")
        );
    }

    #[test]
    fn same_user_relogin_keeps_config() {
        let conn = test_conn();
        let tmp = std::env::temp_dir().join(format!("fd-sync-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let path = tmp.to_string_lossy().to_string();
        config_set(&conn, "onboarding_complete", "true").unwrap();
        insert_sync_folder(&conn, &path, "remote-1", "Documents").unwrap();
        prepare_login_session(&conn, "user-a", "http://localhost").unwrap();
        prepare_login_session(&conn, "user-a", "http://localhost").unwrap();
        assert_eq!(
            config_get(&conn, "onboarding_complete").unwrap().as_deref(),
            Some("true")
        );
        assert_eq!(list_sync_folders(&conn).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn different_user_resets_onboarding_and_folders() {
        let conn = test_conn();
        let tmp = std::env::temp_dir().join(format!("fd-sync-test-b-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let path = tmp.to_string_lossy().to_string();
        prepare_login_session(&conn, "user-a", "http://localhost").unwrap();
        config_set(&conn, "onboarding_complete", "true").unwrap();
        insert_sync_folder(&conn, &path, "remote-1", "Documents").unwrap();

        let reset = prepare_login_session(&conn, "user-b", "http://localhost").unwrap();
        assert!(reset.folders_to_remap.is_empty());
        assert_eq!(
            config_get(&conn, "onboarding_complete").unwrap().as_deref(),
            Some("false")
        );
        assert!(list_sync_folders(&conn).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn same_user_server_change_remaps_folders() {
        let conn = test_conn();
        let tmp = std::env::temp_dir().join(format!("fd-sync-test-c-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let path = tmp.to_string_lossy().to_string();
        prepare_login_session(&conn, "user-a", "http://localhost").unwrap();
        insert_sync_folder(&conn, &path, "remote-1", "Documents").unwrap();

        let reset = prepare_login_session(&conn, "user-a", "http://remote").unwrap();
        assert_eq!(reset.folders_to_remap.len(), 1);
        assert_eq!(reset.folders_to_remap[0].0, path);
        assert!(list_sync_folders(&conn).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn prepare_login_prunes_missing_local_paths() {
        let conn = test_conn();
        prepare_login_session(&conn, "user-a", "http://localhost").unwrap();
        insert_sync_folder(&conn, "/nonexistent/fd-orphan-path", "remote-1", "Gone").unwrap();
        prepare_login_session(&conn, "user-a", "http://localhost").unwrap();
        assert!(list_sync_folders(&conn).unwrap().is_empty());
    }

    #[test]
    fn logout_keeps_device_registration_and_sync_folders() {
        let conn = test_conn();
        prepare_login_session(&conn, "user-a", "http://localhost").unwrap();
        config_set(&conn, "onboarding_complete", "true").unwrap();
        config_set(&conn, "computer_id", "pc-1").unwrap();
        config_set(&conn, "computer_root_id", "root-1").unwrap();
        insert_sync_folder(&conn, "/tmp/docs", "remote-1", "Documents").unwrap();

        reset_session_on_logout(&conn).unwrap();

        assert_eq!(
            config_get(&conn, "onboarding_complete").unwrap().as_deref(),
            Some("true")
        );
        assert_eq!(
            config_get(&conn, "computer_id").unwrap().as_deref(),
            Some("pc-1")
        );
        assert_eq!(list_sync_folders(&conn).unwrap().len(), 1);
    }

    #[test]
    fn clear_folder_mapping_prefix_removes_path_and_descendants() {
        let conn = test_conn();
        let id = insert_sync_folder(&conn, "/tmp/docs", "remote-1", "Documents").unwrap();
        set_folder_mapping(&conn, id, "docs", "f-docs").unwrap();
        set_folder_mapping(&conn, id, "docs/sub", "f-sub").unwrap();
        set_folder_mapping(&conn, id, "docs/sub/nested", "f-nested").unwrap();
        set_folder_mapping(&conn, id, "other", "f-other").unwrap();

        clear_folder_mapping_prefix(&conn, id, "docs/sub").unwrap();

        assert_eq!(
            get_folder_mapping(&conn, id, "docs").unwrap().as_deref(),
            Some("f-docs")
        );
        assert_eq!(get_folder_mapping(&conn, id, "docs/sub").unwrap(), None);
        assert_eq!(get_folder_mapping(&conn, id, "docs/sub/nested").unwrap(), None);
        assert_eq!(
            get_folder_mapping(&conn, id, "other").unwrap().as_deref(),
            Some("f-other")
        );
    }

    #[test]
    fn my_drive_placeholder_roundtrip() {
        let conn = test_conn();
        init_schema(&conn).unwrap();
        my_drive_upsert_placeholder(&conn, "My Drive\\Docs", "f-1", "folder", Some("root-1")).unwrap();
        let row = my_drive_get_placeholder(&conn, "My Drive\\Docs").unwrap();
        assert_eq!(row.as_ref().map(|r| r.0.as_str()), Some("f-1"));
        assert_eq!(row.as_ref().map(|r| r.1.as_str()), Some("folder"));
    }

    #[test]
    fn my_drive_delete_placeholders_under_prefix_cascades() {
        let conn = test_conn();
        init_schema(&conn).unwrap();
        my_drive_upsert_placeholder(&conn, "My Drive\\Docs", "f-1", "folder", Some("root-1")).unwrap();
        my_drive_upsert_placeholder(
            &conn,
            "My Drive\\Docs\\a.txt",
            "file-1",
            "file",
            Some("f-1"),
        )
        .unwrap();
        my_drive_upsert_placeholder(&conn, "My Drive\\Other", "f-2", "folder", Some("root-1"))
            .unwrap();
        let n = my_drive_delete_placeholders_under_prefix(&conn, "My Drive\\Docs").unwrap();
        assert_eq!(n, 2);
        assert!(my_drive_get_placeholder(&conn, "My Drive\\Docs")
            .unwrap()
            .is_none());
        assert!(my_drive_get_placeholder(&conn, "My Drive\\Docs\\a.txt")
            .unwrap()
            .is_none());
        assert!(my_drive_get_placeholder(&conn, "My Drive\\Other")
            .unwrap()
            .is_some());
    }

    #[test]
    fn import_file_keys_roundtrip() {
        let conn = test_conn();
        let mut keys = std::collections::HashMap::new();
        keys.insert("file-a".to_string(), "key-a".to_string());
        keys.insert("file-b".to_string(), "key-b".to_string());
        let count = import_file_keys(&conn, &keys).unwrap();
        assert_eq!(count, 2);
        assert_eq!(
            get_file_key(&conn, "file-a").unwrap().as_deref(),
            Some("key-a")
        );
    }

    #[test]
    fn list_all_file_keys_returns_map() {
        let conn = test_conn();
        store_file_key(&conn, "file-a", "key-a").unwrap();
        store_file_key(&conn, "file-b", "key-b").unwrap();
        let keys = list_all_file_keys(&conn).unwrap();
        assert_eq!(keys.len(), 2);
        assert_eq!(keys.get("file-a").map(|s| s.as_str()), Some("key-a"));
    }

    #[test]
    fn pending_file_key_roundtrip() {
        let conn = test_conn();
        store_pending_file_key(&conn, "folder-1", "doc.pdf", "key-abc").unwrap();
        assert_eq!(
            get_pending_file_key(&conn, "folder-1", "doc.pdf").unwrap().as_deref(),
            Some("key-abc")
        );
        assert!(has_any_pending_file_key(&conn, "doc.pdf").unwrap());
        delete_pending_file_key(&conn, "folder-1", "doc.pdf").unwrap();
        assert_eq!(get_pending_file_key(&conn, "folder-1", "doc.pdf").unwrap(), None);
    }

    #[test]
    fn my_drive_placeholder_lookup_by_remote_id() {
        let conn = test_conn();
        my_drive_upsert_placeholder(
            &conn,
            "My Drive\\Docs\\file.bin",
            "file-remote",
            "file",
            Some("folder-remote"),
        )
        .unwrap();
        let row = my_drive_get_placeholder_by_remote_id(&conn, "file-remote").unwrap();
        assert_eq!(row.as_ref().map(|r| r.0.as_str()), Some("My Drive\\Docs\\file.bin"));
        assert_eq!(row.as_ref().map(|r| r.1.as_str()), Some("file"));
        assert_eq!(
            row.as_ref().and_then(|r| r.2.as_deref()),
            Some("folder-remote")
        );
    }

    #[test]
    fn delete_sync_folder_clears_mappings_and_state() {
        let conn = test_conn();
        let id = insert_sync_folder(&conn, "C:\\Users\\me\\Desktop", "remote-1", "Desktop").unwrap();
        set_folder_mapping(&conn, id, "docs", "remote-docs").unwrap();
        upsert_sync_state(
            &conn,
            id,
            "docs/file.txt",
            "C:\\Users\\me\\Desktop\\docs\\file.txt",
            Some("file-1"),
            Some("hash"),
            Some(1),
            Some("2024-01-01"),
            "synced",
        )
        .unwrap();

        assert!(delete_sync_folder(&conn, id).unwrap());
        assert!(get_sync_folder_by_id(&conn, id).unwrap().is_none());
        assert!(list_sync_folders(&conn).unwrap().is_empty());
        let mut stmt = conn
            .prepare("SELECT COUNT(*) FROM folder_mappings WHERE sync_folder_id = ?1")
            .unwrap();
        let count: i64 = stmt.query_row(params![id], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
        let mut stmt = conn
            .prepare("SELECT COUNT(*) FROM sync_state WHERE sync_folder_id = ?1")
            .unwrap();
        let count: i64 = stmt.query_row(params![id], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn journal_insert_and_list_pending() {
        let conn = test_conn();
        let id = insert_sync_folder(&conn, "/tmp/docs", "remote-1", "Documents").unwrap();
        insert_journal_entry(
            &conn,
            id,
            "file_delete",
            "docs/a.txt",
            None,
            Some("file-1"),
            Some("file"),
            "mut-1",
            "{}",
        )
        .unwrap();
        let pending = list_pending_journal(&conn, 10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].operation, "file_delete");
        mark_journal_done(&conn, pending[0].id).unwrap();
        assert!(list_pending_journal(&conn, 10).unwrap().is_empty());
    }
}
