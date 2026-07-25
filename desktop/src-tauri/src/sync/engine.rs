use crate::api::ApiClient;
use crate::blocking::{self, file_sync_timeout, hash_timeout};
use crate::crypto::key_to_b64url;
use crate::db::{
    clear_folder_mapping_prefix, clear_folder_mappings, clear_stale_activity,
    clear_sync_state_for_folder, clear_sync_state_remote_file, config_get, config_set,
    delete_folder_mapping, delete_sync_state_row, get_file_key, get_folder_mapping,
    get_sync_folder_by_path, get_sync_state, insert_sync_folder, is_pending_remote_folder,
    list_folder_mappings, list_sync_folders, list_sync_states_for_folder, set_folder_mapping,
    store_file_key, update_sync_folder_remote_id, insert_activity, upsert_activity, upsert_sync_state, DbHandle,
    SyncFolderRow,
};
use crate::error::{AppError, AppResult};
use crate::sync::journal::{
    drain_journal, enqueue_file_delete, enqueue_folder_create, enqueue_folder_delete,
    enqueue_rename,
};
use crate::sync::log::sync_log;
use crate::sync::reconcile::run_sync_cycle;
use crate::sync::suppress::WatcherSuppress;
use crate::sync::{DOWNLOAD_CONCURRENCY, UPLOAD_CONCURRENCY};
use parking_lot::{Mutex, RwLock};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatusKind {
    UpToDate,
    Syncing,
    Paused,
    Error,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncStatus {
    pub status: SyncStatusKind,
    pub message: String,
    pub last_synced_at: Option<String>,
    pub paused: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncProgress {
    pub phase: String,
    pub processed: u64,
    pub total: u64,
    pub uploaded: u64,
    pub skipped: u64,
    pub unchanged: u64,
    pub errors: u64,
    pub current: u64,
    pub current_file: String,
    pub message: String,
    #[serde(default = "default_show_in_ui")]
    pub show_in_ui: bool,
}

fn default_show_in_ui() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanMode {
    /// First sync or explicit resume — progress only for files that need work.
    Interactive,
    /// Startup verification — no UI for unchanged files.
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileSyncOutcome {
    Synced,
    Unchanged,
    Skipped,
    Failed,
}

enum SyncAttemptResult {
    Done(FileSyncOutcome),
    RetryClearFileState,
    RetryClearRoot,
    RetryClearFolderMapping(String),
}

struct FileSyncJobResult {
    outcome: Result<FileSyncOutcome, AppError>,
    name: String,
    relative_str: String,
    path: PathBuf,
    mtime: i64,
    size: i64,
    processed: u64,
}

const FOLDER_TIMEOUT: Duration = Duration::from_secs(30);
const LARGE_FILE_WARN_BYTES: i64 = 50 * 1024 * 1024;

struct InitialSyncGuard<'a> {
    flag: &'a AtomicBool,
}

impl Drop for InitialSyncGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

pub struct SyncEngine {
    api: ApiClient,
    db: DbHandle,
    app: AppHandle,
    paused: AtomicBool,
    initial_sync_running: AtomicBool,
    upload_semaphore: Arc<Semaphore>,
    download_semaphore: Arc<Semaphore>,
    pending_paths: Mutex<VecDeque<PathBuf>>,
    pending_removals: Mutex<VecDeque<PathBuf>>,
    status: RwLock<SyncStatus>,
    computer_id: RwLock<Option<String>>,
    computer_root_id: RwLock<Option<String>>,
    watcher_suppress: WatcherSuppress,
    shutdown: AtomicBool,
}

impl SyncEngine {
    pub fn new(api: ApiClient, db: DbHandle, app: AppHandle) -> Self {
        Self {
            api,
            db,
            app,
            paused: AtomicBool::new(false),
            initial_sync_running: AtomicBool::new(false),
            upload_semaphore: Arc::new(Semaphore::new(UPLOAD_CONCURRENCY)),
            download_semaphore: Arc::new(Semaphore::new(DOWNLOAD_CONCURRENCY)),
            pending_paths: Mutex::new(VecDeque::new()),
            pending_removals: Mutex::new(VecDeque::new()),
            status: RwLock::new(SyncStatus {
                status: SyncStatusKind::UpToDate,
                message: "Ready".into(),
                last_synced_at: None,
                paused: false,
            }),
            computer_id: RwLock::new(None),
            computer_root_id: RwLock::new(None),
            watcher_suppress: WatcherSuppress::new(),
            shutdown: AtomicBool::new(false),
        }
    }

    async fn acquire_upload_permit(&self) -> AppResult<OwnedSemaphorePermit> {
        self.upload_semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| AppError::msg("upload pool closed"))
    }

    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }

    pub fn is_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::SeqCst)
    }

    pub fn load_computer_from_db(&self) {
        if let Ok(conn) = self.db.lock() {
            if let Ok(Some(id)) = config_get(&conn, "computer_id") {
                if !id.is_empty() {
                    *self.computer_id.write() = Some(id);
                }
            }
            if let Ok(Some(root)) = config_get(&conn, "computer_root_id") {
                if !root.is_empty() {
                    *self.computer_root_id.write() = Some(root);
                }
            }
            let _ = clear_stale_activity(&conn);
            if let Ok(Some(ts)) = config_get(&conn, "last_synced_at") {
                if !ts.is_empty() {
                    let mut st = self.status.write();
                    st.last_synced_at = Some(ts);
                    st.status = SyncStatusKind::UpToDate;
                    st.message = "Up to date".into();
                }
            }
        }
    }

    pub fn enqueue_file_path(self: &Arc<Self>, path: PathBuf) {
        if self.is_paused() {
            return;
        }
        if self.watcher_suppress.is_suppressed(&path) {
            return;
        }

        if is_my_drive_path(&path) {
            if !path.is_file() {
                return;
            }
            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file");
            if should_skip_file(file_name) {
                return;
            }
            let engine = Arc::clone(self);
            tauri::async_runtime::spawn(async move {
                let _ = engine.sync_my_drive_path(&path).await;
            });
            return;
        }

        if !path.is_file() {
            return;
        }

        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file");
        if should_skip_file(file_name) {
            return;
        }

        let engine = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let _ = engine.sync_file_path(&path).await;
        });
    }

    pub fn enqueue_path_removed(self: &Arc<Self>, path: PathBuf) {
        self.enqueue_file_removed(path);
    }

    pub fn enqueue_folder_created(self: &Arc<Self>, path: PathBuf) {
        if self.is_paused() || self.watcher_suppress.is_suppressed(&path) {
            return;
        }
        if is_my_drive_path(&path) {
            return;
        }
        let engine = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let sync_folders = {
                let conn = engine.db.lock().map_err(|e| AppError::msg(e.to_string())).ok();
                conn.and_then(|c| list_sync_folders(&c).ok()).unwrap_or_default()
            };
            if let Some((sf, relative)) = SyncEngine::find_best_sync_folder(&sync_folders, &path) {
                let _ = enqueue_folder_create(&engine.db, sf.id, &relative);
                let _ = crate::sync::journal::drain_journal(&engine, &engine.api, &engine.db).await;
            }
        });
    }

    pub fn enqueue_path_renamed(self: &Arc<Self>, from: PathBuf, to: PathBuf) {
        if self.is_paused()
            || self.watcher_suppress.is_suppressed(&from)
            || self.watcher_suppress.is_suppressed(&to)
        {
            return;
        }
        if is_my_drive_path(&from) || is_my_drive_path(&to) {
            return;
        }
        let engine = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let sync_folders = {
                let conn = engine.db.lock().map_err(|e| AppError::msg(e.to_string())).ok();
                conn.and_then(|c| list_sync_folders(&c).ok()).unwrap_or_default()
            };
            let old_ctx = SyncEngine::find_best_sync_folder(&sync_folders, &from);
            let new_ctx = SyncEngine::find_best_sync_folder(&sync_folders, &to);

            // Rename out of the sync tree (e.g. Windows Recycle Bin) or across
            // sync folders — treat the source as a local delete.
            match (&old_ctx, &new_ctx) {
                (Some((sf_old, _)), Some((sf_new, _))) if sf_old.id != sf_new.id => {
                    let _ = engine.delete_remote_file(&from).await;
                    if to.is_file() {
                        let _ = engine.sync_file_path(&to).await;
                    } else if to.is_dir() {
                        engine.enqueue_folder_created(to);
                    }
                    return;
                }
                (Some(_), None) => {
                    let _ = engine.delete_remote_file(&from).await;
                    return;
                }
                _ => {}
            }

            if let (Some((sf, old_rel)), Some((sf2, new_rel))) = (old_ctx, new_ctx) {
                if sf.id != sf2.id {
                    return;
                }
                let entity_type = if to.is_dir() { "folder" } else { "file" };
                let remote_id = {
                    let conn = engine.db.lock().map_err(|e| AppError::msg(e.to_string())).ok();
                    if let Some(conn) = conn {
                        if entity_type == "folder" {
                            get_folder_mapping(&conn, sf.id, &old_rel).ok().flatten()
                        } else {
                            get_sync_state(&conn, sf.id, &old_rel)
                                .ok()
                                .flatten()
                                .and_then(|(id, _, _, _)| id)
                        }
                    } else {
                        None
                    }
                };
                if let Some(remote_id) = remote_id {
                    let _ = enqueue_rename(
                        &engine.db,
                        sf.id,
                        &new_rel,
                        &old_rel,
                        &remote_id,
                        entity_type,
                    );
                    let _ = crate::sync::journal::drain_journal(&engine, &engine.api, &engine.db).await;
                }
            }
            if to.is_file() {
                let _ = engine.sync_file_path(&to).await;
            }
        });
    }

    pub fn enqueue_file_removed(self: &Arc<Self>, path: PathBuf) {
        if self.is_paused() || self.watcher_suppress.is_suppressed(&path) {
            return;
        }
        // My Drive deletes go through CfAPI NOTIFY_DELETE only — ignore watcher
        // echoes from reconcile/local placeholder removal (avoids re-trash after restore).
        if is_my_drive_path(&path) {
            return;
        }

        if self.is_initial_sync_running() {
            let mut queue = self.pending_removals.lock();
            let canonical = path.canonicalize().unwrap_or(path.clone());
            if !queue
                .iter()
                .any(|p| p.canonicalize().unwrap_or(p.clone()) == canonical)
            {
                queue.push_back(path);
            }
            return;
        }

        let engine = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let _ = engine.delete_remote_file(&path).await;
        });
    }

    pub async fn drain_pending_paths(self: &Arc<Self>) {
        let paths: Vec<PathBuf> = {
            let mut queue = self.pending_paths.lock();
            queue.drain(..).collect()
        };
        let removals: Vec<PathBuf> = {
            let mut queue = self.pending_removals.lock();
            queue.drain(..).collect()
        };

        sync_log(format!(
            "drain started — {} queued uploads, {} queued removals",
            paths.len(),
            removals.len()
        ));

        let mut seen = HashSet::new();
        let mut deduped = Vec::new();
        for path in paths {
            let key = path.canonicalize().unwrap_or(path.clone());
            if seen.insert(key) {
                deduped.push(path);
            }
        }

        let upload_count = deduped.len();
        let mut join_set = JoinSet::new();
        for path in deduped {
            while join_set.len() >= UPLOAD_CONCURRENCY {
                let _ = join_set.join_next().await;
            }

            let permit = match self.upload_semaphore.clone().acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => break,
            };
            let engine = Arc::clone(self);
            join_set.spawn(async move {
                let _permit = permit;
                let _ = engine.sync_file_path_unlocked(&path).await;
            });
        }

        while join_set.join_next().await.is_some() {}

        let mut seen_removals = HashSet::new();
        let mut removals_processed = 0u64;
        for path in removals {
            let key = path.canonicalize().unwrap_or(path.clone());
            if !seen_removals.insert(key) {
                continue;
            }
            if self.delete_remote_file(&path).await.is_ok() {
                removals_processed += 1;
            }
        }

        sync_log(format!(
            "drain finished — {} uploads, {} removals processed",
            upload_count,
            removals_processed
        ));
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
        let mut st = self.status.write();
        st.paused = paused;
        st.status = if paused {
            SyncStatusKind::Paused
        } else {
            SyncStatusKind::UpToDate
        };
        st.message = if paused {
            "Sync paused".into()
        } else {
            "Up to date".into()
        };
        let _ = self.app.emit("sync-status-changed", st.clone());
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub fn is_initial_sync_running(&self) -> bool {
        self.initial_sync_running.load(Ordering::SeqCst)
    }

    pub fn get_status(&self) -> SyncStatus {
        self.status.read().clone()
    }

    pub fn report_sync_error(&self, message: impl Into<String>) {
        self.set_status(SyncStatusKind::Error, message);
    }

    pub fn set_sync_status(&self, kind: SyncStatusKind, message: impl Into<String>) {
        self.set_status(kind, message);
    }

    fn set_status(&self, kind: SyncStatusKind, message: impl Into<String>) {
        let mut st = self.status.write();
        st.status = kind;
        st.message = message.into();
        st.paused = self.paused.load(Ordering::SeqCst);
        if matches!(st.status, SyncStatusKind::UpToDate) {
            let now = chrono::Utc::now().to_rfc3339();
            st.last_synced_at = Some(now.clone());
            if let Ok(conn) = self.db.lock() {
                let _ = config_set(&conn, "last_synced_at", &now);
            }
        }
        let _ = self.app.emit("sync-status-changed", st.clone());
    }

    fn emit_activity_with_conn(
        &self,
        conn: &rusqlite::Connection,
        name: &str,
        detail: &str,
        size: i64,
        status: &str,
    ) {
        let activity_id = upsert_activity(conn, name, detail, size, status).ok();
        let _ = self.app.emit(
            "sync-activity",
            serde_json::json!({
                "id": activity_id,
                "name": name,
                "detail": detail,
                "file_size": size,
                "status": status,
            }),
        );
    }

    fn emit_activity(&self, name: &str, detail: &str, size: i64, status: &str) {
        self.emit_activity_public(name, detail, size, status);
    }

    fn upload_progress_cb(&self, file_name: &str) -> crate::api::UploadProgressCb {
        let app = self.app.clone();
        let name = file_name.to_string();
        Arc::new(move |bytes_sent, bytes_total| {
            let _ = app.emit(
                "upload-progress",
                serde_json::json!({
                    "name": name,
                    "bytes_sent": bytes_sent,
                    "bytes_total": bytes_total,
                }),
            );
        })
    }

    pub fn emit_activity_public(&self, name: &str, detail: &str, size: i64, status: &str) {
        if let Ok(conn) = self.db.lock() {
            self.emit_activity_with_conn(&conn, name, detail, size, status);
        } else {
            let _ = self.app.emit(
                "sync-activity",
                serde_json::json!({
                    "id": null,
                    "name": name,
                    "detail": detail,
                    "file_size": size,
                    "status": status,
                }),
            );
        }
    }

    /// Append a new activity row (do not overwrite same basename) — for delete/restore history.
    fn emit_activity_append_with_conn(
        &self,
        conn: &rusqlite::Connection,
        name: &str,
        detail: &str,
        size: i64,
        status: &str,
    ) {
        let activity_id = insert_activity(conn, name, detail, size, status).ok();
        let _ = self.app.emit(
            "sync-activity",
            serde_json::json!({
                "id": activity_id,
                "name": name,
                "detail": detail,
                "file_size": size,
                "status": status,
            }),
        );
    }

    pub fn emit_activity_append(&self, name: &str, detail: &str, size: i64, status: &str) {
        if let Ok(conn) = self.db.lock() {
            self.emit_activity_append_with_conn(&conn, name, detail, size, status);
        } else {
            let _ = self.app.emit(
                "sync-activity",
                serde_json::json!({
                    "id": null,
                    "name": name,
                    "detail": detail,
                    "file_size": size,
                    "status": status,
                }),
            );
        }
    }

    fn emit_progress(&self, progress: &SyncProgress) {
        let _ = self.app.emit("sync-progress", progress.clone());
        if !progress.show_in_ui {
            return;
        }
        let status_msg = match progress.phase.as_str() {
            "scanning" => progress.message.clone(),
            "syncing" if !progress.message.is_empty() => progress.message.clone(),
            "syncing" if progress.total > 0 && !progress.current_file.is_empty() => {
                format_sync_progress(progress.processed, progress.total, &progress.current_file)
            }
            "syncing" if progress.total > 0 => {
                let pct = (progress.processed * 100) / progress.total.max(1);
                format!(
                    "Processing {}/{} ({}%) files…",
                    progress.processed, progress.total, pct
                )
            }
            "syncing" => progress.message.clone(),
            "done" => progress.message.clone(),
            _ => progress.message.clone(),
        };
        match progress.phase.as_str() {
            "done" if progress.errors > 0 => {
                self.set_status(SyncStatusKind::Error, status_msg);
            }
            "done" => {
                self.set_status(SyncStatusKind::UpToDate, status_msg);
            }
            "scanning" | "syncing" => {
                self.set_status(SyncStatusKind::Syncing, status_msg);
            }
            _ => {}
        }
    }

    async fn with_heartbeat<F, Fut, T>(&self, progress: SyncProgress, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = T>,
    {
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_hb = cancel.clone();
        let app = self.app.clone();
        let heartbeat = tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                if cancel_hb.load(Ordering::Relaxed) {
                    break;
                }
                let _ = app.emit("sync-progress", progress.clone());
            }
        });

        let result = f().await;
        cancel.store(true, Ordering::Relaxed);
        let _ = heartbeat.await;
        result
    }

    fn mark_initial_sync_complete(&self) {
        if let Ok(conn) = self.db.lock() {
            let _ = config_set(&conn, "initial_sync_complete", "true");
        }
    }

    fn record_sync_failure(
        &self,
        sync_folder_id: i64,
        relative_path: &str,
        local_path: &str,
        mtime: i64,
        _detail: &str,
        permanent: bool,
    ) {
        if let Ok(conn) = self.db.lock() {
            let status = if permanent { "rejected" } else { "error" };
            let _ = upsert_sync_state(
                &conn,
                sync_folder_id,
                relative_path,
                local_path,
                None,
                None,
                Some(mtime),
                None,
                status,
            );
        }
    }

    fn is_computer_not_found_error(err: &AppError) -> bool {
        let msg = err.to_string().to_lowercase();
        msg.contains("not found") || msg.contains("(404)")
    }

    fn computer_remote_removed_flag(&self) -> bool {
        let Ok(conn) = self.db.lock() else {
            return false;
        };
        config_get(&conn, "computer_remote_removed")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(false)
    }

    fn clear_computer_remote_removed_flag(&self) -> AppResult<()> {
        let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        config_set(&conn, "computer_remote_removed", "false")?;
        Ok(())
    }

    /// Remote Remove device: stop sync registration without auto re-registering.
    pub fn handle_computer_removed_remotely(&self) -> AppResult<()> {
        let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        config_set(&conn, "computer_id", "")?;
        config_set(&conn, "computer_root_id", "")?;
        config_set(&conn, "computer_remote_removed", "true")?;
        drop(conn);
        *self.computer_id.write() = None;
        *self.computer_root_id.write() = None;
        sync_log("computer removed remotely — sync paused until folders are reconfigured");
        Ok(())
    }

    async fn heartbeat_existing_computer(&self, id: &str) -> AppResult<bool> {
        for attempt in 0..3u32 {
            match self.api.heartbeat(id).await {
                Ok(_) => return Ok(true),
                Err(e) if Self::is_computer_not_found_error(&e) => return Ok(false),
                Err(e) => {
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(500 * (attempt + 1) as u64)).await;
                        continue;
                    }
                    return Err(e);
                }
            }
        }
        Err(AppError::msg("heartbeat failed"))
    }

    fn store_computer_ids(&self, computer_id: &str, root_folder_id: &str) -> AppResult<()> {
        let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        config_set(&conn, "computer_id", computer_id)?;
        config_set(&conn, "computer_root_id", root_folder_id)?;
        config_set(&conn, "computer_remote_removed", "false")?;
        *self.computer_id.write() = Some(computer_id.to_string());
        *self.computer_root_id.write() = Some(root_folder_id.to_string());
        Ok(())
    }

    pub async fn setup_computer(&self) -> AppResult<()> {
        let existing_id = {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            config_get(&conn, "computer_id")?
        };

        if let Some(id) = existing_id.filter(|id| !id.is_empty()) {
            if self.heartbeat_existing_computer(&id).await? {
                let root = {
                    let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                    config_get(&conn, "computer_root_id")?
                };
                if let Some(r) = root.filter(|r| !r.is_empty()) {
                    *self.computer_root_id.write() = Some(r);
                }
                *self.computer_id.write() = Some(id);
                return Ok(());
            }
            // Device was removed on the server — do not auto-register.
            self.handle_computer_removed_remotely()?;
            return Ok(());
        }

        if self.computer_remote_removed_flag() {
            sync_log("setup_computer skipped — computer_remote_removed flag set");
            return Ok(());
        }

        let host = hostname::get()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "desktop".into());
        let name = host.clone();

        let computer = self.api.register_computer(&name, &host).await?;
        self.store_computer_ids(&computer.id, &computer.root_folder_id)
    }

    async fn ensure_sync_folder_remote(&self, sf: &SyncFolderRow) -> AppResult<String> {
        if self.remote_folder_exists(&sf.remote_folder_id).await {
            return Ok(sf.remote_folder_id.clone());
        }

        self.setup_computer().await?;
        let root = self
            .computer_root_id
            .read()
            .clone()
            .ok_or_else(|| AppError::msg("computer not registered"))?;

        let folder_name = if sf.label.is_empty() {
            Path::new(&sf.local_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("Folder")
                .to_string()
        } else {
            sf.label.clone()
        };

        let remote = self
            .api
            .create_or_resolve_folder(&folder_name, Some(&root))
            .await?;
        {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            update_sync_folder_remote_id(&conn, sf.id, &remote.id)?;
            clear_folder_mappings(&conn, sf.id)?;
        }
        Ok(remote.id)
    }

    pub async fn configure_folders(&self, folders: Vec<(String, String)>) -> AppResult<()> {
        // User explicitly reconfigured sync — allow register again after remote remove.
        self.clear_computer_remote_removed_flag()?;
        self.setup_computer().await?;
        let root_id = self
            .computer_root_id
            .read()
            .clone()
            .ok_or_else(|| AppError::msg("computer not registered"))?;

        for (local_path, label) in folders {
            let existing = {
                let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                get_sync_folder_by_path(&conn, &local_path)?
            };

            if let Some(ref row) = existing {
                if !is_pending_remote_folder(&row.remote_folder_id) {
                    continue;
                }
            }

            let folder_name = if label.is_empty() {
                Path::new(&local_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Folder")
                    .to_string()
            } else {
                label.clone()
            };

            let remote = self
                .api
                .create_or_resolve_folder(&folder_name, Some(&root_id))
                .await?;

            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            if let Some(row) = existing {
                update_sync_folder_remote_id(&conn, row.id, &remote.id)?;
            } else {
                insert_sync_folder(&conn, &local_path, &remote.id, &folder_name)?;
            }
        }

        Ok(())
    }

    pub async fn add_sync_folder(&self, local_path: &str, label: &str) -> AppResult<()> {
        {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            if get_sync_folder_by_path(&conn, local_path)?.is_some() {
                return Err(AppError::msg("folder is already syncing"));
            }
        }

        self.configure_folders(vec![(local_path.to_string(), label.to_string())])
            .await?;

        Ok(())
    }

    pub async fn sync_single_folder(self: Arc<Self>, sync_folder_id: i64) -> AppResult<()> {
        if self.is_paused() {
            return Ok(());
        }

        if self
            .initial_sync_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(());
        }
        let result = {
            let _guard = InitialSyncGuard {
                flag: &self.initial_sync_running,
            };
            Self::sync_single_folder_inner(&self, sync_folder_id).await
        };
        self.drain_pending_paths().await;
        result
    }

    async fn sync_single_folder_inner(self: &Arc<Self>, sync_folder_id: i64) -> AppResult<()> {
        let sf = {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            list_sync_folders(&conn)?
                .into_iter()
                .find(|f| f.id == sync_folder_id)
                .ok_or_else(|| AppError::msg("sync folder not found"))?
        };

        let remote_root_id = self.prepare_sync_folder_for_scan(&sf).await?;

        self.reconcile_and_flush_deletes(&sf).await;

        let stats = self
            .scan_folder(
                sf.id,
                &sf.local_path,
                &remote_root_id,
                ScanMode::Interactive,
            )
            .await?;

        let summary = format!(
            "Up to date — {} uploaded, {} unchanged, {} skipped",
            stats.0, stats.2, stats.1
        );
        self.set_status(SyncStatusKind::UpToDate, &summary);
        Ok(())
    }

    /// Local + remote orphan reconcile, then push journal deletes immediately.
    async fn reconcile_and_flush_deletes(self: &Arc<Self>, sf: &SyncFolderRow) {
        if let Err(e) = self.reconcile_local_deletions(sf) {
            sync_log(format!(
                "reconcile deletions failed for {}: {}",
                sf.local_path, e
            ));
        }
        if let Err(e) = self.reconcile_remote_orphans(sf).await {
            sync_log(format!(
                "reconcile remote orphans failed for {}: {}",
                sf.local_path, e
            ));
        }
        match drain_journal(self, &self.api, &self.db).await {
            Ok(n) if n > 0 => sync_log(format!("drained {} delete journal entries", n)),
            Err(e) => sync_log(format!("drain_journal after reconcile failed: {}", e)),
            _ => {}
        }
    }

    /// After a scan of existing files, detect entries we synced before whose
    /// local file/folder no longer exists (deleted while the app was not
    /// watching) and queue server-side deletes for them.
    fn reconcile_local_deletions(self: &Arc<Self>, sf: &SyncFolderRow) -> AppResult<()> {
        let root = PathBuf::from(&sf.local_path);
        if !root.exists() {
            // Folder unavailable (e.g. disconnected drive) — do not treat as deleted.
            return Ok(());
        }

        let (states, mappings) = {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            (
                list_sync_states_for_folder(&conn, sf.id)?,
                list_folder_mappings(&conn, sf.id)?,
            )
        };

        // Missing directories first; skip ones nested under another missing dir
        // (the topmost folder delete covers them server-side).
        let mut missing_dirs: Vec<_> = mappings
            .into_iter()
            .filter(|m| !m.relative_path.is_empty())
            .filter(|m| !root.join(m.relative_path.replace('/', "\\")).is_dir())
            .collect();
        missing_dirs.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

        let mut delete_roots: Vec<String> = Vec::new();
        let mut queued = 0u32;
        for m in &missing_dirs {
            if delete_roots
                .iter()
                .any(|r| m.relative_path.starts_with(&format!("{}/", r)))
            {
                continue;
            }
            delete_roots.push(m.relative_path.clone());
            let already_pending = {
                let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                crate::db::has_pending_journal_for_path(&conn, sf.id, &m.relative_path)?
            };
            if already_pending {
                continue;
            }
            enqueue_folder_delete(&self.db, sf.id, &m.relative_path, &m.remote_folder_id)?;
            queued += 1;
        }

        for (relative, _local_path, remote_id) in states {
            if delete_roots
                .iter()
                .any(|r| relative.starts_with(&format!("{}/", r)) || relative == *r)
            {
                continue;
            }
            // Prefer path under the sync root; stored absolute local_path can be stale.
            let under_root = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
            if under_root.is_file() {
                continue;
            }
            match remote_id {
                Some(rid) if !rid.is_empty() => {
                    let already_pending = {
                        let conn =
                            self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                        crate::db::has_pending_journal_for_path(&conn, sf.id, &relative)?
                    };
                    if already_pending {
                        continue;
                    }
                    enqueue_file_delete(&self.db, sf.id, &relative, &rid)?;
                    queued += 1;
                }
                _ => {
                    let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                    delete_sync_state_row(&conn, sf.id, &relative)?;
                }
            }
        }

        if queued > 0 {
            sync_log(format!(
                "local deletions detected in {} — {} server deletes queued",
                sf.local_path, queued
            ));
        }
        Ok(())
    }

    /// Walk the remote sync-folder tree and soft-delete *tracked* items that do
    /// not exist on disk (or duplicate same-name files beside the tracked id).
    /// Untracked remote files/folders (restore / web upload while offline) are
    /// left alone — the change feed downloads them. Local deletes of previously
    /// synced items are also caught by reconcile_local_deletions.
    async fn reconcile_remote_orphans(self: &Arc<Self>, sf: &SyncFolderRow) -> AppResult<()> {
        let root = PathBuf::from(&sf.local_path);
        if !root.exists() {
            return Ok(());
        }
        if sf.remote_folder_id.is_empty() || is_pending_remote_folder(&sf.remote_folder_id) {
            return Ok(());
        }

        let (tracked_files, tracked_folders) = {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            let files: HashMap<String, String> = list_sync_states_for_folder(&conn, sf.id)?
                .into_iter()
                .filter_map(|(rel, _, rid)| rid.filter(|id| !id.is_empty()).map(|id| (rel, id)))
                .collect();
            let folders: HashMap<String, String> = list_folder_mappings(&conn, sf.id)?
                .into_iter()
                .filter(|m| !m.relative_path.is_empty() && !m.remote_folder_id.is_empty())
                .map(|m| (m.relative_path, m.remote_folder_id))
                .collect();
            (files, folders)
        };

        let mut queued = 0u32;
        self.walk_remote_orphans(
            sf.id,
            &sf.remote_folder_id,
            "",
            &root,
            &tracked_files,
            &tracked_folders,
            &mut queued,
        )
        .await?;

        if queued > 0 {
            sync_log(format!(
                "remote orphans in {} — {} server deletes queued",
                sf.local_path, queued
            ));
        }
        Ok(())
    }

    async fn walk_remote_orphans(
        self: &Arc<Self>,
        sync_folder_id: i64,
        remote_folder_id: &str,
        parent_rel: &str,
        local_root: &Path,
        tracked_files: &HashMap<String, String>,
        tracked_folders: &HashMap<String, String>,
        queued: &mut u32,
    ) -> AppResult<()> {
        let contents = match self.api.get_folder_contents(remote_folder_id).await {
            Ok(c) => c,
            Err(e) => {
                sync_log(format!(
                    "orphan walk skip folder {} ({}): {}",
                    remote_folder_id, parent_rel, e
                ));
                return Ok(());
            }
        };

        // Group remote files by name — duplicates share a name in one folder.
        let mut by_name: HashMap<String, Vec<crate::api::types::FileRecord>> = HashMap::new();
        for f in contents.files {
            by_name.entry(f.name.clone()).or_default().push(f);
        }

        for (name, files) in by_name {
            let relative = if parent_rel.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", parent_rel, name)
            };
            let local_path = local_root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));

            if !local_path.is_file() {
                // Only trash remote ids this computer previously tracked.
                // Untracked remotes (restore / web create while offline) must
                // survive until the change feed downloads them.
                for f in &files {
                    if tracked_files.get(&relative).map(String::as_str) != Some(f.id.as_str()) {
                        continue;
                    }
                    if self.queue_file_delete_if_needed(sync_folder_id, &relative, &f.id)? {
                        *queued += 1;
                    }
                }
                continue;
            }

            let keep_id = tracked_files
                .get(&relative)
                .cloned()
                .filter(|id| files.iter().any(|f| f.id == *id))
                .or_else(|| {
                    // Prefer newest by updated_at when nothing is tracked.
                    files
                        .iter()
                        .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
                        .map(|f| f.id.clone())
                });

            for f in &files {
                if keep_id.as_deref() == Some(f.id.as_str()) {
                    continue;
                }
                if self.queue_file_delete_if_needed(sync_folder_id, &relative, &f.id)? {
                    *queued += 1;
                }
            }
        }

        // Missing remote folders first (top-down via recursion order); skip
        // children when parent dir is gone — folder delete covers the subtree.
        let mut folders = contents.folders;
        folders.sort_by(|a, b| a.name.cmp(&b.name));
        for folder in folders {
            let relative = if parent_rel.is_empty() {
                folder.name.clone()
            } else {
                format!("{}/{}", parent_rel, folder.name)
            };
            let local_dir = local_root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
            if !local_dir.is_dir() {
                if tracked_folders.get(&relative).map(String::as_str) != Some(folder.id.as_str()) {
                    continue;
                }
                if self.queue_folder_delete_if_needed(sync_folder_id, &relative, &folder.id)? {
                    *queued += 1;
                }
                continue;
            }
            Box::pin(self.walk_remote_orphans(
                sync_folder_id,
                &folder.id,
                &relative,
                local_root,
                tracked_files,
                tracked_folders,
                queued,
            ))
            .await?;
        }

        Ok(())
    }

    fn queue_file_delete_if_needed(
        &self,
        sync_folder_id: i64,
        relative: &str,
        remote_id: &str,
    ) -> AppResult<bool> {
        if remote_id.is_empty() {
            return Ok(false);
        }
        // Always enqueue — same relative path can have multiple remote ids (duplicates).
        // Extra deletes are idempotent (404 = already gone).
        enqueue_file_delete(&self.db, sync_folder_id, relative, remote_id)?;
        Ok(true)
    }

    /// Soft-delete live remote files that share `file_name` in `remote_folder_id`
    /// before creating a new upload (avoids durable same-name duplicates).
    async fn trash_same_name_remote_siblings(
        &self,
        sync_folder_id: i64,
        relative: &str,
        remote_folder_id: &str,
        file_name: &str,
    ) -> AppResult<()> {
        let contents = match self.api.get_folder_contents(remote_folder_id).await {
            Ok(c) => c,
            Err(e) => {
                sync_log(format!(
                    "same-name cleanup skip folder {}: {}",
                    remote_folder_id, e
                ));
                return Ok(());
            }
        };
        let mut queued = 0u32;
        for f in contents.files {
            if f.name != file_name {
                continue;
            }
            if self.queue_file_delete_if_needed(sync_folder_id, relative, &f.id)? {
                queued += 1;
            }
        }
        if queued > 0 {
            sync_log(format!(
                "pre-upload trashed {} same-name remote file(s) for {}",
                queued, relative
            ));
            let _ = drain_journal(self, &self.api, &self.db).await;
        }
        Ok(())
    }

    fn queue_folder_delete_if_needed(
        &self,
        sync_folder_id: i64,
        relative: &str,
        remote_id: &str,
    ) -> AppResult<bool> {
        if remote_id.is_empty() || is_pending_remote_folder(remote_id) {
            return Ok(false);
        }
        let already_pending = {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            crate::db::has_pending_journal_for_path(&conn, sync_folder_id, relative)?
        };
        if already_pending {
            return Ok(false);
        }
        enqueue_folder_delete(&self.db, sync_folder_id, relative, remote_id)?;
        Ok(true)
    }

    pub async fn run_background_verify(self: Arc<Self>) -> AppResult<()> {
        if self.is_paused() {
            return Ok(());
        }

        if self
            .initial_sync_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(());
        }
        let result = {
            let _guard = InitialSyncGuard {
                flag: &self.initial_sync_running,
            };

            self.set_status(SyncStatusKind::Syncing, "Syncing…");
            sync_log("background verify started");
            Self::run_background_verify_inner(&self).await
        };
        self.drain_pending_paths().await;
        sync_log("background verify finished");
        result
    }

    async fn run_background_verify_inner(self: &Arc<Self>) -> AppResult<()> {
        let sync_folders = {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            list_sync_folders(&conn)?
        };

        let mut total_uploaded = 0u64;
        let mut total_skipped = 0u64;
        let mut total_unchanged = 0u64;
        let mut total_errors = 0u64;

        for sf in sync_folders {
            let remote_root_id = self.prepare_sync_folder_for_scan(&sf).await?;
            self.reconcile_and_flush_deletes(&sf).await;
            let stats = self
                .scan_folder(
                    sf.id,
                    &sf.local_path,
                    &remote_root_id,
                    ScanMode::Background,
                )
                .await?;
            total_uploaded += stats.0;
            total_skipped += stats.1;
            total_unchanged += stats.2;
            total_errors += stats.3;
        }

        let total_processed = total_uploaded + total_skipped + total_unchanged + total_errors;
        if total_uploaded > 0 || total_errors > 0 {
            let summary = if total_errors > 0 {
                format!(
                    "Sync finished: {} uploaded, {} unchanged, {} skipped, {} errors",
                    total_uploaded, total_unchanged, total_skipped, total_errors
                )
            } else {
                format!(
                    "Up to date — {} uploaded, {} unchanged, {} skipped",
                    total_uploaded, total_unchanged, total_skipped
                )
            };

            if total_errors > 0 {
                self.set_status(SyncStatusKind::Error, &summary);
            } else {
                self.set_status(SyncStatusKind::UpToDate, &summary);
            }

            self.emit_progress(&SyncProgress {
                phase: "done".into(),
                processed: total_processed,
                total: total_processed,
                uploaded: total_uploaded,
                skipped: total_skipped,
                unchanged: total_unchanged,
                errors: total_errors,
                current: total_processed,
                current_file: String::new(),
                message: summary,
                show_in_ui: true,
            });
        } else if matches!(self.get_status().status, SyncStatusKind::Syncing) {
            self.set_status(SyncStatusKind::UpToDate, "Up to date");
        }

        if !initial_sync_complete(&self.db) && total_errors == 0 {
            self.mark_initial_sync_complete();
        }

        Ok(())
    }

    pub async fn run_initial_sync(self: Arc<Self>) -> AppResult<()> {
        if self.is_paused() {
            return Ok(());
        }

        if self
            .initial_sync_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(());
        }
        let result = {
            let _guard = InitialSyncGuard {
                flag: &self.initial_sync_running,
            };
            sync_log("initial sync started");
            Self::run_initial_sync_inner(&self).await
        };
        self.drain_pending_paths().await;
        sync_log("initial sync finished");
        result
    }

    async fn prepare_sync_folder_for_scan(&self, sf: &SyncFolderRow) -> AppResult<String> {
        if self.remote_folder_exists(&sf.remote_folder_id).await {
            return Ok(sf.remote_folder_id.clone());
        }

        // Remote root id is gone — trash anything we still tracked, then recreate.
        let (file_ids, mut folder_ids, old_root) = {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            let files: Vec<(String, String)> = list_sync_states_for_folder(&conn, sf.id)?
                .into_iter()
                .filter_map(|(rel, _, rid)| {
                    rid.filter(|id| !id.is_empty()).map(|id| (rel, id))
                })
                .collect();
            let folders: Vec<(String, String)> = list_folder_mappings(&conn, sf.id)?
                .into_iter()
                .filter(|m| !m.relative_path.is_empty())
                .filter(|m| !m.remote_folder_id.is_empty())
                .map(|m| (m.relative_path, m.remote_folder_id))
                .collect();
            (files, folders, sf.remote_folder_id.clone())
        };

        for (rel, id) in &file_ids {
            let _ = enqueue_file_delete(&self.db, sf.id, rel, id);
        }
        folder_ids.sort_by(|a, b| a.0.len().cmp(&b.0.len()));
        for (rel, id) in &folder_ids {
            if !is_pending_remote_folder(id) {
                let _ = enqueue_folder_delete(&self.db, sf.id, rel, id);
            }
        }
        let _ = drain_journal(self, &self.api, &self.db).await;

        if !old_root.is_empty() && !is_pending_remote_folder(&old_root) {
            match self.api.delete_folder_with_mutation(&old_root, None).await {
                Ok(()) => sync_log(format!("trashed stale sync root {}", old_root)),
                Err(e) => sync_log(format!(
                    "stale sync root {} already gone or failed: {}",
                    old_root, e
                )),
            }
        }

        let new_root = self.ensure_sync_folder_remote(sf).await?;
        let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        clear_folder_mappings(&conn, sf.id)?;
        clear_sync_state_for_folder(&conn, sf.id)?;
        Ok(new_root)
    }

    async fn remote_folder_exists(&self, folder_id: &str) -> bool {
        match self.api.get_folder_contents(folder_id).await {
            Ok(contents) => !contents.folder.as_ref().is_some_and(|f| f.is_trashed),
            Err(_) => false,
        }
    }

    async fn run_initial_sync_inner(self: &Arc<Self>) -> AppResult<()> {
        let sync_folders = {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            list_sync_folders(&conn)?
        };

        let mut total_uploaded = 0u64;
        let mut total_skipped = 0u64;
        let mut total_unchanged = 0u64;
        let mut total_errors = 0u64;

        for sf in sync_folders {
            let remote_root_id = self.prepare_sync_folder_for_scan(&sf).await?;
            self.reconcile_and_flush_deletes(&sf).await;
            let stats = self
                .scan_folder(
                    sf.id,
                    &sf.local_path,
                    &remote_root_id,
                    ScanMode::Interactive,
                )
                .await?;
            total_uploaded += stats.0;
            total_skipped += stats.1;
            total_unchanged += stats.2;
            total_errors += stats.3;
        }

        let total_processed = total_uploaded + total_skipped + total_unchanged + total_errors;
        let summary = if total_errors > 0 {
            format!(
                "Sync finished: {} uploaded, {} unchanged, {} skipped, {} errors",
                total_uploaded, total_unchanged, total_skipped, total_errors
            )
        } else {
            format!(
                "Up to date — {} uploaded, {} unchanged, {} skipped",
                total_uploaded, total_unchanged, total_skipped
            )
        };

        if total_errors > 0 {
            self.set_status(SyncStatusKind::Error, &summary);
        } else {
            self.set_status(SyncStatusKind::UpToDate, &summary);
        }
        self.mark_initial_sync_complete();

        let _ = self.app.emit(
            "sync-progress",
            SyncProgress {
                phase: "done".into(),
                processed: total_processed,
                total: total_processed,
                uploaded: total_uploaded,
                skipped: total_skipped,
                unchanged: total_unchanged,
                errors: total_errors,
                current: total_processed,
                current_file: String::new(),
                message: summary.clone(),
                show_in_ui: true,
            },
        );

        Ok(())
    }

    /// Returns (uploaded, skipped, unchanged, errors)
    async fn scan_folder(
        self: &Arc<Self>,
        sync_folder_id: i64,
        local_root: &str,
        remote_root_id: &str,
        mode: ScanMode,
    ) -> AppResult<(u64, u64, u64, u64)> {
        let root = PathBuf::from(local_root);
        if !root.exists() {
            return Ok((0, 0, 0, 0));
        }

        // Progress always shown so Home reflects background verify; activity only for interactive scans.
        let show_progress = true;
        let show_activity = mode == ScanMode::Interactive;
        sync_log(format!("scan start {} ({:?})", local_root, mode));

        let walk_root = root.clone();
        let files = blocking::run_blocking_with_timeout_async(
            Duration::from_secs(120),
            move || Ok(collect_files(&walk_root)),
        )
        .await
        .unwrap_or_default();

        let total = files.len() as u64;
        sync_log(format!("scan complete — {} files", total));

        // Ensure remote folder tree for every local subdirectory first so nested
        // uploads (and empty dirs) do not depend on a prior successful file sync.
        let dir_walk_root = root.clone();
        let local_dirs = blocking::run_blocking_with_timeout_async(
            Duration::from_secs(60),
            move || Ok(collect_dirs(&dir_walk_root)),
        )
        .await
        .unwrap_or_default();
        if !local_dirs.is_empty() {
            sync_log(format!(
                "ensuring {} remote folder path(s) under {}",
                local_dirs.len(),
                local_root
            ));
            for dir_path in &local_dirs {
                if self.is_paused() {
                    break;
                }
                let relative_dir = dir_path
                    .strip_prefix(&root)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                if relative_dir.is_empty() {
                    continue;
                }
                if let Err(e) = self
                    .ensure_remote_folder(sync_folder_id, remote_root_id, &relative_dir)
                    .await
                {
                    sync_log(format!(
                        "ensure remote folder failed for {}: {}",
                        relative_dir, e
                    ));
                }
            }
        }

        if show_progress {
            self.emit_progress(&SyncProgress {
                phase: "scanning".into(),
                processed: 0,
                total,
                uploaded: 0,
                skipped: 0,
                unchanged: 0,
                errors: 0,
                current: 0,
                current_file: String::new(),
                message: format!("Scanning complete — {} files", total),
                show_in_ui: true,
            });
        }

        let mut uploaded = 0u64;
        let mut skipped = 0u64;
        let mut unchanged = 0u64;
        let mut errors = 0u64;
        let mut processed = 0u64;
        let remote_root = remote_root_id.to_string();
        let mut join_set = JoinSet::new();

        for path in files {
            if self.is_paused() {
                sync_log("scan paused by user");
                break;
            }

            processed += 1;
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
                .to_string();
            let size = file_size(&path);

            if should_skip_file(&name) {
                skipped += 1;
                continue;
            }

            let relative_str = path
                .strip_prefix(&root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let mtime = file_mtime(&path).unwrap_or(0);

            let looks_unchanged = {
                let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                file_looks_unchanged(&conn, sync_folder_id, &relative_str, mtime)
            };

            if looks_unchanged {
                unchanged += 1;
                sync_log(format!(
                    "file unchanged (quick) {}/{} — {}",
                    processed,
                    total.max(1),
                    name
                ));
                continue;
            }

            while join_set.len() >= UPLOAD_CONCURRENCY {
                if let Some(res) = join_set.join_next().await {
                    self.apply_scan_file_result(
                        sync_folder_id,
                        total,
                        show_progress,
                        show_activity,
                        res,
                        &mut uploaded,
                        &mut skipped,
                        &mut unchanged,
                        &mut errors,
                    );
                }
            }

            sync_log(format!(
                "file start {}/{} — {} ({} bytes)",
                processed,
                total.max(1),
                name,
                size
            ));

            let permit = match self.upload_semaphore.clone().acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => break,
            };
            let engine = Arc::clone(self);
            let root_clone = root.clone();
            let remote_root_clone = remote_root.clone();
            let path_clone = path.clone();
            let path_for_result = path_clone.clone();
            let file_timeout = file_sync_timeout(size.max(0) as u64);
            let job_processed = processed;
            let job_name = name.clone();
            let job_relative = relative_str.clone();
            let job_mtime = mtime;
            let job_size = size;

            join_set.spawn(async move {
                let _permit = permit;
                let mut handle = tokio::spawn(async move {
                    engine
                        .sync_one_file(
                            sync_folder_id,
                            &root_clone,
                            &path_clone,
                            &remote_root_clone,
                            job_processed,
                            total,
                            false,
                            show_activity,
                        )
                        .await
                });

                let outcome = tokio::select! {
                    res = &mut handle => {
                        match res {
                            Ok(Ok(outcome)) => Ok(outcome),
                            Ok(Err(e)) => Err(e),
                            Err(e) => Err(AppError::msg(e.to_string())),
                        }
                    }
                    _ = tokio::time::sleep(file_timeout) => {
                        handle.abort();
                        let _ = handle.await;
                        sync_log(format!("file timeout abort — {}", job_name));
                        Err(AppError::msg(format!("Timed out syncing {}", job_name)))
                    }
                };

                FileSyncJobResult {
                    outcome,
                    name: job_name,
                    relative_str: job_relative,
                    path: path_for_result,
                    mtime: job_mtime,
                    size: job_size,
                    processed: job_processed,
                }
            });
        }

        while let Some(res) = join_set.join_next().await {
            self.apply_scan_file_result(
                sync_folder_id,
                total,
                show_progress,
                show_activity,
                res,
                &mut uploaded,
                &mut skipped,
                &mut unchanged,
                &mut errors,
            );
        }

        sync_log(format!(
            "scan folder done — uploaded={} skipped={} unchanged={} errors={}",
            uploaded, skipped, unchanged, errors
        ));

        Ok((uploaded, skipped, unchanged, errors))
    }

    pub async fn sync_file_path(&self, path: &Path) -> AppResult<()> {
        let _permit = self.acquire_upload_permit().await?;
        self.sync_file_path_unlocked(path).await
    }

    async fn sync_file_path_unlocked(&self, path: &Path) -> AppResult<()> {
        if self.is_paused() || !path.is_file() {
            return Ok(());
        }

        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file");
        if should_skip_file(file_name) {
            return Ok(());
        }

        let sync_folders = {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            list_sync_folders(&conn)?
        };

        for sf in sync_folders {
            let root = PathBuf::from(&sf.local_path);
            if path.starts_with(&root) {
                let remote_root_id = self.ensure_sync_folder_remote(&sf).await?;
                let _ = self
                    .sync_one_file(
                        sf.id,
                        &root,
                        path,
                        &remote_root_id,
                        0,
                        0,
                        false,
                        true,
                    )
                    .await;
                return Ok(());
            }
        }
        Ok(())
    }

    fn apply_scan_file_result(
        &self,
        sync_folder_id: i64,
        total: u64,
        show_progress: bool,
        show_activity: bool,
        res: Result<FileSyncJobResult, tokio::task::JoinError>,
        uploaded: &mut u64,
        skipped: &mut u64,
        unchanged: &mut u64,
        errors: &mut u64,
    ) {
        let job = match res {
            Ok(job) => job,
            Err(e) => {
                *errors += 1;
                sync_log(format!("file task join error — {}", e));
                return;
            }
        };

        match job.outcome {
            Ok(FileSyncOutcome::Synced) => {
                *uploaded += 1;
                sync_log(format!("file synced — {}", job.name));
            }
            Ok(FileSyncOutcome::Unchanged) => {
                *unchanged += 1;
                sync_log(format!("file unchanged — {}", job.name));
            }
            Ok(FileSyncOutcome::Skipped) => {
                *skipped += 1;
                sync_log(format!("file skipped — {}", job.name));
            }
            Ok(FileSyncOutcome::Failed) => {
                *errors += 1;
                self.record_sync_failure(
                    sync_folder_id,
                    &job.relative_str,
                    &job.path.to_string_lossy(),
                    job.mtime,
                    "Sync failed",
                    false,
                );
                sync_log(format!("file failed — {}", job.name));
            }
            Err(e) => {
                *errors += 1;
                let msg = e.to_string();
                if show_activity {
                    self.emit_activity(&job.name, &msg, job.size, "error");
                }
                self.record_sync_failure(
                    sync_folder_id,
                    &job.relative_str,
                    &job.path.to_string_lossy(),
                    job.mtime,
                    &msg,
                    is_permanent_sync_error(&msg),
                );
                sync_log(format!("file error — {}: {}", job.name, e));
            }
        }

        if show_progress {
            self.emit_progress(&SyncProgress {
                phase: "syncing".into(),
                processed: job.processed,
                total,
                uploaded: *uploaded,
                skipped: *skipped,
                unchanged: *unchanged,
                errors: *errors,
                current: job.processed,
                current_file: job.name.clone(),
                message: format_file_sync_message(&job.name),
                show_in_ui: true,
            });
        }

        sync_log(format!(
            "file done {}/{} — next",
            job.processed,
            total.max(1)
        ));
    }

    async fn sync_one_file(
        &self,
        sync_folder_id: i64,
        local_root: &Path,
        file_path: &Path,
        remote_root_id: &str,
        processed: u64,
        total: u64,
        _retried: bool,
        show_ui: bool,
    ) -> AppResult<FileSyncOutcome> {
        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();

        let relative_str = file_path
            .strip_prefix(local_root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let mtime = file_mtime(file_path).unwrap_or(0);

        match self
            .sync_one_file_with_retries(
                sync_folder_id,
                local_root,
                file_path,
                remote_root_id,
                processed,
                total,
                &file_name,
                show_ui,
            )
            .await
        {
            Ok(outcome) => Ok(outcome),
            Err(e) => {
                let msg = e.to_string();
                if show_ui {
                    self.emit_activity(&file_name, &msg, 0, "error");
                }
                self.record_sync_failure(
                    sync_folder_id,
                    &relative_str,
                    &file_path.to_string_lossy(),
                    mtime,
                    &msg,
                    is_permanent_sync_error(&msg),
                );
                Ok(FileSyncOutcome::Failed)
            }
        }
    }

    async fn sync_one_file_with_retries(
        &self,
        sync_folder_id: i64,
        local_root: &Path,
        file_path: &Path,
        remote_root_id: &str,
        processed: u64,
        total: u64,
        file_name: &str,
        show_ui: bool,
    ) -> AppResult<FileSyncOutcome> {
        let mut remote_root = remote_root_id.to_string();
        for attempt in 0..2u8 {
            match self
                .sync_one_file_attempt(
                    sync_folder_id,
                    local_root,
                    file_path,
                    &remote_root,
                    processed,
                    total,
                    file_name,
                    attempt > 0,
                    show_ui,
                )
                .await?
            {
                SyncAttemptResult::Done(outcome) => return Ok(outcome),
                SyncAttemptResult::RetryClearFileState => {
                    let relative_str = file_path
                        .strip_prefix(local_root)
                        .map_err(|e| AppError::msg(e.to_string()))?
                        .to_string_lossy()
                        .replace('\\', "/");
                    let old_remote = {
                        let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                        get_sync_state(&conn, sync_folder_id, &relative_str)?
                            .and_then(|(remote_id, _, _, _)| remote_id)
                    };
                    if let Some(rid) = old_remote {
                        if !rid.is_empty() {
                            enqueue_file_delete(&self.db, sync_folder_id, &relative_str, &rid)?;
                            let _ = drain_journal(self, &self.api, &self.db).await;
                        }
                    }
                    let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                    clear_sync_state_remote_file(&conn, sync_folder_id, &relative_str)?;
                }
                SyncAttemptResult::RetryClearRoot => {
                    let sf = {
                        let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                        list_sync_folders(&conn)?
                            .into_iter()
                            .find(|f| f.id == sync_folder_id)
                            .ok_or_else(|| AppError::msg("sync folder not found"))?
                    };
                    remote_root = self.ensure_sync_folder_remote(&sf).await?;
                }
                SyncAttemptResult::RetryClearFolderMapping(parent_relative) => {
                    let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                    clear_folder_mapping_prefix(&conn, sync_folder_id, &parent_relative)?;
                }
            }
        }
        Ok(FileSyncOutcome::Failed)
    }

    async fn sync_one_file_attempt(
        &self,
        sync_folder_id: i64,
        local_root: &Path,
        file_path: &Path,
        remote_root_id: &str,
        processed: u64,
        total: u64,
        file_name: &str,
        is_retry: bool,
        show_ui: bool,
    ) -> AppResult<SyncAttemptResult> {
        let relative = file_path
            .strip_prefix(local_root)
            .map_err(|e| AppError::msg(e.to_string()))?;
        let relative_str = relative.to_string_lossy().replace('\\', "/");
        let size = file_size(file_path);
        let mtime = file_mtime(file_path).unwrap_or(0);

        let existing = {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            get_sync_state(&conn, sync_folder_id, &relative_str)?
        };

        if file_looks_unchanged_from_state(existing.as_ref(), mtime) {
            if show_ui {
                self.emit_activity(file_name, "Up to date", size, "synced");
            }
            return Ok(SyncAttemptResult::Done(FileSyncOutcome::Unchanged));
        }

        let base_progress = SyncProgress {
            phase: "syncing".into(),
            processed,
            total,
            uploaded: 0,
            skipped: 0,
            unchanged: 0,
            errors: 0,
            current: processed,
            current_file: file_name.to_string(),
            message: format_file_sync_message(file_name),
            show_in_ui: show_ui,
        };

        if show_ui {
            self.emit_activity(file_name, "Hashing…", size, "uploading");
        }
        sync_log(format!("hash start — {}", file_name));
        let hash = match hash_file_async(file_path, hash_timeout()).await {
            Ok(h) => {
                sync_log(format!("hash ok — {}", file_name));
                h
            }
            Err(e) => {
                let msg = e.to_string();
                let detail = if msg.contains("timed out") {
                    "Cannot read file (timeout)".to_string()
                } else {
                    format!("Cannot read file: {}", msg)
                };
                if show_ui {
                    self.emit_activity(file_name, &detail, 0, "skipped");
                }
                return Ok(SyncAttemptResult::Done(FileSyncOutcome::Skipped));
            }
        };

        if let Some((remote_id, old_hash, _, _)) = &existing {
            if old_hash.as_deref() == Some(&hash) {
                if let Ok(conn) = self.db.lock() {
                    let _ = upsert_sync_state(
                        &conn,
                        sync_folder_id,
                        &relative_str,
                        &file_path.to_string_lossy(),
                        remote_id.as_deref(),
                        Some(&hash),
                        Some(mtime),
                        None,
                        "synced",
                    );
                }
                if show_ui {
                    self.emit_activity(file_name, "Up to date", size, "synced");
                }
                return Ok(SyncAttemptResult::Done(FileSyncOutcome::Unchanged));
            }
            if let Some(rid) = remote_id.clone() {
                if show_ui {
                    self.emit_activity(file_name, "Updating…", size, "uploading");
                }
                let existing_key = {
                    let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                    get_file_key(&conn, &rid)?
                        .and_then(|k| crate::crypto::key_from_b64url(&k).ok())
                };
                let upload_result = self
                    .with_heartbeat(
                        SyncProgress {
                            message: format!("Uploading {} ({})…", file_name, format_size(size)),
                            ..base_progress.clone()
                        },
                        || {
                            self.api.update_file_content(
                                &rid,
                                file_path,
                                file_name,
                                existing_key,
                                Some(self.upload_progress_cb(file_name)),
                            )
                        },
                    )
                    .await;

                match upload_result {
                    Ok((rec, key)) => {
                        let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                        store_file_key(&conn, &rec.id, &key_to_b64url(&key))?;
                        upsert_sync_state(
                            &conn,
                            sync_folder_id,
                            &relative_str,
                            &file_path.to_string_lossy(),
                            Some(&rec.id),
                            Some(&hash),
                            Some(mtime),
                            Some(&rec.updated_at),
                            "synced",
                        )?;
                        // Always record successful uploads so background verify
                        // still appears on the activity list.
                        self.emit_activity_with_conn(
                            &conn,
                            file_name,
                            "Successfully uploaded",
                            rec.size,
                            "synced",
                        );
                        return Ok(SyncAttemptResult::Done(FileSyncOutcome::Synced));
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        if is_stale_remote_ref(&msg) && !is_retry {
                            return Ok(SyncAttemptResult::RetryClearFileState);
                        }
                        if show_ui {
                            self.emit_activity(file_name, &msg, 0, "error");
                        }
                        self.record_sync_failure(
                            sync_folder_id,
                            &relative_str,
                            &file_path.to_string_lossy(),
                            mtime,
                            &msg,
                            is_permanent_sync_error(&msg),
                        );
                        return Ok(SyncAttemptResult::Done(FileSyncOutcome::Failed));
                    }
                }
            }
        }

        let parent_relative = Path::new(&relative_str)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();

        if show_ui {
            self.emit_activity(file_name, "Resolving folder…", size, "uploading");
        }
        let remote_folder_id = match tokio::time::timeout(
            FOLDER_TIMEOUT,
            self.ensure_remote_folder(sync_folder_id, remote_root_id, &parent_relative),
        )
        .await
        {
            Ok(Ok(id)) => id,
            Ok(Err(e)) => {
                let msg = e.to_string();
                if show_ui {
                    self.emit_activity(file_name, &msg, 0, "error");
                }
                self.record_sync_failure(
                    sync_folder_id,
                    &relative_str,
                    &file_path.to_string_lossy(),
                    mtime,
                    &msg,
                    false,
                );
                return Ok(SyncAttemptResult::Done(FileSyncOutcome::Failed));
            }
            Err(_) => {
                if show_ui {
                    self.emit_activity(file_name, "Folder resolution timed out", 0, "error");
                }
                self.record_sync_failure(
                    sync_folder_id,
                    &relative_str,
                    &file_path.to_string_lossy(),
                    mtime,
                    "Folder resolution timed out",
                    false,
                );
                return Ok(SyncAttemptResult::Done(FileSyncOutcome::Failed));
            }
        };

        // Soft-delete any live same-name files in the remote folder so a fresh
        // upload does not leave duplicates beside a missed prior delete.
        if let Err(e) = self
            .trash_same_name_remote_siblings(
                sync_folder_id,
                &relative_str,
                &remote_folder_id,
                file_name,
            )
            .await
        {
            sync_log(format!(
                "pre-upload same-name cleanup failed for {}: {}",
                relative_str, e
            ));
        }

        if show_ui {
            self.emit_activity(file_name, "Uploading…", size, "uploading");
            if size >= LARGE_FILE_WARN_BYTES {
                self.emit_activity(
                    file_name,
                    &format!(
                        "Large file ({}) — upload may take several minutes",
                        format_size(size)
                    ),
                    size,
                    "uploading",
                );
            }
        }
        let upload_result = self
            .with_heartbeat(
                SyncProgress {
                    message: format!("Uploading {} ({})…", file_name, format_size(size)),
                    ..base_progress
                },
                || {
                    self.api.upload_file(
                        &self.db,
                        file_path,
                        file_name,
                        &remote_folder_id,
                        Some(self.upload_progress_cb(file_name)),
                    )
                },
            )
            .await;

        match upload_result {
            Ok((rec, key)) => {
                let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                store_file_key(&conn, &rec.id, &key_to_b64url(&key))?;
                upsert_sync_state(
                    &conn,
                    sync_folder_id,
                    &relative_str,
                    &file_path.to_string_lossy(),
                    Some(&rec.id),
                    Some(&hash),
                    Some(mtime),
                    Some(&rec.updated_at),
                    "synced",
                )?;
                // Always record successful uploads so background verify
                // still appears on the activity list.
                self.emit_activity_with_conn(
                    &conn,
                    file_name,
                    "Successfully uploaded",
                    rec.size,
                    "synced",
                );
                if crate::db::has_pending_key_upload(&conn, &rec.id).unwrap_or(false) {
                    let _ = self.app.emit(
                        "crypto-key-queued",
                        format!(
                            "Encryption not unlocked — {} may be unavailable in the browser until you sign in with your password",
                            file_name
                        ),
                    );
                }
                Ok(SyncAttemptResult::Done(FileSyncOutcome::Synced))
            }
            Err(e) => {
                let msg = e.to_string();
                if is_stale_remote_ref(&msg) && !is_retry {
                    if parent_relative.is_empty() {
                        return Ok(SyncAttemptResult::RetryClearRoot);
                    }
                    return Ok(SyncAttemptResult::RetryClearFolderMapping(
                        parent_relative,
                    ));
                }
                if show_ui {
                    self.emit_activity(file_name, &msg, 0, "error");
                }
                self.record_sync_failure(
                    sync_folder_id,
                    &relative_str,
                    &file_path.to_string_lossy(),
                    mtime,
                    &msg,
                    is_permanent_sync_error(&msg),
                );
                Ok(SyncAttemptResult::Done(FileSyncOutcome::Failed))
            }
        }
    }

    async fn ensure_remote_folder(
        &self,
        sync_folder_id: i64,
        remote_root_id: &str,
        relative_dir: &str,
    ) -> AppResult<String> {
        if relative_dir.is_empty() {
            return Ok(remote_root_id.to_string());
        }

        {
            let cached_id = {
                let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                get_folder_mapping(&conn, sync_folder_id, relative_dir)?
            };
            if let Some(id) = cached_id {
                if self.remote_folder_exists(&id).await {
                    return Ok(id);
                }
                let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                delete_folder_mapping(&conn, sync_folder_id, relative_dir)?;
            }
        }

        let parts: Vec<&str> = relative_dir.split('/').filter(|p| !p.is_empty()).collect();
        let mut current_parent = remote_root_id.to_string();
        let mut built = String::new();

        for part in parts {
            if !built.is_empty() {
                built.push('/');
            }
            built.push_str(part);

            let cached_id = {
                let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                get_folder_mapping(&conn, sync_folder_id, &built)?
            };

            if let Some(id) = cached_id {
                if self.remote_folder_exists(&id).await {
                    current_parent = id;
                    continue;
                }
                let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                delete_folder_mapping(&conn, sync_folder_id, &built)?;
            }

            let folder = self
                .api
                .create_or_resolve_folder(part, Some(&current_parent))
                .await?;
            {
                let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                set_folder_mapping(&conn, sync_folder_id, &built, &folder.id)?;
            }
            current_parent = folder.id;
        }

        Ok(current_parent)
    }

    pub fn watcher_suppress(&self) -> &WatcherSuppress {
        &self.watcher_suppress
    }

    pub async fn ensure_folder_remote_path(
        &self,
        sync_folder_id: i64,
        relative_path: &str,
    ) -> AppResult<()> {
        let sf = {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            list_sync_folders(&conn)?
                .into_iter()
                .find(|f| f.id == sync_folder_id)
                .ok_or_else(|| AppError::msg("sync folder not found"))?
        };
        let remote_root = self.ensure_sync_folder_remote(&sf).await?;
        let _ = self
            .ensure_remote_folder(sync_folder_id, &remote_root, relative_path)
            .await?;
        Ok(())
    }

    fn find_best_sync_folder<'a>(
        sync_folders: &'a [SyncFolderRow],
        path: &Path,
    ) -> Option<(&'a SyncFolderRow, String)> {
        let mut best: Option<(&SyncFolderRow, String, usize)> = None;
        for sf in sync_folders {
            let root = PathBuf::from(&sf.local_path);
            if path.starts_with(&root) {
                let relative = path
                    .strip_prefix(&root)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                let len = sf.local_path.len();
                if best.as_ref().map(|(_, _, l)| len > *l).unwrap_or(true) {
                    best = Some((sf, relative, len));
                }
            }
        }
        best.map(|(sf, rel, _)| (sf, rel))
    }

    pub async fn poll_my_drive(&self) -> AppResult<()> {
        if self.is_paused() || self.is_initial_sync_running() {
            return Ok(());
        }
        let mirror = sync_mode_is_mirror(&self.db);
        crate::my_drive::poll_my_drive(
            &self.api,
            &self.db,
            mirror,
            Arc::clone(&self.download_semaphore),
            Some(&self.watcher_suppress),
        )
        .await
    }

    /// Bidirectional sync: drain journal, poll server change feed, apply locally.
    pub async fn poll_remote(&self) -> AppResult<()> {
        if self.is_paused() || self.is_initial_sync_running() {
            return Ok(());
        }

        let computer_id = {
            let guard = self.computer_id.read();
            guard.clone()
        };
        let computer_root_id = {
            let guard = self.computer_root_id.read();
            guard.clone()
        };
        let (computer_id, computer_root_id) = match (computer_id, computer_root_id) {
            (Some(id), Some(root)) => (id, root),
            _ => return Ok(()),
        };

        let sync_folders = {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            list_sync_folders(&conn)?
        };
        if sync_folders.is_empty() {
            return Ok(());
        }

        if let Err(e) = run_sync_cycle(
            self,
            &self.api,
            &self.db,
            &self.watcher_suppress,
            &computer_id,
            &computer_root_id,
        )
        .await
        {
            if Self::is_computer_not_found_error(&e) {
                let _ = self.handle_computer_removed_remotely();
            } else {
                sync_log(format!("poll_remote failed: {}", e));
            }
        }
        Ok(())
    }

    pub async fn sync_my_drive_path(&self, path: &Path) -> AppResult<()> {
        if self.is_paused() || self.is_initial_sync_running() {
            return Ok(());
        }
        let _permit = self.acquire_upload_permit().await?;
        crate::my_drive::upload_my_drive_path(&self.api, &self.db, path).await
    }

    pub async fn delete_remote_file(&self, path: &Path) -> AppResult<()> {
        if self.is_paused() || self.is_initial_sync_running() {
            return Ok(());
        }

        if is_my_drive_path(path) {
            return crate::my_drive::delete_my_drive_path(&self.api, &self.db, path).await;
        }

        if path.is_file() {
            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file");
            if should_skip_file(file_name) {
                return Ok(());
            }
        }

        let sync_folders = {
            let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            list_sync_folders(&conn)?
        };

        if let Some((sf, relative)) = Self::find_best_sync_folder(&sync_folders, path) {
            // Path may already be gone after Remove — prefer mapping / sync_state
            // over path.is_dir() / path.is_file().
            let folder_remote = {
                let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                if relative.is_empty() {
                    None
                } else {
                    get_folder_mapping(&conn, sf.id, &relative)?
                }
            };

            if folder_remote.is_some() || path.is_dir() {
                let remote_id = folder_remote.or_else(|| {
                    if relative.is_empty() {
                        Some(sf.remote_folder_id.clone())
                    } else {
                        None
                    }
                });
                if let Some(remote_id) = remote_id {
                    if !remote_id.is_empty() && !is_pending_remote_folder(&remote_id) {
                        enqueue_folder_delete(&self.db, sf.id, &relative, &remote_id)?;
                        let _ = drain_journal(self, &self.api, &self.db).await;
                    }
                }
                return Ok(());
            }

            let remote_id = {
                let conn = self.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                get_sync_state(&conn, sf.id, &relative)?
                    .and_then(|(remote_id, _, _, _)| remote_id)
            };
            if let Some(remote_id) = remote_id {
                if !remote_id.is_empty() {
                    enqueue_file_delete(&self.db, sf.id, &relative, &remote_id)?;
                    let _ = drain_journal(self, &self.api, &self.db).await;
                }
            }
            return Ok(());
        }
        Ok(())
    }

    pub async fn heartbeat_loop(&self) -> AppResult<()> {
        let id = {
            let guard = self.computer_id.read();
            guard.clone()
        };
        if let Some(id) = id {
            match self.api.heartbeat(&id).await {
                Ok(_) => {}
                Err(e) if Self::is_computer_not_found_error(&e) => {
                    let _ = self.handle_computer_removed_remotely();
                }
                Err(e) => {
                    sync_log(format!("heartbeat failed: {}", e));
                }
            }
        }
        Ok(())
    }
}

