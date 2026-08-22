use crate::db::{config_get, config_set, DbHandle};
use crate::error::{AppError, AppResult};
use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use std::path::Path;

const SETTINGS_KEY: &str = "desktop_sync_settings_v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DesktopSyncSettings {
    #[serde(default)]
    pub proxy_url: String,
    #[serde(default)]
    pub upload_limit_kbps: u64,
    #[serde(default)]
    pub download_limit_kbps: u64,
    #[serde(default)]
    pub excluded_patterns: Vec<String>,
    #[serde(default)]
    pub excluded_remote_folder_ids: Vec<String>,
}

impl DesktopSyncSettings {
    pub fn validate(&mut self) -> AppResult<()> {
        self.proxy_url = self.proxy_url.trim().to_string();
        if !self.proxy_url.is_empty() {
            let parsed = reqwest::Url::parse(&self.proxy_url)
                .map_err(|e| AppError::msg(format!("invalid proxy URL: {e}")))?;
            if !matches!(parsed.scheme(), "http" | "https" | "socks5") {
                return Err(AppError::msg("proxy URL must use http, https, or socks5"));
            }
        }
        const MAX_KBPS: u64 = 10 * 1024 * 1024;
        if self.upload_limit_kbps > MAX_KBPS || self.download_limit_kbps > MAX_KBPS {
            return Err(AppError::msg("bandwidth limit is too large"));
        }
        self.excluded_patterns = normalize_list(&self.excluded_patterns, 100)?;
        self.excluded_remote_folder_ids = normalize_list(&self.excluded_remote_folder_ids, 500)?;
        let _ = build_glob_set(&self.excluded_patterns)?;
        Ok(())
    }

    pub fn excludes_path(&self, root: &Path, path: &Path) -> bool {
        if self.excluded_patterns.is_empty() {
            return false;
        }
        let relative = path.strip_prefix(root).unwrap_or(path);
        build_glob_set(&self.excluded_patterns)
            .map(|set| set.is_match(relative) || set.is_match(path))
            .unwrap_or(false)
    }
}

fn normalize_list(values: &[String], max: usize) -> AppResult<Vec<String>> {
    let mut normalized = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() || normalized.iter().any(|item| item == value) {
            continue;
        }
        if normalized.len() >= max {
            return Err(AppError::msg(format!("at most {max} entries are allowed")));
        }
        normalized.push(value.to_string());
    }
    Ok(normalized)
}

fn build_glob_set(patterns: &[String]) -> AppResult<GlobSet> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(
            Glob::new(pattern)
                .map_err(|e| AppError::msg(format!("invalid exclusion pattern {pattern:?}: {e}")))?,
        );
    }
    builder.build().map_err(|e| AppError::msg(e.to_string()))
}

pub fn load(db: &DbHandle) -> AppResult<DesktopSyncSettings> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    let Some(raw) = config_get(&conn, SETTINGS_KEY)? else {
        return Ok(DesktopSyncSettings::default());
    };
    let (decoded, legacy) = crate::secret_storage::unprotect(&raw)?;
    let settings = serde_json::from_str(&decoded).map_err(AppError::from)?;
    if legacy {
        config_set(&conn, SETTINGS_KEY, &crate::secret_storage::protect(&decoded)?)?;
    }
    Ok(settings)
}

pub fn save(db: &DbHandle, mut settings: DesktopSyncSettings) -> AppResult<DesktopSyncSettings> {
    settings.validate()?;
    let encoded = crate::secret_storage::protect(&serde_json::to_string(&settings)?)?;
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    config_set(&conn, SETTINGS_KEY, &encoded)?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusion_globs_match_relative_paths() {
        let settings = DesktopSyncSettings {
            excluded_patterns: vec!["**/*.tmp".into(), "private/**".into()],
            ..Default::default()
        };
        let root = Path::new("/sync");
        assert!(settings.excludes_path(root, Path::new("/sync/private/a.txt")));
        assert!(settings.excludes_path(root, Path::new("/sync/cache/a.tmp")));
        assert!(!settings.excludes_path(root, Path::new("/sync/docs/a.txt")));
    }

    #[test]
    fn settings_reject_unsupported_proxy_scheme() {
        let mut settings = DesktopSyncSettings {
            proxy_url: "file:///tmp/socket".into(),
            ..Default::default()
        };
        assert!(settings.validate().is_err());
    }
}
