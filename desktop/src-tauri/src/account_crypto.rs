use crate::api::ApiClient;
use crate::crypto::{self, format_recovery_code, generate_file_key, key_from_b64url, key_to_b64url};
use crate::db::{
    config_get, config_set, delete_pending_key_upload, list_all_file_keys,
    list_pending_key_uploads, store_file_key, DbHandle,
};
use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use rand::RngCore;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::Deserialize;
use serde::de::{self, Visitor};
use std::collections::HashMap;
use std::fmt;
use std::sync::LazyLock;

static UEK: LazyLock<Mutex<Option<[u8; 32]>>> = LazyLock::new(|| Mutex::new(None));

fn decode_key_salt_base64(value: &str) -> AppResult<Vec<u8>> {
    BASE64_STANDARD
        .decode(value.trim())
        .map_err(|e| AppError::msg(format!("invalid key_salt base64: {}", e)))
}

fn deserialize_key_salt<'de, D>(deserializer: D) -> Result<Option<Vec<u8>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct KeySaltVisitor;

    impl<'de> Visitor<'de> for KeySaltVisitor {
        type Value = Option<Vec<u8>>;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("base64 string, byte array, or null")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            decode_key_salt_base64(value)
                .map(Some)
                .map_err(de::Error::custom)
        }

        fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            self.visit_str(&value)
        }

        fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
        where
            A: de::SeqAccess<'de>,
        {
            let mut bytes = Vec::new();
            while let Some(byte) = seq.next_element()? {
                bytes.push(byte);
            }
            Ok(Some(bytes))
        }
    }

    deserializer.deserialize_any(KeySaltVisitor)
}

