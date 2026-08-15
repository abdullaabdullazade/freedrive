package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
)

var (
	ErrLoginApprovalNotFound = errors.New("login approval not found")
	ErrLoginApprovalDenied   = errors.New("login approval denied")
	ErrLoginApprovalExpired  = errors.New("login approval expired")
	ErrLoginApprovalPending  = errors.New("login approval pending")
	ErrLoginApprovalInvalid  = errors.New("invalid login approval token")
)

const loginApprovalTTL = 5 * time.Minute

// LoginApprovalService manages Google-style phone sign-in prompts.
type LoginApprovalService struct {
	approvalRepo repository.LoginApprovalRepository
	pushTokenRepo repository.PushTokenRepository
	push         *ExpoPushService
	auth         *AuthService
	userRepo     repository.UserRepository
}

func NewLoginApprovalService(
	approvalRepo repository.LoginApprovalRepository,
	pushTokenRepo repository.PushTokenRepository,
	push *ExpoPushService,
	auth *AuthService,
	userRepo repository.UserRepository,
) *LoginApprovalService {
	return &LoginApprovalService{
		approvalRepo:  approvalRepo,
		pushTokenRepo: pushTokenRepo,
		push:          push,
		auth:          auth,
		userRepo:      userRepo,
	}
}

// ShouldOfferApproval is true for new non-mobile devices when the user has push tokens.
func (s *LoginApprovalService) ShouldOfferApproval(ctx context.Context, userID string, device DeviceInfo) (bool, error) {
	if device.DeviceType == domain.DeviceTypeMobile {
		return false, nil
	}
	has, err := s.push.HasPushTokens(ctx, userID)
	if err != nil || !has {
		return has, err
	}
	if device.DeviceID == "" {
		return true, nil
	}
	known, err := s.auth.HasActiveDevice(ctx, userID, device.DeviceID)
	if err != nil {
		return false, err
	}
	return !known, nil
}

// Start creates a pending approval and sends Expo push (best-effort).
func (s *LoginApprovalService) Start(ctx context.Context, user *domain.User, device DeviceInfo) (*domain.LoginApproval, error) {
	tokenBytes := make([]byte, 24)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, err
	}
	a := &domain.LoginApproval{
		UserID:            user.ID,
		ChallengeToken:    hex.EncodeToString(tokenBytes),
		PendingDeviceID:   strings.TrimSpace(device.DeviceID),
		PendingDeviceName: strings.TrimSpace(device.DeviceName),
		PendingDeviceType: device.DeviceType,
		IPAddress:         device.IPAddress,
		UserAgent:         device.UserAgent,
		Status:            domain.LoginApprovalPending,
		ExpiresAt:         time.Now().Add(loginApprovalTTL),
	}
	if a.PendingDeviceName == "" {
		a.PendingDeviceName = "Unknown device"
	}
	if a.PendingDeviceType == "" {
		a.PendingDeviceType = domain.DeviceTypeWeb
	}
	if err := s.approvalRepo.Create(ctx, a); err != nil {
		return nil, err
	}
	if err := s.push.SendLoginApproval(ctx, user.ID, a.ID, a.PendingDeviceName, a.IPAddress); err != nil {
		log.Printf("login approval push failed: %v", err)
	}
	return a, nil
}

// PublicView returns poll-safe fields (and tokens once approved).
func (s *LoginApprovalService) PublicView(ctx context.Context, id, challengeToken string) (*domain.LoginApproval, *TokenPair, *domain.User, error) {
	a, err := s.approvalRepo.GetByID(ctx, id)
	if err != nil {
		return nil, nil, nil, err
	}
	if a == nil || a.ChallengeToken != challengeToken {
		return nil, nil, nil, ErrLoginApprovalNotFound
	}
	if a.Status == domain.LoginApprovalPending && time.Now().After(a.ExpiresAt) {
		a.Status = domain.LoginApprovalExpired
		now := time.Now()
		a.ResolvedAt = &now
		_ = s.approvalRepo.Update(ctx, a)
	}
	switch a.Status {
	case domain.LoginApprovalPending:
		return a, nil, nil, ErrLoginApprovalPending
	case domain.LoginApprovalDenied:
		return a, nil, nil, ErrLoginApprovalDenied
	case domain.LoginApprovalExpired:
		return a, nil, nil, ErrLoginApprovalExpired
	case domain.LoginApprovalApproved:
		if a.AccessToken == "" {
			return a, nil, nil, ErrLoginApprovalNotFound
		}
		user, err := s.userRepo.GetByID(ctx, a.UserID)
		if err != nil || user == nil {
			return a, nil, nil, ErrLoginApprovalNotFound
		}
		tokens := &TokenPair{
			AccessToken:  a.AccessToken,
			RefreshToken: a.RefreshToken,
			ExpiresIn:    a.TokenExpiresIn,
		}
		// Clear stored tokens after first successful poll to limit exposure.
		a.AccessToken = ""
		a.RefreshToken = ""
		a.TokenExpiresIn = 0
		_ = s.approvalRepo.Update(ctx, a)
		return a, tokens, user, nil
	default:
		return a, nil, nil, ErrLoginApprovalNotFound
	}
}

