package domain

import "time"

const (
	LoginApprovalPending  = "pending"
	LoginApprovalApproved = "approved"
	LoginApprovalDenied   = "denied"
	LoginApprovalExpired  = "expired"
)

// LoginApproval is a Google-style phone prompt for a new-device sign-in.
type LoginApproval struct {
	ID                 string     `json:"id"`
	UserID             string     `json:"user_id"`
	ChallengeToken     string     `json:"-"`
	PendingDeviceID    string     `json:"pending_device_id"`
	PendingDeviceName  string     `json:"pending_device_name"`
	PendingDeviceType  string     `json:"pending_device_type"`
	IPAddress          string     `json:"ip_address"`
	UserAgent          string     `json:"user_agent"`
	Status             string     `json:"status"`
	ExpiresAt          time.Time  `json:"expires_at"`
	CreatedAt          time.Time  `json:"created_at"`
	ResolvedAt         *time.Time `json:"resolved_at,omitempty"`
	AccessToken        string     `json:"-"`
	RefreshToken       string     `json:"-"`
	TokenExpiresIn     int        `json:"-"`
}

// PushToken stores an Expo push token for a trusted mobile device.
type PushToken struct {
	ID            string    `json:"id"`
	UserID        string    `json:"user_id"`
	DeviceID      string    `json:"device_id"`
	ExpoPushToken string    `json:"expo_push_token"`
	Platform      string    `json:"platform"`
	UpdatedAt     time.Time `json:"updated_at"`
	CreatedAt     time.Time `json:"created_at"`
}
