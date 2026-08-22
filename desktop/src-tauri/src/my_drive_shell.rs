//! Explorer context-menu CLI args (`--my-drive-hydrate` / `--my-drive-free-space`).
//!
//! Second instances hand off via single-instance WM_COPYDATA *and* a pending JSONL
//! queue, because WM_COPYDATA is unreliable when Explorer launches the exe.

use crate::auth_store::data_dir;
use crate::state::AppState;
use crate::sync::log::sync_log;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone)]
pub enum MyDriveShellAction {
    Hydrate(PathBuf),
    FreeSpace(PathBuf),
}

impl MyDriveShellAction {
    fn kind(&self) -> &'static str {
        match self {
            MyDriveShellAction::Hydrate(_) => "hydrate",
            MyDriveShellAction::FreeSpace(_) => "free-space",
        }
    }

    fn path(&self) -> &Path {
        match self {
            MyDriveShellAction::Hydrate(p) | MyDriveShellAction::FreeSpace(p) => p,
        }
    }

    fn same_as(&self, other: &MyDriveShellAction) -> bool {
        self.kind() == other.kind() && self.path() == other.path()
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PendingShellAction {
    action: String,
    path: String,
}

fn pending_queue_path() -> Option<PathBuf> {
    data_dir().ok().map(|d| d.join("pending-shell-actions.jsonl"))
}

fn legacy_pending_path() -> Option<PathBuf> {
    data_dir().ok().map(|d| d.join("pending-shell-action.json"))
}

/// Raw argv bootstrap log — proves Explorer started the exe (no Tauri / sync_log).
pub fn append_shell_invoke_log() {
    let Ok(dir) = data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("shell-invoke.log");
    let args: Vec<String> = std::env::args().collect();
    let line = format!(
        "[{}] {}\n",
        chrono::Local::now().to_rfc3339(),
        args.join(" ")
    );
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Append one action to the JSONL queue (safe for multi-select / concurrent launches).
pub fn write_pending_shell_action(action: &MyDriveShellAction) {
    let Some(path) = pending_queue_path() else {
        sync_log("My Drive shell: cannot resolve data dir for pending action");
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = PendingShellAction {
        action: action.kind().to_string(),
        path: action.path().to_string_lossy().to_string(),
    };
    let Ok(line) = serde_json::to_string(&payload) else {
        sync_log("My Drive shell pending serialize failed");
        return;
    };
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(mut f) => {
            if let Err(e) = writeln!(f, "{}", line) {
                sync_log(format!("My Drive shell pending write failed: {}", e));
            } else {
                sync_log(format!(
                    "My Drive shell pending written — {} {}",
                    action.kind(),
                    action.path().display()
                ));
            }
        }
        Err(e) => sync_log(format!("My Drive shell pending open failed: {}", e)),
    }
}

fn parse_pending_line(line: &str) -> Option<MyDriveShellAction> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let parsed: PendingShellAction = match serde_json::from_str(line) {
        Ok(p) => p,
        Err(e) => {
            sync_log(format!("My Drive shell pending parse failed: {}", e));
            return None;
        }
    };
    let path_buf = PathBuf::from(&parsed.path);
    match parsed.action.as_str() {
        "hydrate" => Some(MyDriveShellAction::Hydrate(path_buf)),
        "free-space" => Some(MyDriveShellAction::FreeSpace(path_buf)),
        other => {
            sync_log(format!("My Drive shell pending unknown action: {}", other));
            None
        }
    }
}

/// Take all queued actions (JSONL + legacy single JSON file).
pub fn take_pending_shell_actions() -> Vec<MyDriveShellAction> {
    let mut out = Vec::new();

    if let Some(legacy) = legacy_pending_path() {
        if let Ok(json) = std::fs::read_to_string(&legacy) {
            let _ = std::fs::remove_file(&legacy);
            if let Some(action) = parse_pending_line(json.lines().next().unwrap_or(&json)) {
                out.push(action);
            }
        }
    }

    let Some(path) = pending_queue_path() else {
        return out;
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return out;
    };
    let _ = std::fs::remove_file(&path);
    for line in contents.lines() {
        if let Some(action) = parse_pending_line(line) {
            // Dedupe identical consecutive / duplicate multi-select entries.
            if out.iter().any(|a| a.same_as(&action)) {
                continue;
            }
            out.push(action);
        }
    }
    out
}

pub fn take_pending_shell_action() -> Option<MyDriveShellAction> {
    let mut all = take_pending_shell_actions();
    if all.is_empty() {
        None
    } else {
        let first = all.remove(0);
        // Re-queue the rest so poller can drain them.
        for action in all {
            write_pending_shell_action(&action);
        }
        Some(first)
    }
}

pub fn parse_my_drive_shell_args(args: &[String]) -> Option<MyDriveShellAction> {
    let mut i = 0usize;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "--my-drive-hydrate" {
            let path = args.get(i + 1)?;
            return Some(MyDriveShellAction::Hydrate(PathBuf::from(path)));
        }
        if a == "--my-drive-free-space" {
            let path = args.get(i + 1)?;
            return Some(MyDriveShellAction::FreeSpace(PathBuf::from(path)));
        }
        if let Some(path) = a.strip_prefix("--my-drive-hydrate=") {
            return Some(MyDriveShellAction::Hydrate(PathBuf::from(path)));
        }
        if let Some(path) = a.strip_prefix("--my-drive-free-space=") {
            return Some(MyDriveShellAction::FreeSpace(PathBuf::from(path)));
        }
        i += 1;
    }
    None
}