#[derive(Debug, Deserialize)]
struct CryptoAccountResponse {
    has_crypto: bool,
    has_recovery: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_key_salt")]
    key_salt: Option<Vec<u8>>,
    wrapped_uek: Option<String>,
    wrapped_uek_recovery: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EncryptionKeyEntry {
    file_id: String,
    wrapped_file_key: String,
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EncryptionKeysListResponse {
    keys: Vec<EncryptionKeyEntry>,
}

#[derive(Debug, Deserialize)]
struct FileEncryptionKeyResponse {
    wrapped_file_key: String,
}

#[derive(Debug, Deserialize)]
struct BulkImportResponse {
    imported: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CryptoSyncStats {
    pub pulled: usize,
    pub pushed: usize,
    pub pending_flushed: usize,
}

fn keyring_service() -> &'static str {
    "freedrive-desktop"
}

fn keyring_user(user_id: &str) -> String {
    format!("uek_{user_id}")
}

pub fn set_uek(user_id: &str, uek: [u8; 32]) -> AppResult<()> {
    *UEK.lock() = Some(uek);
    save_uek_keyring(user_id, &uek)?;
    Ok(())
}

pub fn get_uek(user_id: &str) -> Option<[u8; 32]> {
    if let Some(uek) = *UEK.lock() {
        return Some(uek);
    }
    if let Ok(Some(uek)) = load_uek_keyring(user_id) {
        *UEK.lock() = Some(uek);
        return Some(uek);
    }
    None
}

pub fn is_unlocked() -> bool {
    UEK.lock().is_some()
}

pub fn clear_uek(user_id: &str) {
    *UEK.lock() = None;
    let _ = keyring::Entry::new(keyring_service(), &keyring_user(user_id))
        .and_then(|e| e.delete_credential());
}

fn save_uek_keyring(user_id: &str, uek: &[u8; 32]) -> AppResult<()> {
    let entry = keyring::Entry::new(keyring_service(), &keyring_user(user_id))
        .map_err(|e| AppError::msg(e.to_string()))?;
    entry
        .set_password(&hex::encode(uek))
        .map_err(|e| AppError::msg(e.to_string()))
}

fn load_uek_keyring(user_id: &str) -> AppResult<Option<[u8; 32]>> {
    let entry = keyring::Entry::new(keyring_service(), &keyring_user(user_id))
        .map_err(|e| AppError::msg(e.to_string()))?;
    match entry.get_password() {
        Ok(hex_str) => {
            let bytes = hex::decode(hex_str).map_err(|e| AppError::msg(e.to_string()))?;
            if bytes.len() != 32 {
                return Err(AppError::msg("invalid keyring UEK length"));
            }
            let mut uek = [0u8; 32];
            uek.copy_from_slice(&bytes);
            Ok(Some(uek))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::msg(e.to_string())),
    }
}

pub struct UnlockResult {
    pub setup: bool,
    pub recovery_code: Option<String>,
    pub sync_stats: CryptoSyncStats,
}

async fn server_has_orphaned_file_keys(client: &ApiClient) -> AppResult<bool> {
    let resp: EncryptionKeysListResponse =
        serde_json::from_value(client.list_encryption_keys("").await?)?;
    Ok(!resp.keys.is_empty())
}

pub async fn unlock_after_login(
    client: &ApiClient,
    db: &DbHandle,
    user_id: &str,
    password: &str,
) -> AppResult<UnlockResult> {
    let account: CryptoAccountResponse =
        serde_json::from_value(client.get_crypto_account().await?)?;
    if !account.has_crypto {
        if server_has_orphaned_file_keys(client).await? {
            return Err(AppError::msg(
                "server encryption account missing but file keys remain — recovery code required",
            ));
        }
        let uek = generate_file_key();
        let recovery_key = generate_file_key();
        let mut salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt);
        let kek = crypto::derive_kek(password, &salt)?;
        let wrapped_uek = crypto::wrap_bytes(&uek, &kek)?;
        let wrapped_recovery = crypto::wrap_bytes(&uek, &recovery_key)?;
        client
            .setup_crypto_account(&salt, &wrapped_uek, Some(&wrapped_recovery))
            .await?;
        set_uek(user_id, uek)?;
        let sync_stats = sync_all_keys(client, db, user_id, &uek).await?;
        return Ok(UnlockResult {
            setup: true,
            recovery_code: Some(format_recovery_code(&recovery_key)),
            sync_stats,
        });
    }

    let salt = account
        .key_salt
        .ok_or_else(|| AppError::msg("missing key salt"))?;
    let wrapped = account
        .wrapped_uek
        .ok_or_else(|| AppError::msg("missing wrapped UEK"))?;
    let kek = crypto::derive_kek(password, &salt)?;
    let uek_bytes = crypto::unwrap_bytes(&wrapped, &kek)?;
    if uek_bytes.len() != 32 {
        return Err(AppError::msg("invalid UEK length"));
    }
    let mut uek = [0u8; 32];
    uek.copy_from_slice(&uek_bytes);
    set_uek(user_id, uek)?;
    let sync_stats = sync_all_keys(client, db, user_id, &uek).await?;
    Ok(UnlockResult {
        setup: false,
        recovery_code: None,
        sync_stats,
    })
}

pub async fn unlock_with_recovery(
    client: &ApiClient,
    db: &DbHandle,
    user_id: &str,
    recovery_code: &str,
) -> AppResult<CryptoSyncStats> {
    let account: CryptoAccountResponse =
        serde_json::from_value(client.get_crypto_account().await?)?;
    if !account.has_crypto || account.wrapped_uek_recovery.is_none() {
        return Err(AppError::msg("No recovery backup on server"));
    }
    let recovery_key = crypto::parse_recovery_code(recovery_code)?;
    let uek_bytes = crypto::unwrap_bytes(
        account.wrapped_uek_recovery.as_ref().unwrap(),
        &recovery_key,
    )?;
    if uek_bytes.len() != 32 {
        return Err(AppError::msg("invalid UEK length"));
    }
    let mut uek = [0u8; 32];
    uek.copy_from_slice(&uek_bytes);
    set_uek(user_id, uek)?;
    sync_all_keys(client, db, user_id, &uek).await
}

pub async fn ensure_unlocked_from_keyring(
    client: &ApiClient,
    db: &DbHandle,
    user_id: &str,
) -> AppResult<Option<CryptoSyncStats>> {
    let Some(uek) = get_uek(user_id) else {
        return Ok(None);
    };
    let stats = sync_all_keys(client, db, user_id, &uek).await?;
    Ok(Some(stats))
}

pub fn queue_key_upload(db: &DbHandle, file_id: &str, key_b64: &str) -> AppResult<()> {
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    crate::db::store_pending_key_upload(&conn, file_id, key_b64)
}

pub async fn push_file_key_or_queue(
    client: &ApiClient,
    db: &DbHandle,
    user_id: &str,
    file_id: &str,
    key_b64: &str,
) -> AppResult<bool> {
    if let Some(uek) = get_uek(user_id) {
        push_file_key(client, &uek, file_id, key_b64).await?;
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        let _ = delete_pending_key_upload(&conn, file_id);
        return Ok(true);
    }
    queue_key_upload(db, file_id, key_b64)?;
    Ok(false)
}

async fn flush_pending_key_uploads(
    client: &ApiClient,
    db: &DbHandle,
    uek: &[u8; 32],
) -> AppResult<usize> {
    let pending = {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        list_pending_key_uploads(&conn)?
    };
    let mut flushed = 0usize;
    for (file_id, key_b64) in pending {
        if push_file_key(client, uek, &file_id, &key_b64).await.is_ok() {
            let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            let _ = delete_pending_key_upload(&conn, &file_id);
            flushed += 1;
        }
    }
    Ok(flushed)
}

async fn sync_all_keys(
    client: &ApiClient,
    db: &DbHandle,
    user_id: &str,
    uek: &[u8; 32],
) -> AppResult<CryptoSyncStats> {
    let pulled = pull_keys_from_server(client, db, uek).await?;
    let pushed = push_local_keys_to_server(client, db, uek).await?;
    let pulled2 = pull_keys_from_server(client, db, uek).await?;
    let pending_flushed = flush_pending_key_uploads(client, db, uek).await?;
    let _ = user_id;
    Ok(CryptoSyncStats {
        pulled: pulled + pulled2,
        pushed,
        pending_flushed,
    })
}

async fn pull_keys_from_server(
    client: &ApiClient,
    db: &DbHandle,
    uek: &[u8; 32],
) -> AppResult<usize> {
    let since = {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        config_get(&conn, "crypto_sync_since").ok().flatten()
    };
    let mut cursor = since.unwrap_or_default();
    let mut imported = 0usize;
    loop {
        let resp: EncryptionKeysListResponse =
            serde_json::from_value(client.list_encryption_keys(&cursor).await?)?;
        if resp.keys.is_empty() {
            break;
        }
        let count = resp.keys.len();
        {
            let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            for entry in &resp.keys {
                if let Ok(raw) = crypto::unwrap_bytes(&entry.wrapped_file_key, uek) {
                    if raw.len() == 32 {
                        let mut key = [0u8; 32];
                        key.copy_from_slice(&raw);
                        let _ = store_file_key(&conn, &entry.file_id, &key_to_b64url(&key));
                        imported += 1;
                    }
                }
                if let Some(ref ts) = entry.updated_at {
                    cursor = ts.clone();
                }
            }
            if !cursor.is_empty() {
                let _ = config_set(&conn, "crypto_sync_since", &cursor);
            }
        }
        if count < 5000 {
            break;
        }
    }
    Ok(imported)
}

async fn push_local_keys_to_server(
    client: &ApiClient,
    db: &DbHandle,
    uek: &[u8; 32],
) -> AppResult<usize> {
    let local_keys = {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        list_all_file_keys(&conn)?
    };
    if local_keys.is_empty() {
        return Ok(0);
    }
    let mut wrapped = HashMap::new();
    for (file_id, key_b64) in local_keys {
        if let Ok(key) = key_from_b64url(&key_b64) {
            if let Ok(w) = crypto::wrap_bytes(&key, uek) {
                wrapped.insert(file_id, w);
            }
        }
    }
    if wrapped.is_empty() {
        return Ok(0);
    }
    let resp: BulkImportResponse =
        serde_json::from_value(client.bulk_put_encryption_keys(wrapped).await?)?;
    Ok(resp.imported)
}

pub async fn push_file_key(
    client: &ApiClient,
    uek: &[u8; 32],
    file_id: &str,
    key_b64: &str,
) -> AppResult<()> {
    let key = key_from_b64url(key_b64)?;
    let wrapped = crypto::wrap_bytes(&key, uek)?;
    client.put_file_encryption_key(file_id, &wrapped).await
}

pub async fn fetch_and_store_file_key(
    client: &ApiClient,
    db: &DbHandle,
    uek: &[u8; 32],
    file_id: &str,
) -> AppResult<Option<String>> {
    let resp: FileEncryptionKeyResponse = match client.get_file_encryption_key(file_id).await {
        Ok(raw) => serde_json::from_value(raw).map_err(AppError::from)?,
        Err(e) if e.to_string().to_lowercase().contains("not found") => return Ok(None),
        Err(e) => return Err(e),
    };
    let raw = crypto::unwrap_bytes(&resp.wrapped_file_key, uek)?;
    if raw.len() != 32 {
        return Err(AppError::msg("invalid file key length"));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&raw);
    let key_b64 = key_to_b64url(&key);
    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    store_file_key(&conn, file_id, &key_b64)?;
    Ok(Some(key_b64))
}

pub async fn rotate_account_key(
    client: &ApiClient,
    db: &DbHandle,
    user_id: &str,
    password: &str,
) -> AppResult<String> {
    let account: CryptoAccountResponse =
        serde_json::from_value(client.get_crypto_account().await?)?;
    if !account.has_crypto {
        return Err(AppError::msg("Encryption is not set up"));
    }
    let salt_old = account
        .key_salt
        .ok_or_else(|| AppError::msg("missing key salt"))?;
    let wrapped_old = account
        .wrapped_uek
        .ok_or_else(|| AppError::msg("missing wrapped UEK"))?;
    let kek_old = crypto::derive_kek(password, &salt_old)?;
    let old_uek_bytes = crypto::unwrap_bytes(&wrapped_old, &kek_old)?;
    if old_uek_bytes.len() != 32 {
        return Err(AppError::msg("invalid UEK length"));
    }

    let new_uek = generate_file_key();
    let new_recovery = generate_file_key();
    let mut salt_new = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt_new);
    let kek_new = crypto::derive_kek(password, &salt_new)?;
    let wrapped_uek = crypto::wrap_bytes(&new_uek, &kek_new)?;
    let wrapped_recovery = crypto::wrap_bytes(&new_uek, &new_recovery)?;

