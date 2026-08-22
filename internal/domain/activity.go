package domain

import "time"

// ActivityAction represents the type of activity.
type ActivityAction string

const (
	ActionUpload   ActivityAction = "upload"
	ActionDownload ActivityAction = "download"
	ActionDelete   ActivityAction = "delete"
	ActionRename   ActivityAction = "rename"
	ActionMove     ActivityAction = "move"
	ActionCopy     ActivityAction = "copy"
	ActionShare    ActivityAction = "share"
	ActionUnshare  ActivityAction = "unshare"
	ActionRestore  ActivityAction = "restore"
	ActionComment  ActivityAction = "comment"
	ActionLogin       ActivityAction = "login"
	ActionFailedLogin ActivityAction = "failed_login"
	ActionCreate      ActivityAction = "create"
)

// ActivityLog represents a recorded user action.
type ActivityLog struct {
	ID         string         `json:"id"`
	UserID     string         `json:"user_id"`
	Username   string         `json:"username,omitempty"`
	Action     ActivityAction `json:"action"`
	TargetType string         `json:"target_type"`
	TargetID   string         `json:"target_id"`
	TargetName string         `json:"target_name,omitempty"`
	Metadata   string         `json:"metadata,omitempty"`
	IPAddress  string         `json:"ip_address,omitempty"`
	CreatedAt  time.Time      `json:"created_at"`
}
