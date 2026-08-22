use crate::api::ApiClient;
use crate::db::DbHandle;
use crate::sync::engine::SyncEngine;
use crate::sync::watcher::WatcherHandle;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct SyncBackground {
    started: AtomicBool,
}

impl SyncBackground {
    pub fn new() -> Self {
        Self {
            started: AtomicBool::new(false),
        }
    }

    /// Returns true only the first time background poll/heartbeat loops should start.
    pub fn try_start_background(&self) -> bool {
        !self.started.swap(true, Ordering::SeqCst)
    }

    pub fn reset(&self) {
        self.started.store(false, Ordering::SeqCst);
    }
}

pub struct AppState {
    pub db: DbHandle,
    pub api: Mutex<Option<ApiClient>>,
    pub sync_engine: Mutex<Option<Arc<SyncEngine>>>,
    pub watcher: Mutex<Option<WatcherHandle>>,
    pub sync_background: SyncBackground,
    onboarding_complete: AtomicBool,
}

impl AppState {
    pub fn new(db: DbHandle) -> Self {
        let onboarding_complete = db
            .lock()
            .ok()
            .and_then(|conn| crate::db::config_get(&conn, "onboarding_complete").ok().flatten())
            .is_some_and(|v| v == "true");

        Self {
            db,
            api: Mutex::new(None),
            sync_engine: Mutex::new(None),
            watcher: Mutex::new(None),
            sync_background: SyncBackground::new(),
            onboarding_complete: AtomicBool::new(onboarding_complete),
        }
    }

    pub fn is_onboarding_complete(&self) -> bool {
        if self.onboarding_complete.load(Ordering::SeqCst) {
            return true;
        }
        if let Ok(conn) = self.db.try_lock() {
            let complete = crate::db::config_get(&conn, "onboarding_complete")
                .ok()
                .flatten()
                .is_some_and(|v| v == "true");
            if complete {
                self.onboarding_complete.store(true, Ordering::SeqCst);
            }
            return complete;
        }
        false
    }

    pub fn mark_onboarding_complete(&self) {
        self.onboarding_complete.store(true, Ordering::SeqCst);
        self.persist_onboarding_complete();
    }

    pub fn refresh_onboarding_from_db(&self) {
        let complete = self
            .db
            .try_lock()
            .ok()
            .and_then(|conn| crate::db::config_get(&conn, "onboarding_complete").ok().flatten())
            .is_some_and(|v| v == "true");
        self.onboarding_complete
            .store(complete, Ordering::SeqCst);
    }

    fn persist_onboarding_complete(&self) {
        if let Ok(conn) = self.db.try_lock() {
            let _ = crate::db::config_set(&conn, "onboarding_complete", "true");
            return;
        }

        let db = self.db.clone();
        std::thread::spawn(move || {
            for _ in 0..600 {
                if let Ok(conn) = db.try_lock() {
                    let _ = crate::db::config_set(&conn, "onboarding_complete", "true");
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        });
    }

    pub fn set_api(&self, client: ApiClient) {
        *self.api.lock() = Some(client);
    }

    pub fn api(&self) -> Result<ApiClient, String> {
        self.api
            .lock()
            .clone()
            .ok_or_else(|| "Not authenticated".to_string())
    }

    pub fn set_sync_engine(&self, engine: Arc<SyncEngine>) {
        *self.sync_engine.lock() = Some(engine);
    }

    pub fn sync_engine(&self) -> Result<Arc<SyncEngine>, String> {
        self.sync_engine
            .lock()
            .clone()
            .ok_or_else(|| "Sync engine not initialized".to_string())
    }

    pub fn set_watcher(&self, watcher: WatcherHandle) {
        *self.watcher.lock() = Some(watcher);
    }
}
