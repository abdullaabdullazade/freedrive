package domain

import "time"

// UploadSession tracks a resumable chunked upload of encrypted ciphertext.
type UploadSession struct {
	ID             string    `json:"id"`
	UserID         string    `json:"user_id"`
	FileID         *string   `json:"file_id,omitempty"`
	Name           string    `json:"name"`
	MimeType       string    `json:"mime_type"`
	IV             string    `json:"iv"`
	OriginalSize   int64     `json:"original_size"`
	EncryptedSize  int64     `json:"encrypted_size"`
	FolderID       *string   `json:"folder_id,omitempty"`
	TempPath       string    `json:"-"`
	ReceivedBytes  int64     `json:"received_bytes"`
	CreatedAt      time.Time `json:"created_at"`
	ExpiresAt      time.Time `json:"expires_at"`
}