fn args_look_like_shell(args: &[String]) -> bool {
    args.iter().any(|a| {
        a.contains("my-drive-hydrate") || a.contains("my-drive-free-space")
    })
}

/// Run hydrate / free-up on the sync engine (no-op if not logged in / engine missing).
pub fn dispatch_my_drive_shell_action(app: &AppHandle, action: MyDriveShellAction) {
    let Some(state) = app.try_state::<AppState>() else {
        sync_log("My Drive shell action: AppState missing");
        return;
    };
    let Ok(engine) = state.sync_engine() else {
        sync_log("My Drive shell action: sync engine not ready (sign in first)");
        return;
    };

    tauri::async_runtime::spawn(async move {
        let label = match &action {
            MyDriveShellAction::Hydrate(path) => {
                sync_log(format!("My Drive shell hydrate — {}", path.display()));
                format!("hydrate {}", path.display())
            }
            MyDriveShellAction::FreeSpace(path) => {
                sync_log(format!("My Drive shell free-space — {}", path.display()));
                format!("free-space {}", path.display())
            }
        };
        let result = match &action {
            MyDriveShellAction::Hydrate(path) => engine.hydrate_my_drive_path(path).await,
            MyDriveShellAction::FreeSpace(path) => engine.free_up_my_drive_path(path).await,
        };
        match result {
            Ok(true) => sync_log(format!("My Drive shell {} ok", label)),
            Ok(false) => sync_log(format!("My Drive shell {} skipped", label)),
            Err(e) => sync_log(format!("My Drive shell action failed: {}", e)),
        }
    });
}

pub fn dispatch_my_drive_shell_args(app: &AppHandle, args: &[String]) {
    match parse_my_drive_shell_args(args) {
        Some(action) => dispatch_my_drive_shell_action(app, action),
        None if args_look_like_shell(args) => {
            sync_log(format!(
                "My Drive shell args not recognized: {:?}",
                args
            ));
        }
        None => {}
    }
}

/// Handle second-instance handoff: log argv, dispatch from args + all pending queue items.
pub fn handle_single_instance_shell(app: &AppHandle, args: &[String]) -> bool {
    sync_log(format!("My Drive shell single-instance args: {:?}", args));
    let from_args = parse_my_drive_shell_args(args);
    let mut pending = take_pending_shell_actions();

    let mut dispatched = false;
    if let Some(a) = from_args {
        pending.retain(|p| !p.same_as(&a));
        dispatch_my_drive_shell_action(app, a);
        dispatched = true;
    }
    for action in pending {
        dispatch_my_drive_shell_action(app, action);
        dispatched = true;
    }

    if !dispatched && args_look_like_shell(args) {
        sync_log(format!(
            "My Drive shell args not recognized: {:?}",
            args
        ));
    }
    dispatched
}

/// Drain pending queue if present (cold start / poll).
pub fn dispatch_pending_shell_action(app: &AppHandle) {
    for action in take_pending_shell_actions() {
        dispatch_my_drive_shell_action(app, action);
    }
}

/// Poll pending-shell-actions.jsonl while logged in.
pub fn spawn_pending_shell_poller(app: &AppHandle) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        loop {
            interval.tick().await;
            if app_handle.try_state::<AppState>().is_none() {
                continue;
            }
            dispatch_pending_shell_action(&app_handle);
        }
    });
}
