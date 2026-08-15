package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInvalidCredentials  = errors.New("invalid email or password")
	ErrUserExists          = errors.New("user with this email already exists")
	ErrInvalidInvite       = errors.New("invalid or expired invite code")
	ErrInviteEmailMismatch = errors.New("registration email must match the invite email")
	ErrInvalidToken        = errors.New("invalid or expired token")
	ErrAccountSuspended    = errors.New("account suspended")
	ErrRegistrationClosed  = errors.New("registration is closed")
	ErrSessionRevoked      = errors.New("session revoked")
)

// AuthService handles authentication and authorization.
type AuthService struct {
	userRepo       repository.UserRepository
	email2faRepo   repository.Email2FARepository
	totpBackupRepo repository.TotpBackupRepository
	sessionRepo    repository.SessionRepository
	jwtSecret      []byte
}

// NewAuthService creates a new auth service.
func NewAuthService(
	userRepo repository.UserRepository,
	email2faRepo repository.Email2FARepository,
	totpBackupRepo repository.TotpBackupRepository,
	sessionRepo repository.SessionRepository,
	jwtSecret string,
) *AuthService {
	return &AuthService{
		userRepo:       userRepo,
		email2faRepo:   email2faRepo,
		totpBackupRepo: totpBackupRepo,
		sessionRepo:    sessionRepo,
		jwtSecret:      []byte(jwtSecret),
	}
}

// TokenPair contains access and refresh tokens.
type TokenPair struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
}

// DeviceInfo describes the client that is logging in or refreshing.
type DeviceInfo struct {
	DeviceID   string
	DeviceName string
	DeviceType string
	UserAgent  string
	IPAddress  string
}

// Register creates a new user account.
func (s *AuthService) Register(ctx context.Context, email, username, password, inviteCode string) (*domain.User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	userCount, err := s.userRepo.Count(ctx)
	if err != nil {
		return nil, fmt.Errorf("count users: %w", err)
	}

	role := domain.RoleUser
	quotaBytes := adminsettings.DefaultQuotaBytes()
	if userCount == 0 {
		role = domain.RoleAdmin
	} else {
		mode := adminsettings.RegistrationMode()
		if mode == "closed" {
			return nil, ErrRegistrationClosed
		}
		if inviteCode != "" {
			invite, err := s.userRepo.GetInviteByCode(ctx, inviteCode)
			if err != nil {
				return nil, fmt.Errorf("get invite: %w", err)
			}
			if invite == nil {
				return nil, ErrInvalidInvite
			}
			if invite.MaxUses > 0 && invite.UsedCount >= invite.MaxUses {
				return nil, ErrInvalidInvite
			}
			if invite.ExpiresAt != nil && invite.ExpiresAt.Before(time.Now()) {
				return nil, ErrInvalidInvite
			}
			inviteEmail := strings.ToLower(strings.TrimSpace(invite.Email))
			if inviteEmail != "" && inviteEmail != email {
				return nil, ErrInviteEmailMismatch
			}
			if inviteEmail != "" {
				email = inviteEmail
			}
			role = invite.Role
			if invite.QuotaBytes > 0 {
				quotaBytes = invite.QuotaBytes
			}
			if err := s.userRepo.IncrementInviteUsage(ctx, invite.ID); err != nil {
				return nil, err
			}
		} else if mode == "invite" {
			return nil, ErrInvalidInvite
		}
	}

	existing, err := s.userRepo.GetByEmail(ctx, email)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, ErrUserExists
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}

	user := &domain.User{
		Email:        email,
		Username:     username,
		PasswordHash: string(hash),
		Role:         role,
		QuotaBytes:   quotaBytes,
	}
	if err := s.userRepo.Create(ctx, user); err != nil {
		return nil, err
	}
	return user, nil
}

