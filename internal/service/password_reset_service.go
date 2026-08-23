package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/email"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
)

// PasswordResetService handles password reset token lifecycle.
type PasswordResetService struct {
	userRepo repository.UserRepository
	resetRepo repository.PasswordResetRepository
}

// NewPasswordResetService creates a password reset service.
func NewPasswordResetService(userRepo repository.UserRepository, resetRepo repository.PasswordResetRepository) *PasswordResetService {
	return &PasswordResetService{userRepo: userRepo, resetRepo: resetRepo}
}

// CreateResetLink creates a reset token and returns the raw token for URL building.
func (s *PasswordResetService) CreateResetLink(ctx context.Context, emailAddr string) (string, error) {
	emailAddr = strings.ToLower(strings.TrimSpace(emailAddr))
	user, err := s.userRepo.GetByEmail(ctx, emailAddr)
	if err != nil {
		return "", err
	}
	if user == nil {
		// Do not reveal whether the email exists.
		return "", nil
	}

	raw := randomToken(32)
	hash := hashResetToken(raw)
	_ = s.resetRepo.DeleteByUserID(ctx, user.ID)

	entry := &domain.PasswordResetToken{
		UserID:    user.ID,
		Email:     user.Email,
		TokenHash: hash,
		ExpiresAt: time.Now().Add(30 * time.Minute),
	}
	if err := s.resetRepo.Create(ctx, entry); err != nil {
		return "", err
	}
	return raw, nil
}

// SendResetEmail emails a password reset link when SMTP is configured.
func (s *PasswordResetService) SendResetEmail(ctx context.Context, emailAddr, siteURL, rawToken string) error {
	if rawToken == "" {
		return nil
	}
	link := strings.TrimRight(siteURL, "/") + "/reset-password?token=" + rawToken + "&email=" + emailAddr
	subject := "Reset your FreeDrive password"
	body := fmt.Sprintf("Hello,\n\nUse this link to reset your password (expires in 30 minutes):\n\n%s\n\nIf you did not request this, ignore this email.\n", link)
	return email.SendFromSettings(emailAddr, subject, body)
}

// ConsumeResetToken validates and consumes a reset token for the given email.
func (s *PasswordResetService) ConsumeResetToken(ctx context.Context, rawToken, emailAddr string) bool {
	entry, ok := s.validateResetToken(ctx, rawToken, emailAddr)
	if !ok || entry == nil {
		return false
	}
	_ = s.resetRepo.DeleteByID(ctx, entry.ID)
	return true
}

// PeekResetToken validates a reset token without consuming it.
func (s *PasswordResetService) PeekResetToken(ctx context.Context, rawToken, emailAddr string) (string, bool) {
	entry, ok := s.validateResetToken(ctx, rawToken, emailAddr)
	if !ok || entry == nil {
		return "", false
	}
	return entry.UserID, true
}

func (s *PasswordResetService) validateResetToken(ctx context.Context, rawToken, emailAddr string) (*domain.PasswordResetToken, bool) {
	emailAddr = strings.ToLower(strings.TrimSpace(emailAddr))
	entry, err := s.resetRepo.GetByTokenHash(ctx, hashResetToken(rawToken))
	if err != nil || entry == nil {
		return nil, false
	}
	if time.Now().After(entry.ExpiresAt) {
		return nil, false
	}
	if entry.Email != emailAddr {
		return nil, false
	}
	return entry, true
}

func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func hashResetToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}
