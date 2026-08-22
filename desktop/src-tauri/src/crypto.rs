use crate::error::{AppError, AppResult};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;

pub fn generate_file_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    key
}

pub fn encrypt_file(plaintext: &[u8], key: &[u8; 32]) -> AppResult<(Vec<u8>, [u8; 12])> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| AppError::msg(e.to_string()))?;
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&iv), plaintext)
        .map_err(|e| AppError::msg(format!("encrypt failed: {}", e)))?;
    Ok((ciphertext, iv))
}

pub fn decrypt_file(ciphertext: &[u8], key: &[u8; 32], iv: &[u8]) -> AppResult<Vec<u8>> {
    if iv.len() != 12 {
        return Err(AppError::msg("invalid IV length"));
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| AppError::msg(e.to_string()))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(iv), ciphertext)
        .map_err(|e| AppError::msg(format!("decrypt failed: {}", e)))?;
    Ok(plaintext)
}

pub fn key_to_b64url(key: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(key)
}

pub fn key_from_b64url(s: &str) -> AppResult<[u8; 32]> {
    let bytes = URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| AppError::msg(format!("invalid key encoding: {}", e)))?;
    if bytes.len() != 32 {
        return Err(AppError::msg("invalid key length"));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

pub fn iv_to_base64(iv: &[u8; 12]) -> String {
    use base64::engine::general_purpose::STANDARD;
    STANDARD.encode(iv)
}

pub fn iv_from_base64(s: &str) -> AppResult<[u8; 12]> {
    use base64::engine::general_purpose::STANDARD;
    let bytes = STANDARD
        .decode(s.trim())
        .map_err(|e| AppError::msg(format!("invalid IV encoding: {}", e)))?;
    if bytes.len() != 12 {
        return Err(AppError::msg("invalid IV length"));
    }
    let mut iv = [0u8; 12];
    iv.copy_from_slice(&bytes);
    Ok(iv)
}

pub const PBKDF2_ITERATIONS: u32 = 310_000;

pub fn derive_kek(password: &str, salt: &[u8]) -> AppResult<[u8; 32]> {
    use pbkdf2::pbkdf2_hmac_array;
    use sha2::Sha256;
    Ok(pbkdf2_hmac_array::<Sha256, 32>(password.as_bytes(), salt, PBKDF2_ITERATIONS))
}

pub fn wrap_bytes(plaintext: &[u8], key: &[u8; 32]) -> AppResult<String> {
    let (ciphertext, iv) = encrypt_file(plaintext, key)?;
    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&iv);
    combined.extend_from_slice(&ciphertext);
    Ok(URL_SAFE_NO_PAD.encode(combined))
}

pub fn unwrap_bytes(wrapped_b64: &str, key: &[u8; 32]) -> AppResult<Vec<u8>> {
    let combined = URL_SAFE_NO_PAD
        .decode(wrapped_b64)
        .map_err(|e| AppError::msg(format!("invalid wrapped key: {}", e)))?;
    if combined.len() < 13 {
        return Err(AppError::msg("invalid wrapped key length"));
    }
    let mut iv = [0u8; 12];
    iv.copy_from_slice(&combined[..12]);
    decrypt_file(&combined[12..], key, &iv)
}

pub fn format_recovery_code(raw: &[u8; 32]) -> String {
    raw.iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>()
        .as_bytes()
        .chunks(8)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-")
}

pub fn parse_recovery_code(code: &str) -> AppResult<[u8; 32]> {
    let hex: String = code.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 64 {
        return Err(AppError::msg("invalid recovery code format"));
    }
    let bytes = hex::decode(hex).map_err(|e| AppError::msg(e.to_string()))?;
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = generate_file_key();
        let plaintext = b"hello freedrive desktop sync";
        let (ciphertext, iv) = encrypt_file(plaintext, &key).unwrap();
        assert_ne!(ciphertext, plaintext);
        let decrypted = decrypt_file(&ciphertext, &key, &iv).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn key_b64url_roundtrip() {
        let key = generate_file_key();
        let encoded = key_to_b64url(&key);
        let decoded = key_from_b64url(&encoded).unwrap();
        assert_eq!(decoded, key);
    }

    #[test]
    fn wrap_unwrap_roundtrip() {
        let key = generate_file_key();
        let wrapping = generate_file_key();
        let wrapped = wrap_bytes(&key, &wrapping).unwrap();
        let unwrapped = unwrap_bytes(&wrapped, &wrapping).unwrap();
        assert_eq!(unwrapped, key);
    }

    #[test]
    fn recovery_code_roundtrip() {
        let raw = generate_file_key();
        let formatted = format_recovery_code(&raw);
        let parsed = parse_recovery_code(&formatted).unwrap();
        assert_eq!(parsed, raw);
    }
}
