use crate::error::{AppError, AppResult};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Run an async future on a dedicated thread with its own tokio runtime.
/// Safe from tokio worker threads and CfAPI callback threads.
pub fn run_async_future<T, F>(future: F) -> Result<T, String>
where
    T: Send + 'static,
    F: std::future::Future<Output = Result<T, String>> + Send + 'static,
{
    let (tx, rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt.block_on(future),
            Err(e) => Err(format!("failed to create async runtime: {}", e)),
        };
        let _ = tx.send(result);
    });
    rx.recv()
        .map_err(|_| "async bridge thread disconnected".to_string())?
}

/// Like `run_async_future`, but returns an error if the future does not complete in time.
pub fn run_async_future_with_timeout<T, F>(
    timeout: Duration,
    future: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: std::future::Future<Output = Result<T, String>> + Send + 'static,
{
    let (tx, rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt.block_on(future),
            Err(e) => Err(format!("failed to create async runtime: {}", e)),
        };
        let _ = tx.send(result);
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(e),
        Err(mpsc::RecvTimeoutError::Timeout) => Err("operation timed out".to_string()),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("async bridge thread disconnected".to_string())
        }
    }
}

/// Runs `f` on a detached OS thread. Returns after `timeout` even if `f` is still running
/// (the thread is orphaned). Does not use tokio's blocking pool for `f`.
pub async fn run_blocking_with_timeout_async<T: Send + 'static>(
    timeout: Duration,
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let (tx, rx) = mpsc::sync_channel::<AppResult<T>>(1);
    thread::spawn(move || {
        let _ = tx.send(f());
    });

    tokio::task::spawn_blocking(move || match rx.recv_timeout(timeout) {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(e),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(AppError::msg("operation timed out")),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(AppError::msg("blocking task failed")),
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))?
}

pub fn hash_timeout() -> Duration {
    Duration::from_secs(60)
}

pub fn upload_prep_timeout(file_size: u64) -> Duration {
    let size_mb = file_size / (1024 * 1024);
    Duration::from_secs(120).max(Duration::from_secs(30 + size_mb.saturating_mul(10)))
}

pub fn upload_http_timeout(file_size: u64) -> Duration {
    let size_mb = file_size / (1024 * 1024);
    Duration::from_secs(120).max(Duration::from_secs(60 + size_mb.saturating_mul(15)))
}

/// Total per-file budget: encrypt prep + HTTP upload + margin.
pub fn file_sync_timeout(file_size: u64) -> Duration {
    upload_prep_timeout(file_size) + upload_http_timeout(file_size) + Duration::from_secs(30)
}