// Login authenticates a user and returns JWT tokens (legacy helper).
func (s *AuthService) Login(ctx context.Context, email, password string, device DeviceInfo) (*TokenPair, *domain.User, error) {
	user, err := s.VerifyCredentials(ctx, email, password)
	if err != nil {
		return nil, nil, err
	}
	tokens, err := s.IssueTokens(ctx, user, device)
	if err != nil {
		return nil, nil, err
	}
	return tokens, user, nil
}

// CheckPassword verifies a user's password.
func (s *AuthService) CheckPassword(user *domain.User, password string) error {
	if user == nil {
		return ErrInvalidCredentials
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return ErrInvalidCredentials
	}
	return nil
}

// Refresh generates a new access token from a valid refresh token.
func (s *AuthService) Refresh(ctx context.Context, refreshToken string, device DeviceInfo) (*TokenPair, error) {
	tokenHash := hashToken(refreshToken)

	session, err := s.sessionRepo.GetByRefreshHash(ctx, tokenHash)
	if err != nil {
		return nil, err
	}
	if session != nil {
		if session.RevokedAt != nil || session.ExpiresAt.Before(time.Now()) {
			return nil, ErrInvalidToken
		}
		user, err := s.userRepo.GetByID(ctx, session.UserID)
		if err != nil || user == nil {
			return nil, ErrInvalidToken
		}
		if user.Suspended {
			return nil, ErrAccountSuspended
		}
		return s.rotateSessionTokens(ctx, user, session, device)
	}

	// Compatibility: migrate legacy refresh_tokens rows into sessions.
	stored, err := s.userRepo.GetRefreshToken(ctx, tokenHash)
	if err != nil {
		return nil, err
	}
	if stored == nil || stored.ExpiresAt.Before(time.Now()) {
		return nil, ErrInvalidToken
	}
	_ = s.userRepo.DeleteRefreshToken(ctx, tokenHash)

	user, err := s.userRepo.GetByID(ctx, stored.UserID)
	if err != nil || user == nil {
		return nil, ErrInvalidToken
	}
	if user.Suspended {
		return nil, ErrAccountSuspended
	}
	return s.generateTokenPair(ctx, user, device)
}

// Logout revokes the session associated with a refresh token.
func (s *AuthService) Logout(ctx context.Context, refreshToken string) error {
	tokenHash := hashToken(refreshToken)
	session, err := s.sessionRepo.GetByRefreshHash(ctx, tokenHash)
	if err != nil {
		return err
	}
	if session != nil {
		return s.sessionRepo.RevokeByID(ctx, session.ID, session.UserID)
	}
	return s.userRepo.DeleteRefreshToken(ctx, tokenHash)
}

// ResetPasswordByEmail updates user's password using email.
func (s *AuthService) ResetPasswordByEmail(ctx context.Context, email, newPassword string) error {
	email = strings.ToLower(strings.TrimSpace(email))
	user, err := s.userRepo.GetByEmail(ctx, email)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrInvalidCredentials
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	user.PasswordHash = string(hash)
	return s.userRepo.Update(ctx, user)
}

// ValidateAccessToken validates a JWT access token and returns the claims.
func (s *AuthService) ValidateAccessToken(tokenStr string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return s.jwtSecret, nil
	})
	if err != nil {
		return nil, ErrInvalidToken
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, ErrInvalidToken
	}

	return claims, nil
}

// EnsureSessionActive verifies the session is still valid and optionally updates last_seen.
func (s *AuthService) EnsureSessionActive(ctx context.Context, sessionID string) error {
	if sessionID == "" {
		return ErrSessionRevoked
	}
	session, err := s.sessionRepo.GetByID(ctx, sessionID)
	if err != nil {
		return err
	}
	if session == nil || session.RevokedAt != nil || session.ExpiresAt.Before(time.Now()) {
		return ErrSessionRevoked
	}
	_ = s.sessionRepo.TouchLastSeen(ctx, sessionID, 60)
	return nil
}