// GetForApprover returns challenge details for a signed-in mobile user.
func (s *LoginApprovalService) GetForApprover(ctx context.Context, id, userID string) (*domain.LoginApproval, error) {
	a, err := s.approvalRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if a == nil || a.UserID != userID {
		return nil, ErrLoginApprovalNotFound
	}
	if a.Status == domain.LoginApprovalPending && time.Now().After(a.ExpiresAt) {
		a.Status = domain.LoginApprovalExpired
		now := time.Now()
		a.ResolvedAt = &now
		_ = s.approvalRepo.Update(ctx, a)
	}
	return a, nil
}

// Approve issues tokens for the pending device.
func (s *LoginApprovalService) Approve(ctx context.Context, id, userID string) (*domain.LoginApproval, error) {
	a, err := s.GetForApprover(ctx, id, userID)
	if err != nil {
		return nil, err
	}
	if a.Status != domain.LoginApprovalPending {
		if a.Status == domain.LoginApprovalExpired {
			return nil, ErrLoginApprovalExpired
		}
		return a, nil
	}
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil || user == nil {
		return nil, ErrLoginApprovalNotFound
	}
	device := DeviceInfo{
		DeviceID:   a.PendingDeviceID,
		DeviceName: a.PendingDeviceName,
		DeviceType: a.PendingDeviceType,
		UserAgent:  a.UserAgent,
		IPAddress:  a.IPAddress,
	}
	tokens, err := s.auth.IssueTokens(ctx, user, device)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	a.Status = domain.LoginApprovalApproved
	a.ResolvedAt = &now
	a.AccessToken = tokens.AccessToken
	a.RefreshToken = tokens.RefreshToken
	a.TokenExpiresIn = tokens.ExpiresIn
	if err := s.approvalRepo.Update(ctx, a); err != nil {
		return nil, err
	}
	return a, nil
}

// Deny rejects the pending sign-in.
func (s *LoginApprovalService) Deny(ctx context.Context, id, userID string) (*domain.LoginApproval, error) {
	a, err := s.GetForApprover(ctx, id, userID)
	if err != nil {
		return nil, err
	}
	if a.Status != domain.LoginApprovalPending {
		return a, nil
	}
	now := time.Now()
	a.Status = domain.LoginApprovalDenied
	a.ResolvedAt = &now
	if err := s.approvalRepo.Update(ctx, a); err != nil {
		return nil, err
	}
	return a, nil
}

// RegisterPushToken upserts an Expo token for the current device.
func (s *LoginApprovalService) RegisterPushToken(ctx context.Context, userID, deviceID, expoToken, platform string) error {
	deviceID = strings.TrimSpace(deviceID)
	expoToken = strings.TrimSpace(expoToken)
	if expoToken == "" {
		return errors.New("expo_push_token is required")
	}
	if deviceID == "" {
		deviceID = "unknown"
	}
	return s.pushTokenRepo.Upsert(ctx, &domain.PushToken{
		UserID:        userID,
		DeviceID:      deviceID,
		ExpoPushToken: expoToken,
		Platform:      platform,
	})
}

// UnregisterPushToken removes a token for the device or exact Expo token.
func (s *LoginApprovalService) UnregisterPushToken(ctx context.Context, userID, deviceID, expoToken string) error {
	if strings.TrimSpace(expoToken) != "" {
		return s.pushTokenRepo.DeleteByToken(ctx, userID, strings.TrimSpace(expoToken))
	}
	return s.pushTokenRepo.DeleteByUserDevice(ctx, userID, strings.TrimSpace(deviceID))
}
