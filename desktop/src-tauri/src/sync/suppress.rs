use parking_lot::RwLock;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
pub struct WatcherSuppress {
    inner: Arc<RwLock<HashSet<PathBuf>>>,
}

impl WatcherSuppress {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    pub fn is_suppressed(&self, path: &Path) -> bool {
        self.inner.read().contains(path)
    }

    pub fn run_suppressed<F, R>(&self, path: &Path, f: F) -> R
    where
        F: FnOnce() -> R,
    {
        self.inner.write().insert(path.to_path_buf());
        let result = f();
        let inner = Arc::clone(&self.inner);
        let p = path.to_path_buf();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            inner.write().remove(&p);
        });
        result
    }
}

impl Default for WatcherSuppress {
    fn default() -> Self {
        Self::new()
    }
}