fn is_stale_remote_ref(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("foreign key")
        || lower.contains("787")
        || lower.contains("not found")
        || lower.contains("folder not found")
}

fn is_my_drive_path(path: &Path) -> bool {
    crate::auth_store::my_drive_path(false)
        .ok()
        .is_some_and(|root| path.starts_with(&root))
}

pub(crate) fn should_skip_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower == "desktop.ini" || lower == "thumbs.db" || lower == "ehthumbs.db" {
        return true;
    }
    if lower.ends_with(".tmp") || lower.ends_with(".temp") || lower.ends_with(".lnk") {
        return true;
    }
    if lower.starts_with('.') || lower.starts_with("~$") {
        return true;
    }
    const GIT_INTERNAL: &[&str] = &[
        "fetch_head",
        "head",
        "index",
        "orig_head",
        "packed-refs",
        "commit_editmsg",
        "merge_head",
        "cherry_pick_head",
        "rebase_merge",
    ];
    if GIT_INTERNAL.contains(&lower.as_str()) {
        return true;
    }
    false
}

fn should_skip_dir(name: &str) -> bool {
    matches!(name, ".git" | ".svn" | "node_modules")
}

fn collect_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    walk_files_incremental(root, |path| files.push(path));
    files.sort_by_key(|p| file_size(p));
    files
}

