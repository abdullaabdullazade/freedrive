package domain

import "time"

// Comment represents a user annotation on a file.
type Comment struct {
	ID                 string    `json:"id"`
	FileID             string    `json:"file_id"`
	UserID             string    `json:"user_id"`
	Username           string    `json:"username,omitempty"`
	Content            string    `json:"content"`
	ParentID           *string   `json:"parent_id,omitempty"`
	AssignedTo         *string   `json:"assigned_to,omitempty"`
	AssignedToUsername string    `json:"assigned_to_username,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}
