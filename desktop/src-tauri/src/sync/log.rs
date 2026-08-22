use crate::auth_store::data_dir;
use crate::error::AppResult;
use parking_lot::Mutex;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::LazyLock;

static LOG_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024; // 10 MB

pub fn sync_log(message: impl AsRef<str>) {
    let _ = sync_log_result(message);
}

pub fn sync_log_result(message: impl AsRef<str>) -> AppResult<()> {
    let _guard = LOG_LOCK.lock();
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("sync.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() >= MAX_LOG_BYTES {
            let old = dir.join("sync.log.old");
            let _ = std::fs::remove_file(&old);
            let _ = std::fs::rename(&path, &old);
        }
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let ts = chrono::Utc::now().to_rfc3339();
    writeln!(file, "[{ts}] {}", message.as_ref())?;
    Ok(())
}
