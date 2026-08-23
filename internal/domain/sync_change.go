package domain

import (
	"encoding/json"
	"time"
)

// Sync entity and operation constants for the change feed.
const (
	SyncEntityFile   = "file"
	SyncEntityFolder = "folder"

	SyncOpCreate          = "create"
	SyncOpUpdate          = "update"
	SyncOpRename          = "rename"
	SyncOpMove            = "move"
	SyncOpTrash           = "trash"
	SyncOpRestore         = "restore"
	SyncOpPermanentDelete = "permanent_delete"
)

// SyncChange represents one monotonic entry in the computer sync feed.
type SyncChange struct {
	Seq             int64           `json:"seq"`
	UserID          string          `json:"-"`
	ComputerRootID  string          `json:"-"`
	EntityType      string          `json:"entity_type"`
	EntityID        string          `json:"entity_id"`
	ParentID        *string         `json:"parent_id,omitempty"`
	Operation       string          `json:"operation"`
	Name            string          `json:"name"`
	Version         int             `json:"version"`
	OccurredAt      time.Time       `json:"occurred_at"`
	Payload         json.RawMessage `json:"payload,omitempty"`
	IsTombstone     bool            `json:"is_tombstone,omitempty"`
}

// SyncChangePayload carries optional metadata for desktop apply.
type SyncChangePayload struct {
	MimeType      string `json:"mime_type,omitempty"`
	Size          int64  `json:"size,omitempty"`
	EncryptedSize int64  `json:"encrypted_size,omitempty"`
	UpdatedAt     string `json:"updated_at,omitempty"`
	OldName       string `json:"old_name,omitempty"`
	OldParentID   string `json:"old_parent_id,omitempty"`
}

// ComputerSnapshot is the initial consistent tree for a registered computer.
type ComputerSnapshot struct {
	Cursor  int64        `json:"cursor"`
	Folders []Folder     `json:"folders"`
	Files   []File       `json:"files"`
}

// SyncChangesPage is a paginated slice of the change feed.
type SyncChangesPage struct {
	Changes    []SyncChange `json:"changes"`
	NextCursor int64        `json:"next_cursor"`
}
