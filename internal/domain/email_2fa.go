package domain

import "time"

const (
	TwoFAMethodEmail = "email"
	TwoFAMethodTOTP  = "totp"
)

// Email2FAChallenge stores a pending login 2FA challenge (email code or TOTP).
type Email2FAChallenge struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Method    string    `json:"method"`
	CodeHash  string    `json:"-"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

// TotpBackupCode is a one-time recovery code for authenticator 2FA.
type TotpBackupCode struct {
	ID        string     `json:"id"`
	UserID    string     `json:"user_id"`
	CodeHash  string     `json:"-"`
	UsedAt    *time.Time `json:"used_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}
