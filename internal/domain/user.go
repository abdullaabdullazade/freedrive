package domain

import "time"

// Role represents a user's role in the system.
type Role string

const (
	RoleAdmin Role = "admin"
	RoleUser  Role = "user"
	RoleGuest Role = "guest"
)

// User represents a registered user.
type User struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"`
	Role         Role      `json:"role"`
	QuotaBytes   int64     `json:"quota_bytes"`
	UsedBytes    int64     `json:"used_bytes"`
	AvatarURL         string     `json:"avatar_url,omitempty"`
	Suspended         bool       `json:"suspended"`
	Email2FAEnabled   bool       `json:"email_2fa_enabled"`
	LoginApprovalEnabled bool     `json:"login_approval_enabled"`
	TotpEnabled       bool       `json:"totp_enabled"`
	TotpSecret        string     `json:"-"`
	TotpEnrolledAt    *time.Time `json:"totp_enrolled_at,omitempty"`
	TwoFactorRequired bool       `json:"two_factor_required,omitempty" db:"-"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
	LastLoginAt       *time.Time `json:"last_login_at,omitempty"`
}

// RefreshToken stores a hashed refresh token for JWT rotation.
type RefreshToken struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	TokenHash string    `json:"-"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

// InviteLink allows new user registration.
type InviteLink struct {
	ID         string     `json:"id"`
	Code       string     `json:"code"`
	CreatedBy  string     `json:"created_by"`
	Email      string     `json:"email,omitempty"`
	Role       Role       `json:"role"`
	QuotaBytes int64      `json:"quota_bytes"`
	MaxUses    int        `json:"max_uses"`
	UsedCount  int        `json:"used_count"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}
