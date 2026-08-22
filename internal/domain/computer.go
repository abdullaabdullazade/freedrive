package domain

import "time"

// Computer represents a desktop device registered for backup/sync.
type Computer struct {
	ID           string     `json:"id"`
	OwnerID      string     `json:"owner_id"`
	Name         string     `json:"name"`
	Hostname     string     `json:"hostname,omitempty"`
	RootFolderID string     `json:"root_folder_id"`
	LastSeenAt   *time.Time `json:"last_seen_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}