    let local_keys = {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        list_all_file_keys(&conn)?
    };

    let mut rewrapped = HashMap::new();
    for (file_id, key_b64) in &local_keys {
        if let Ok(file_key) = key_from_b64url(key_b64) {
            if let Ok(w) = crypto::wrap_bytes(&file_key, &new_uek) {
                rewrapped.insert(file_id.clone(), w);
            }
        }
    }
    if !rewrapped.is_empty() {
        let _: BulkImportResponse =
            serde_json::from_value(client.bulk_put_encryption_keys(rewrapped).await?)?;
    }

    client
        .update_crypto_account(&salt_new, &wrapped_uek, Some(&wrapped_recovery))
        .await?;

    set_uek(user_id, new_uek)?;
    let _ = sync_all_keys(client, db, user_id, &new_uek).await?;
    Ok(format_recovery_code(&new_recovery))
}

pub async fn resolve_file_key(
    client: &ApiClient,
    db: &DbHandle,
    user_id: &str,
    file_id: &str,
) -> AppResult<String> {
    use crate::db::{
        config_get, get_file_key, get_pending_file_key, has_any_pending_file_key,
        my_drive_get_placeholder_by_remote_id,
    };
    use crate::my_drive::ROOT_FOLDER_CONFIG_KEY;
    use std::path::Path;

    {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        if let Some(key) = get_file_key(&conn, file_id)? {
            return Ok(key);
        }
    }

    let mut pending_file_name: Option<String> = None;
    {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        if let Some((rel_path, item_type, parent_remote_id)) =
            my_drive_get_placeholder_by_remote_id(&conn, file_id)?
        {
            if item_type == "file" {
                let file_name = Path::new(&rel_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| AppError::msg("invalid file path in placeholder"))?;
                pending_file_name = Some(file_name.to_string());
                let folder_id = parent_remote_id.unwrap_or_else(|| {
                    config_get(&conn, ROOT_FOLDER_CONFIG_KEY)
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| "root".to_string())
                });
                if let Some(key) = get_pending_file_key(&conn, &folder_id, file_name)? {
                    return Ok(key);
                }
            }
        }
    }

    if let Some(ref name) = pending_file_name {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        if has_any_pending_file_key(&conn, name)? {
            return Err(AppError::msg("file is still uploading"));
        }
    }

    if let Some(uek) = get_uek(user_id) {
        if let Some(key_b64) = fetch_and_store_file_key(client, db, &uek, file_id).await? {
            return Ok(key_b64);
        }
    }

    Err(AppError::msg(
        "encryption key not available on this device (uploaded via web?)",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crypto_account_response_parses_go_base64_key_salt() {
        let json = r#"{"has_crypto":true,"has_recovery":true,"key_salt":"dGVzdC1zYWx0LTE2Ynl0ZXM=","wrapped_uek":"abc","wrapped_uek_recovery":"def"}"#;
        let account: CryptoAccountResponse = serde_json::from_str(json).unwrap();
        assert!(account.has_crypto);
        assert_eq!(account.key_salt.unwrap(), b"test-salt-16bytes");
    }

    #[test]
    fn crypto_account_response_parses_web_byte_array_key_salt() {
        let json = r#"{"has_crypto":true,"key_salt":[116,101,115,116],"wrapped_uek":"abc"}"#;
        let account: CryptoAccountResponse = serde_json::from_str(json).unwrap();
        assert_eq!(account.key_salt.unwrap(), b"test");
    }
}