/// Relative subdirectory paths under `root` (root itself excluded), depth-first
/// so parents are ensured before children when iterated in sorted order.
fn collect_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let dir_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if should_skip_dir(dir_name) {
                continue;
            }
            dirs.push(path.clone());
            stack.push(path);
        }
    }
    dirs.sort_by(|a, b| {
        let a_s = a.to_string_lossy();
        let b_s = b.to_string_lossy();
        a_s.cmp(&b_s).then_with(|| a_s.len().cmp(&b_s.len()))
    });
    dirs
}

fn walk_files_incremental(root: &Path, mut on_file: impl FnMut(PathBuf)) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let dir_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if !should_skip_dir(dir_name) {
                    stack.push(path);
                }
            } else if path.is_file() {
                on_file(path);
            }
        }
    }
}

fn file_hash(path: &Path) -> AppResult<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

async fn hash_file_async(path: &Path, timeout: Duration) -> AppResult<String> {
    let path = path.to_path_buf();
    blocking::run_blocking_with_timeout_async(timeout, move || file_hash(&path)).await
}

fn format_file_sync_message(name: &str) -> String {
    format!("Syncing {}…", name)
}

fn format_sync_progress(processed: u64, total: u64, name: &str) -> String {
    if total > 0 {
        let pct = (processed * 100) / total;
        format!("Processing {}/{} ({}%) — {}", processed, total, pct, name)
    } else {
        format!("Processing {} — {}", processed, name)
    }
}

