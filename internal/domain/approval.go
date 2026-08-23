package domain

import "time"

// FileApproval represents a simplified approval request on a file.
type FileApproval struct {
	ID          string    `json:"id"`
	FileID      string    `json:"file_id"`
	RequestedBy string    `json:"requested_by"`
	ApproverID  string    `json:"approver_id"`
	Status      string    `json:"status"` // pending, approved, rejected
	CreatedAt   time.Time `json:"created_at"`
}
