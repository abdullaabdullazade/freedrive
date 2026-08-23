use crate::error::{AppError, AppResult};
#[cfg(not(test))]
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
#[cfg(not(test))]
use rand::RngCore;
#[cfg(not(test))]
use std::sync::{LazyLock, Mutex};

const PREFIX: &str = "enc:v1:";
#[cfg(not(test))]
static DEVICE_KEY: LazyLock<Mutex<Option<[u8; 32]>>> = LazyLock::new(|| Mutex::new(None));

#[cfg(test)]
fn load_device_key() -> AppResult<[u8; 32]> {
    Ok([0x5a; 32])
}

#[cfg(not(test))]
fn load_device_key() -> AppResult<[u8; 32]> {
    if let Some(key) = *DEVICE_KEY.lock().map_err(|_| AppError::msg("device key lock poisoned"))? {
        return Ok(key);
    }
    let entry = keyring::Entry::new("com.freedrive.desktop", "database-encryption-key")
        .map_err(|e| AppError::msg(format!("keyring unavailable: {e}")))?;
    let key = match entry.get_password() {
        Ok(encoded) => {
            let bytes = BASE64_STANDARD
                .decode(encoded)
                .map_err(|_| AppError::msg("invalid database key in OS keyring"))?;
            bytes
                .try_into()
                .map_err(|_| AppError::msg("invalid database key length in OS keyring"))?
        }
        Err(keyring::Error::NoEntry) => {
            let mut generated = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut generated);
            entry
                .set_password(&BASE64_STANDARD.encode(generated))
                .map_err(|e| AppError::msg(format!("could not store database key: {e}")))?;
            generated
        }
        Err(e) => return Err(AppError::msg(format!("could not read database key: {e}"))),
    };
    *DEVICE_KEY.lock().map_err(|_| AppError::msg("device key lock poisoned"))? = Some(key);
    Ok(key)
}

pub fn protect(value: &str) -> AppResult<String> {
    let key = load_device_key()?;
    let wrapped = crate::crypto::wrap_bytes(value.as_bytes(), &key)?;
    Ok(format!("{PREFIX}{wrapped}"))
}

/// Returns the plaintext and whether the stored value used the legacy plaintext format.
pub fn unprotect(value: &str) -> AppResult<(String, bool)> {
    let Some(wrapped) = value.strip_prefix(PREFIX) else {
        return Ok((value.to_owned(), true));
    };
    let key = load_device_key()?;
    let plaintext = crate::crypto::unwrap_bytes(wrapped, &key)?;
    String::from_utf8(plaintext)
        .map(|value| (value, false))
        .map_err(|_| AppError::msg("encrypted database value is not UTF-8"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn protects_and_unprotects_values() {
        let encrypted = super::protect("secret-key").unwrap();
        assert!(encrypted.starts_with("enc:v1:"));
        assert!(!encrypted.contains("secret-key"));
        assert_eq!(super::unprotect(&encrypted).unwrap(), ("secret-key".into(), false));
        assert_eq!(super::unprotect("legacy").unwrap(), ("legacy".into(), true));
    }
}