fn file_looks_unchanged_from_state(
    existing: Option<&(Option<String>, Option<String>, Option<i64>, String)>,
    mtime: i64,
) -> bool {
    match existing {
        Some((remote_id, _, Some(old_mtime), status)) if *old_mtime == mtime => {
            // Successfully synced: skip until mtime changes.
            if remote_id.as_ref().is_some_and(|id| !id.is_empty()) {
                return true;
            }
            // Permanent rejection only — transient `error` must retry so
            // ensure_remote_folder / upload can recover after server fixes.
            status == "rejected"
        }
        _ => false,
    }
}

fn file_looks_unchanged(
    conn: &rusqlite::Connection,
    sync_folder_id: i64,
    relative_path: &str,
    mtime: i64,
) -> bool {
    match get_sync_state(conn, sync_folder_id, relative_path) {
        Ok(state) => file_looks_unchanged_from_state(state.as_ref(), mtime),
        Err(_) => false,
    }
}

fn is_permanent_sync_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("file type not allowed")
        || lower.contains("status 400")
        || lower.contains("(400)")
}

fn file_mtime(path: &Path) -> AppResult<i64> {
    let meta = std::fs::metadata(path)?;
    let modified = meta.modified()?;
    Ok(modified
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64)
}

fn file_size(path: &Path) -> i64 {
    std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0)
}