// SyncSessionDeviceMeta upgrades session device metadata from the current request
// (e.g. mark an older "web" mobile-app session as device_type=mobile).
func (s *AuthService) SyncSessionDeviceMeta(ctx context.Context, sessionID string, device DeviceInfo) {
	if sessionID == "" || device.DeviceType != domain.DeviceTypeMobile {
		return
	}
	session, err := s.sessionRepo.GetByID(ctx, sessionID)
	if err != nil || session == nil || session.RevokedAt != nil {
		return
	}
	if session.DeviceType == domain.DeviceTypeMobile {
		return
	}
	name := strings.TrimSpace(device.DeviceName)
	if name == "" {
		name = session.DeviceName
	}
	_ = s.sessionRepo.UpdateDeviceMeta(ctx, sessionID, domain.DeviceTypeMobile, name)
}

// ListSessions returns active sessions for a user.
func (s *AuthService) ListSessions(ctx context.Context, userID string) ([]domain.Session, error) {
	return s.sessionRepo.ListActiveByUser(ctx, userID)
}

// RevokeSession revokes one of the user's sessions.
func (s *AuthService) RevokeSession(ctx context.Context, userID, sessionID string) error {
	return s.sessionRepo.RevokeByID(ctx, sessionID, userID)
}

// RevokeOtherSessions revokes all sessions for the user except the current one.
func (s *AuthService) RevokeOtherSessions(ctx context.Context, userID, currentSessionID string) error {
	return s.sessionRepo.RevokeAllForUser(ctx, userID, currentSessionID)
}

// RevokeAllUserSessions revokes every session for a user (and legacy refresh tokens).
func (s *AuthService) RevokeAllUserSessions(ctx context.Context, userID string) error {
	_ = s.userRepo.DeleteUserRefreshTokens(ctx, userID)
	return s.sessionRepo.RevokeAllForUser(ctx, userID, "")
}

// RevokeAllSessions revokes every session in the system (admin).
func (s *AuthService) RevokeAllSessions(ctx context.Context) error {
	_ = s.userRepo.DeleteAllRefreshTokens(ctx)
	return s.sessionRepo.RevokeAll(ctx)
}

// EnsureAdmin creates the admin user from config if no users exist.
func (s *AuthService) EnsureAdmin(ctx context.Context, email, password string) error {
	count, err := s.userRepo.Count(ctx)
	if err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	_, err = s.Register(ctx, email, "Admin", password, "")
	return err
}

// HasActiveDevice reports whether the user already has an active session for deviceID.
func (s *AuthService) HasActiveDevice(ctx context.Context, userID, deviceID string) (bool, error) {
	if deviceID == "" {
		return false, nil
	}
	existing, err := s.sessionRepo.GetActiveByUserDevice(ctx, userID, deviceID)
	if err != nil {
		return false, err
	}
	return existing != nil, nil
}

// HasActiveMobileSession reports whether the user has any active mobile app session.
func (s *AuthService) HasActiveMobileSession(ctx context.Context, userID string) (bool, error) {
	sessions, err := s.sessionRepo.ListActiveByUser(ctx, userID)
	if err != nil {
		return false, err
	}
	for _, sess := range sessions {
		if sess.DeviceType == domain.DeviceTypeMobile {
			return true, nil
		}
	}
	return false, nil
}

// Claims represents JWT claims.
type Claims struct {
	UserID    string      `json:"uid"`
	Email     string      `json:"email"`
	Username  string      `json:"username"`
	Role      domain.Role `json:"role"`
	SessionID string      `json:"sid"`
	jwt.RegisteredClaims
}

// IssueTokens updates last login and returns JWT tokens bound to a new session.
func (s *AuthService) IssueTokens(ctx context.Context, user *domain.User, device DeviceInfo) (*TokenPair, error) {
	now := time.Now()
	user.LastLoginAt = &now
	if err := s.userRepo.Update(ctx, user); err != nil {
		return nil, err
	}
	return s.generateTokenPair(ctx, user, device)
}

