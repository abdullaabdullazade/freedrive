package domain

import "time"

// EmailChangeToken stores a pending email change confirmation.
type EmailChangeToken struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	NewEmail  string    `json:"new_email"`
	TokenHash string    `json:"-"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}
