package domain

import "time"

// UserCrypto stores password-wrapped account encryption keys (UEK).
type UserCrypto struct {
	UserID              string    `json:"user_id"`
	KeySalt             []byte    `json:"key_salt"`
	WrappedUEK          string    `json:"wrapped_uek"`
	WrappedUEKRecovery  string    `json:"wrapped_uek_recovery,omitempty"`
	Version             int       `json:"version"`
	UpdatedAt           time.Time `json:"updated_at"`
}

// FileEncryptionKey stores a UEK-wrapped per-file encryption key.
type FileEncryptionKey struct {
	FileID          string    `json:"file_id"`
	OwnerID         string    `json:"owner_id"`
	WrappedFileKey  string    `json:"wrapped_file_key"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// EncryptionKeyEntry is used for bulk sync responses.
type EncryptionKeyEntry struct {
	FileID         string    `json:"file_id"`
	WrappedFileKey string    `json:"wrapped_file_key"`
	UpdatedAt      time.Time `json:"updated_at"`
}
