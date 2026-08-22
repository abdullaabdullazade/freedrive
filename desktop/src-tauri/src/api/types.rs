use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub email: String,
    pub username: String,
    pub role: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginSuccess {
    pub tokens: Tokens,
    pub user: User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Login2FA {
    pub requires_2fa: bool,
    pub challenge_id: String,
    pub email_masked: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshResponse {
    pub tokens: Tokens,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Computer {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub hostname: String,
    pub root_folder_id: String,
    #[serde(default)]
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputersResponse {
    pub computers: Vec<Computer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub is_trashed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRecord {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: i64,
    #[serde(default)]
    pub folder_id: Option<String>,
    pub updated_at: String,
    #[serde(default)]
    pub version: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderContents {
    pub folder: Option<Folder>,
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub files: Vec<FileRecord>,
    #[serde(default)]
    pub next_page_token: Option<String>,
    #[serde(default)]
    pub total_files: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesResponse {
    pub files: Vec<FileRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageInfo {
    pub used_bytes: i64,
    pub total_bytes: i64,
    #[serde(default)]
    pub free_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserShare {
    pub id: String,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedItem {
    pub share: UserShare,
    pub item_type: String,
    pub item_id: String,
    pub item_name: String,
    #[serde(default)]
    pub owner_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedWithMeResponse {
    #[serde(default)]
    pub items: Vec<SharedItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncChangePayload {
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub encrypted_size: i64,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub old_name: String,
    #[serde(default)]
    pub old_parent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncChange {
    pub seq: i64,
    pub entity_type: String,
    pub entity_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub operation: String,
    pub name: String,
    #[serde(default)]
    pub version: i32,
    pub occurred_at: String,
    #[serde(default)]
    pub payload: Option<SyncChangePayload>,
    #[serde(default)]
    pub is_tombstone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncChangesResponse {
    pub changes: Vec<SyncChange>,
    pub next_cursor: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputerSnapshot {
    pub cursor: i64,
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub files: Vec<FileRecord>,
}
