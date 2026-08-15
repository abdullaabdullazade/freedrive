package domain

import "time"

const (
	DeviceTypeWeb     = "web"
	DeviceTypeDesktop = "desktop"
	DeviceTypeMobile  = "mobile"
)

// Session represents a login session tied to a refresh-token family.
type Session struct {
	ID               string     `json:"id"`
	UserID           string     `json:"user_id"`
	RefreshTokenHash string     `json:"-"`
	DeviceID         string     `json:"device_id,omitempty"`
	DeviceName       string     `json:"device_name"`
	DeviceType       string     `json:"device_type"`
	UserAgent        string     `json:"user_agent,omitempty"`
	IPAddress        string     `json:"ip_address,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
	LastSeenAt       time.Time  `json:"last_seen_at"`
	ExpiresAt        time.Time  `json:"expires_at"`
	RevokedAt        *time.Time `json:"revoked_at,omitempty"`
}
