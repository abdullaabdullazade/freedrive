use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const SERVICE: &str = "freedrive-desktop";
const SESSION_KEY: &str = "session";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StoredAuth {
    pub server_url: String,
    pub access_token: String,
    pub refresh_token: String,
    pub user_json: String,
}

pub fn load_auth() -> AppResult<Option<StoredAuth>> {
    let path = auth_file_path()?;
    // Credential Manager / Keychain / Secret Service is the source of truth.
    if let Some(auth) = load_auth_from_keyring()? {
        return Ok(Some(auth));
    }

    // One-time migration from the legacy plaintext auth.json file.
    if path.exists() {
        let raw = fs::read_to_string(&path)?;
        if raw.trim().is_empty() {
            let _ = fs::remove_file(&path);
            return Ok(None);
        }
        let auth: StoredAuth = serde_json::from_str(&raw)?;
        save_auth(&auth)?;
        let _ = fs::remove_file(&path);
        return Ok(Some(auth));
    }

    Ok(None)
}

pub fn save_auth(auth: &StoredAuth) -> AppResult<()> {
    let path = auth_file_path()?;
    let trimmed = StoredAuth {
        server_url: auth.server_url.clone(),
        access_token: auth.access_token.clone(),
        refresh_token: auth.refresh_token.clone(),
        user_json: trim_user_json(&auth.user_json),
    };
    let json = serde_json::to_string(&trimmed)?;
    let entry = keyring::Entry::new(SERVICE, SESSION_KEY)
        .map_err(|e| AppError::msg(format!("cannot open secure credential store: {e}")))?;
    entry
        .set_password(&json)
        .map_err(|e| AppError::msg(format!("cannot save session securely: {e}")))?;
    // Never retain the old plaintext session after a successful secure write.
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}

pub fn clear_auth() -> AppResult<()> {
    let path = auth_file_path()?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| AppError::msg(format!("failed to remove auth session: {}", e)))?;
    }
    clear_keyring()?;
    Ok(())
}

/// Stable per-install device ID used for session deduplication on the server.
/// Survives logout (stored separately from auth.json).
pub fn device_id() -> AppResult<String> {
    let path = data_dir()?.join("device_id");
    if path.exists() {
        let existing = fs::read_to_string(&path)?.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    fs::write(&path, &id)?;
    Ok(id)
}

fn auth_file_path() -> AppResult<PathBuf> {
    Ok(data_dir()?.join("auth.json"))
}

fn trim_user_json(user_json: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(user_json) else {
        return user_json.chars().take(2048).collect();
    };
    if let Some(obj) = value.as_object_mut() {
        obj.remove("avatar_url");
    }
    value.to_string()
}

fn load_auth_from_keyring() -> AppResult<Option<StoredAuth>> {
    if let Some(raw) = read_keyring_entry(SESSION_KEY)? {
        let auth = serde_json::from_str(&raw)
            .map_err(|e| AppError::msg(format!("invalid secure session: {e}")))?;
        return Ok(Some(auth));
    }

    // Migrate the original four-entry Credential Manager layout.
    let server_url = read_keyring_entry("server_url")?;
    let access_token = read_keyring_entry("access_token")?;
    let refresh_token = read_keyring_entry("refresh_token")?;
    let user_json = read_keyring_entry("user_json")?;

    match (server_url, access_token, refresh_token) {
        (Some(url), Some(at), Some(rt)) => {
            let auth = StoredAuth {
                server_url: url,
                access_token: at,
                refresh_token: rt,
                user_json: user_json.unwrap_or_else(|| "{}".into()),
            };
            save_auth(&auth)?;
            for key in ["server_url", "access_token", "refresh_token", "user_json"] {
                if let Ok(entry) = keyring::Entry::new(SERVICE, key) {
                    let _ = entry.delete_credential();
                }
            }
            Ok(Some(auth))
        }
        _ => Ok(None),
    }
}

fn read_keyring_entry(key: &str) -> AppResult<Option<String>> {
    let entry = match keyring::Entry::new(SERVICE, key) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Ok(None),
    }
}

fn clear_keyring() -> AppResult<()> {
    for key in [
        SESSION_KEY,
        "server_url",
        "access_token",
        "refresh_token",
        "user_json",
    ] {
        if let Ok(entry) = keyring::Entry::new(SERVICE, key) {
            let _ = entry.delete_credential();
        }
    }
    Ok(())
}

pub fn data_dir() -> AppResult<PathBuf> {
    let dir = dirs::data_dir()
        .ok_or_else(|| AppError::msg("cannot resolve app data directory"))?
        .join("FreeDrive");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn mirror_dir() -> AppResult<PathBuf> {
    sync_root_dir(true)
}

/// Sync root path for CfAPI. When `create` is false, avoids touching the path
/// (required while the folder is a registered cloud sync root without a provider).
pub fn sync_root_dir(create: bool) -> AppResult<PathBuf> {
    let dir = dirs::home_dir()
        .ok_or_else(|| AppError::msg("cannot resolve home directory"))?
        .join("FreeDrive");
    if create {
        fs::create_dir_all(&dir)?;
    }
    Ok(dir)
}

pub fn my_drive_dir() -> AppResult<PathBuf> {
    my_drive_path(true)
}

pub fn my_drive_path(create: bool) -> AppResult<PathBuf> {
    let dir = sync_root_dir(create)?.join("My Drive");
    if create {
        fs::create_dir_all(&dir)?;
    }
    Ok(dir)
}
