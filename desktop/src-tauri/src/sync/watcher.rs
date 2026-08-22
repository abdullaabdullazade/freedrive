use crate::error::AppResult;
use crate::sync::engine::SyncEngine;
use notify::EventKind;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub struct WatcherHandle {
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::FileIdMap,
    >,
}

impl WatcherHandle {
    pub fn start(paths: Vec<PathBuf>, engine: Arc<SyncEngine>) -> AppResult<Self> {
        let engine_clone = engine.clone();
        let mut debouncer = new_debouncer(
            Duration::from_secs(1),
            None,
            move |result: DebounceEventResult| {
                if let Ok(events) = result {
                    for debounced in events {
                        let kind = debounced.event.kind;
                        match kind {
                            EventKind::Remove(_) => {
                                for path in &debounced.event.paths {
                                    if engine_clone.watcher_suppress().is_suppressed(path) {
                                        continue;
                                    }
                                    engine_clone.enqueue_path_removed(path.clone());
                                }
                            }
                            EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
                                if debounced.event.paths.len() >= 2 {
                                    let from = debounced.event.paths[0].clone();
                                    let to = debounced.event.paths[1].clone();
                                    if engine_clone.watcher_suppress().is_suppressed(&to)
                                        || engine_clone.watcher_suppress().is_suppressed(&from)
                                    {
                                        continue;
                                    }
                                    engine_clone.enqueue_path_renamed(from, to);
                                } else {
                                    // Windows often emits a single-path Name event on
                                    // delete/rename. Missing path → delete; present file → sync.
                                    for path in &debounced.event.paths {
                                        if engine_clone.watcher_suppress().is_suppressed(path) {
                                            continue;
                                        }
                                        if !path.exists() {
                                            engine_clone.enqueue_path_removed(path.clone());
                                        } else if path.is_file() {
                                            engine_clone.enqueue_file_path(path.clone());
                                        } else if path.is_dir() {
                                            engine_clone.enqueue_folder_created(path.clone());
                                        }
                                    }
                                }
                            }
                            EventKind::Create(_) => {
                                for path in &debounced.event.paths {
                                    if engine_clone.watcher_suppress().is_suppressed(path) {
                                        continue;
                                    }
                                    if path.is_dir() {
                                        engine_clone.enqueue_folder_created(path.clone());
                                    } else if path.is_file() {
                                        engine_clone.enqueue_file_path(path.clone());
                                    }
                                }
                            }
                            _ => {
                                for path in &debounced.event.paths {
                                    if engine_clone.watcher_suppress().is_suppressed(path) {
                                        continue;
                                    }
                                    if path.is_file() {
                                        engine_clone.enqueue_file_path(path.clone());
                                    }
                                }
                            }
                        }
                    }
                }
            },
        )
        .map_err(|e| crate::error::AppError::msg(e.to_string()))?;

        for path in paths {
            if path.exists() {
                debouncer
                    .watch(&path, notify::RecursiveMode::Recursive)
                    .map_err(|e| crate::error::AppError::msg(e.to_string()))?;
            }
        }

        Ok(Self {
            _debouncer: debouncer,
        })
    }
}