func (s *AuthService) generateTokenPair(ctx context.Context, user *domain.User, device DeviceInfo) (*TokenPair, error) {
	refreshBytes := make([]byte, 32)
	if _, err := rand.Read(refreshBytes); err != nil {
		return nil, err
	}
	refreshStr := hex.EncodeToString(refreshBytes)
	refreshHash := hashToken(refreshStr)
	expiresAt := time.Now().Add(30 * 24 * time.Hour)

	deviceType := device.DeviceType
	switch deviceType {
	case domain.DeviceTypeDesktop, domain.DeviceTypeMobile:
		// keep
	default:
		deviceType = domain.DeviceTypeWeb
	}
	deviceName := strings.TrimSpace(device.DeviceName)
	if deviceName == "" {
		deviceName = "Unknown device"
	}
	deviceID := strings.TrimSpace(device.DeviceID)

	session := &domain.Session{
		UserID:           user.ID,
		RefreshTokenHash: refreshHash,
		DeviceID:         deviceID,
		DeviceName:       deviceName,
		DeviceType:       deviceType,
		UserAgent:        device.UserAgent,
		IPAddress:        device.IPAddress,
		ExpiresAt:        expiresAt,
	}

	if deviceID != "" {
		existing, err := s.sessionRepo.GetActiveByUserDevice(ctx, user.ID, deviceID)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			session.ID = existing.ID
			session.CreatedAt = existing.CreatedAt
			if err := s.sessionRepo.UpdateCredentials(ctx, session); err != nil {
				return nil, err
			}
			return s.signTokenPair(user, session.ID, refreshStr)
		}
	}

	if err := s.sessionRepo.Create(ctx, session); err != nil {
		return nil, err
	}

	return s.signTokenPair(user, session.ID, refreshStr)
}

func (s *AuthService) rotateSessionTokens(ctx context.Context, user *domain.User, session *domain.Session, device DeviceInfo) (*TokenPair, error) {
	refreshBytes := make([]byte, 32)
	if _, err := rand.Read(refreshBytes); err != nil {
		return nil, err
	}
	refreshStr := hex.EncodeToString(refreshBytes)
	refreshHash := hashToken(refreshStr)
	expiresAt := time.Now().Add(30 * 24 * time.Hour)

	deviceType := device.DeviceType
	if deviceType == "" {
		deviceType = session.DeviceType
	}
	if deviceType != domain.DeviceTypeDesktop {
		deviceType = domain.DeviceTypeWeb
	}
	deviceName := strings.TrimSpace(device.DeviceName)
	if deviceName == "" {
		deviceName = session.DeviceName
	}
	deviceID := strings.TrimSpace(device.DeviceID)
	if deviceID == "" {
		deviceID = session.DeviceID
	}

	session.RefreshTokenHash = refreshHash
	session.ExpiresAt = expiresAt
	session.DeviceID = deviceID
	session.DeviceName = deviceName
	session.DeviceType = deviceType
	if device.UserAgent != "" {
		session.UserAgent = device.UserAgent
	}
	if device.IPAddress != "" {
		session.IPAddress = device.IPAddress
	}

	if err := s.sessionRepo.UpdateCredentials(ctx, session); err != nil {
		return nil, err
	}
	return s.signTokenPair(user, session.ID, refreshStr)
}

func (s *AuthService) signTokenPair(user *domain.User, sessionID, refreshStr string) (*TokenPair, error) {
	accessClaims := &Claims{
		UserID:    user.ID,
		Email:     user.Email,
		Username:  user.Username,
		Role:      user.Role,
		SessionID: sessionID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "freedrive",
		},
	}
	accessToken := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims)
	accessStr, err := accessToken.SignedString(s.jwtSecret)
	if err != nil {
		return nil, fmt.Errorf("sign access token: %w", err)
	}

	return &TokenPair{
		AccessToken:  accessStr,
		RefreshToken: refreshStr,
		ExpiresIn:    86400,
	}, nil
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}
