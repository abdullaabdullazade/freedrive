mod cleanup;
mod provider;
#[cfg(windows)]
mod sync;

pub use cleanup::{clear_my_drive_contents, uninstall_remove_app_data, uninstall_remove_my_drive};

pub use provider::{
    api_folder_parent_id, clear_all_hydrate_cache, clear_hydrate_cache_for_file,
    ensure_hydrated_plaintext, fetch_folder_contents, is_under_my_drive,
    relative_path_from_sync_root, resolve_folder_id_for_fetch, resolve_my_drive_root_id,
    FolderIdSource, ROOT_FOLDER_CONFIG_KEY,
};

#[cfg(windows)]
pub use sync::{
    delete_my_drive_path, ensure_my_drive_folder_path, poll_my_drive, upload_my_drive_path,
    MyDriveBusyCb, MyDrivePollStats,
};

#[cfg(not(windows))]
pub use sync_stub::{MyDriveBusyCb, MyDrivePollStats};

#[cfg(not(windows))]
mod sync_stub {
    use std::sync::Arc;

    pub type MyDriveBusyCb = Arc<dyn Fn(&str) + Send + Sync>;

    #[derive(Debug, Default, Clone)]
    pub struct MyDrivePollStats {
        pub folders_created: u32,
        pub files_uploaded: u32,
        pub files_mirrored: u32,
        pub errors: u32,
    }

    impl MyDrivePollStats {
        pub fn did_work(&self) -> bool {
            false
        }
    }
}

#[cfg(not(windows))]
pub async fn poll_my_drive(
    _api: &crate::api::ApiClient,
    _db: &crate::db::DbHandle,
    _mirror: bool,
    _download_sem: std::sync::Arc<tokio::sync::Semaphore>,
    _upload_sem: std::sync::Arc<tokio::sync::Semaphore>,
    _suppress: Option<&crate::sync::suppress::WatcherSuppress>,
    _on_busy: Option<MyDriveBusyCb>,
) -> crate::error::AppResult<MyDrivePollStats> {
    Ok(MyDrivePollStats::default())
}

#[cfg(not(windows))]
pub async fn upload_my_drive_path(
    _api: &crate::api::ApiClient,
    _db: &crate::db::DbHandle,
    _path: &std::path::Path,
) -> crate::error::AppResult<()> {
    Ok(())
}

#[cfg(not(windows))]
pub async fn delete_my_drive_path(
    _api: &crate::api::ApiClient,
    _db: &crate::db::DbHandle,
    _path: &std::path::Path,
) -> crate::error::AppResult<()> {
    Ok(())
}

#[cfg(not(windows))]
pub async fn ensure_my_drive_folder_path(
    _api: &crate::api::ApiClient,
    _db: &crate::db::DbHandle,
    _path: &std::path::Path,
) -> crate::error::AppResult<String> {
    Ok(String::new())
}
