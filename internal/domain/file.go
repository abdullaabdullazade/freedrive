package domain

import "time"

// File represents a stored file's metadata.
type File struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	MimeType      string     `json:"mime_type"`
	Size          int64      `json:"size"`
	EncryptedSize int64      `json:"encrypted_size"`
	FolderID      *string    `json:"folder_id,omitempty"`
	OwnerID       string     `json:"owner_id"`
	BlobPath      string     `json:"-"`
	IV            string     `json:"iv"`
	Version       int        `json:"version"`
	IsStarred     bool       `json:"is_starred"`
	IsTrashed     bool       `json:"is_trashed"`
	TrashedAt     *time.Time `json:"trashed_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	AccessedAt    time.Time  `json:"accessed_at"`
}

// FileMeta is a lightweight projection of a file used for storage breakdown.
type FileMeta struct {
	MimeType      string
	Name          string
	EncryptedSize int64
}

// DuplicateGroup describes files sharing owner, name, and encrypted size.
type DuplicateGroup struct {
	OwnerID       string `json:"owner_id"`
	Name          string `json:"name"`
	EncryptedSize int64  `json:"encrypted_size"`
	Count         int    `json:"count"`
}

// FileVersion represents a historical version of a file.
type FileVersion struct {
	ID        string    `json:"id"`
	FileID    string    `json:"file_id"`
	Version   int       `json:"version"`
	Size      int64     `json:"size"`
	BlobPath  string    `json:"-"`
	IV        string    `json:"iv"`
	CreatedAt time.Time `json:"created_at"`
	CreatedBy string    `json:"created_by"`
}

// FileListOptions contains filters for listing files.
type FileListOptions struct {
	FolderID  *string
	OwnerID   string
	Trashed   bool
	Starred   bool
	MimeType  string
	Search    string
	SortBy    string // name, size, created_at, updated_at
	SortDir   string // asc, desc
	Page      int
	PageSize  int
}
