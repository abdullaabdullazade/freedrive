package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/email"
)

func hashEmailChangeToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func maskEmail(addr string) string {
	addr = strings.TrimSpace(strings.ToLower(addr))
	parts := strings.Split(addr, "@")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "***"
	}
	local := parts[0]
	if len(local) == 1 {
		return "*@" + parts[1]
	}
	return local[:1] + "***@" + parts[1]
}

// RequestEmailChange handles POST /api/v1/me/email-change/request
func (h *UserHandler) RequestEmailChange(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		NewEmail string `json:"new_email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	newEmail := strings.ToLower(strings.TrimSpace(req.NewEmail))
	password := req.Password
	if newEmail == "" || !strings.Contains(newEmail, "@") {
		writeError(w, "invalid email address", http.StatusBadRequest)
		return
	}
	if password == "" {
		writeError(w, "password is required", http.StatusBadRequest)
		return
	}

	user, err := h.userRepo.GetByID(r.Context(), userID)
	if err != nil || user == nil {
		writeError(w, "user not found", http.StatusNotFound)
		return
	}
	if strings.EqualFold(user.Email, newEmail) {
		writeError(w, "new email must differ from current email", http.StatusBadRequest)
		return
	}
	if err := h.authService.CheckPassword(user, password); err != nil {
		writeError(w, "invalid password", http.StatusUnauthorized)
		return
	}

	existing, err := h.userRepo.GetByEmail(r.Context(), newEmail)
	if err != nil {
		writeError(w, "failed to validate email", http.StatusInternalServerError)
		return
	}
	if existing != nil && existing.ID != userID {
		writeError(w, "email already in use", http.StatusConflict)
		return
	}

	smtpCfg := adminsettings.SMTP()
	if smtpCfg.Server == "" || smtpCfg.Port == 0 || smtpCfg.FromAddress == "" {
		writeError(w, "smtp settings are incomplete: ask your admin to configure email in admin settings", http.StatusBadRequest)
		return
	}

	rawToken := generateRandomString(64)
	tokenHash := hashEmailChangeToken(rawToken)
	expiresAt := time.Now().Add(24 * time.Hour)

	_ = h.emailChangeRepo.DeleteByUserID(r.Context(), userID)
	if err := h.emailChangeRepo.Create(r.Context(), &domain.EmailChangeToken{
		UserID:    userID,
		NewEmail:  newEmail,
		TokenHash: tokenHash,
		ExpiresAt: expiresAt,
	}); err != nil {
		writeError(w, "failed to create confirmation token", http.StatusInternalServerError)
		return
	}

	siteURL := siteBaseURL(adminsettings.SiteURL(), r)
	confirmURL := fmt.Sprintf("%s/confirm-email?token=%s", siteURL, url.QueryEscape(rawToken))
	subject := "Confirm your new FreeDrive email"
	body := fmt.Sprintf(
		"Hello %s,\n\nYou requested to change your FreeDrive account email to this address.\n\nConfirm your new email:\n%s\n\nThis link expires in 24 hours. If you did not request this change, ignore this email.\n",
		chooseDisplayName(user.Username, user.Email),
		confirmURL,
	)

	go func() {
		if err := email.SendFromSettings(newEmail, subject, body); err != nil {
			log.Printf("failed to send email change confirmation to %s: %v", newEmail, err)
		}
	}()

	// Optional notice to old email (informational only).
	go func() {
		noticeSubject := "FreeDrive email change requested"
		noticeBody := fmt.Sprintf(
			"Hello %s,\n\nA request was made to change your FreeDrive account email to %s.\n\nIf this was not you, contact your administrator immediately.\n",
			chooseDisplayName(user.Username, user.Email),
			newEmail,
		)
		_ = email.SendFromSettings(user.Email, noticeSubject, noticeBody)
	}()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":            "pending",
		"new_email_masked":  maskEmail(newEmail),
		"expires_at":        expiresAt.UTC().Format(time.RFC3339),
	})
}

// EmailChangeStatus handles GET /api/v1/me/email-change/status
func (h *UserHandler) EmailChangeStatus(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	pending, err := h.emailChangeRepo.GetPendingByUserID(r.Context(), userID)
	if err != nil {
		writeError(w, "failed to load status", http.StatusInternalServerError)
		return
	}
	if pending == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"pending": false})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"pending":          true,
		"new_email_masked": maskEmail(pending.NewEmail),
		"expires_at":       pending.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

// ConfirmEmail handles POST /api/v1/auth/confirm-email
func (h *AuthHandler) ConfirmEmail(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	token := strings.TrimSpace(req.Token)
	if token == "" {
		writeError(w, "token is required", http.StatusBadRequest)
		return
	}

	entry, err := h.emailChangeRepo.GetByTokenHash(r.Context(), hashEmailChangeToken(token))
	if err != nil || entry == nil {
		writeError(w, "invalid or expired confirmation link", http.StatusBadRequest)
		return
	}
	if time.Now().After(entry.ExpiresAt) {
		_ = h.emailChangeRepo.DeleteByID(r.Context(), entry.ID)
		writeError(w, "invalid or expired confirmation link", http.StatusBadRequest)
		return
	}

	user, err := h.userRepo.GetByID(r.Context(), entry.UserID)
	if err != nil || user == nil {
		writeError(w, "user not found", http.StatusNotFound)
		return
	}

	existing, err := h.userRepo.GetByEmail(r.Context(), entry.NewEmail)
	if err != nil {
		writeError(w, "failed to validate email", http.StatusInternalServerError)
		return
	}
	if existing != nil && existing.ID != user.ID {
		_ = h.emailChangeRepo.DeleteByID(r.Context(), entry.ID)
		writeError(w, "email already in use", http.StatusConflict)
		return
	}

	user.Email = entry.NewEmail
	user.UpdatedAt = time.Now()
	if err := h.userRepo.Update(r.Context(), user); err != nil {
		writeError(w, "failed to update email", http.StatusInternalServerError)
		return
	}

	_ = h.emailChangeRepo.DeleteByID(r.Context(), entry.ID)
	_ = h.authService.RevokeAllUserSessions(r.Context(), user.ID)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status": "success",
		"email":  user.Email,
	})
}