fn format_size(bytes: i64) -> String {
    if bytes < 1024 {
        return format!("{} B", bytes);
    }
    if bytes < 1024 * 1024 {
        return format!("{:.1} KB", bytes as f64 / 1024.0);
    }
    if bytes < 1024 * 1024 * 1024 {
        return format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0));
    }
    format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

pub fn initial_sync_complete(db: &DbHandle) -> bool {
    db.lock()
        .ok()
        .and_then(|c| config_get(&c, "initial_sync_complete").ok().flatten())
        .map(|v| v == "true")
        .unwrap_or(false)
}

pub fn has_pending_sync(db: &DbHandle) -> bool {
    !initial_sync_complete(db)
}

const SYNC_MODE_KEY: &str = "sync_mode";

pub fn get_sync_mode(db: &DbHandle) -> String {
    db.lock()
        .ok()
        .and_then(|c| config_get(&c, SYNC_MODE_KEY).ok().flatten())
        .filter(|v| v == "stream" || v == "mirror")
        .unwrap_or_else(|| "stream".to_string())
}

pub fn sync_mode_is_mirror(db: &DbHandle) -> bool {
    get_sync_mode(db) == "mirror"
}

pub fn sync_mode_is_stream(db: &DbHandle) -> bool {
    !sync_mode_is_mirror(db)
}

pub fn set_sync_mode(db: &DbHandle, mode: &str) -> AppResult<()> {
    let normalized = if mode == "stream" { "stream" } else { "mirror" };
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    config_set(&conn, SYNC_MODE_KEY, normalized)
}

#[cfg(test)]
mod tests {
    use super::should_skip_file;

    #[test]
    fn skips_office_lock_and_junk_files() {
        assert!(should_skip_file("~$jpowszechniejsze atrybuty S.M.A.R.T.rtf"));
        assert!(should_skip_file("~$foo.docx"));
        assert!(should_skip_file("desktop.ini"));
        assert!(should_skip_file("Thumbs.db"));
        assert!(should_skip_file(".hidden"));
        assert!(should_skip_file("notes.tmp"));
        assert!(!should_skip_file("Najpowszechniejsze atrybuty S.M.A.R.T.rtf"));
        assert!(!should_skip_file("report.docx"));
    }
}
