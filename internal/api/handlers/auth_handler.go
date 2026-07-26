package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
	"github.com/abdullaabdullazade/freedrive/internal/service"
)

// AuthHandler handles authentication endpoints.
type AuthHandler struct {
	authService          *service.AuthService
	cryptoService        *service.CryptoService
	emailChangeRepo      repository.EmailChangeRepository
	userRepo             repository.UserRepository
	activityRepo         repository.ActivityRepository
	passwordResetService *service.PasswordResetService
}

// NewAuthHandler creates a new auth handler.
func NewAuthHandler(
	authService *service.AuthService,
	cryptoService *service.CryptoService,
	emailChangeRepo repository.EmailChangeRepository,
	userRepo repository.UserRepository,
	activityRepo repository.ActivityRepository,
	passwordResetService *service.PasswordResetService,
) *AuthHandler {
	return &AuthHandler{
		authService:          authService,
		cryptoService:        cryptoService,
		emailChangeRepo:      emailChangeRepo,
		userRepo:             userRepo,
		activityRepo:         activityRepo,
		passwordResetService: passwordResetService,
	}
}

func (h *AuthHandler) checkIP(w http.ResponseWriter, r *http.Request) bool {
	if !adminsettings.IsIPAllowed(middleware.ClientIP(r)) {
		writeError(w, "access denied from this network", http.StatusForbidden)
		return false
	}
	return true
}

func (h *AuthHandler) logAuthActivity(r *http.Request, user *domain.User, action domain.ActivityAction) {
	if h.activityRepo == nil || user == nil || user.ID == "" {
		return
	}
	username := user.Username
	if username == "" {
		username = user.Email
	}
	_ = h.activityRepo.Create(r.Context(), &domain.ActivityLog{
		UserID:     user.ID,
		Username:   username,
		Action:     action,
		TargetType: "auth",
		TargetID:   user.ID,
		TargetName: username,
		IPAddress:  middleware.ClientIP(r),
	})
}

// Register handles POST /api/v1/auth/register
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	if !h.checkIP(w, r) {
		return
	}

	var req struct {
		Email      string `json:"email"`
		Username   string `json:"username"`
		Password   string `json:"password"`
		InviteCode string `json:"invite_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Email == "" || req.Password == "" || req.Username == "" {
		writeError(w, "email, username, and password are required", http.StatusBadRequest)
		return
	}
	if len(req.Password) < 6 {
		writeError(w, "password must be at least 6 characters", http.StatusBadRequest)
		return
	}

	user, err := h.authService.Register(r.Context(), req.Email, req.Username, req.Password, req.InviteCode)
	if err != nil {
		switch err {
		case service.ErrUserExists:
			writeError(w, "user with this email already exists", http.StatusConflict)
		case service.ErrInvalidInvite:
			writeError(w, "invalid or expired invite code", http.StatusBadRequest)
		case service.ErrInviteEmailMismatch:
			writeError(w, "registration email must match the invite email", http.StatusBadRequest)
		case service.ErrRegistrationClosed:
			writeError(w, "registration is closed", http.StatusForbidden)
		default:
			writeError(w, "registration failed: "+err.Error(), http.StatusInternalServerError)
		}
		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"user": user,
	})
}

// Login handles POST /api/v1/auth/login
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	if !h.checkIP(w, r) {
		return
	}

	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Email == "" || req.Password == "" {
		writeError(w, "email and password are required", http.StatusBadRequest)
		return
	}

	email := strings.ToLower(strings.TrimSpace(req.Email))
	user, err := h.authService.VerifyCredentials(r.Context(), email, req.Password)
	if err != nil {
		if err == service.ErrInvalidCredentials {
			if existing, _ := h.userRepo.GetByEmail(r.Context(), email); existing != nil {
				h.logAuthActivity(r, existing, domain.ActionFailedLogin)
			}
			writeError(w, "invalid email or password", http.StatusUnauthorized)
		} else if err == service.ErrAccountSuspended {
			writeError(w, "account suspended", http.StatusForbidden)
		} else {
			writeError(w, "login failed", http.StatusInternalServerError)
		}
		return
	}

	if service.Needs2FA(user) {
		challenge, err := h.authService.StartLogin2FA(r.Context(), user)
		if err == service.Err2FAUnavailable {
			writeError(w, "email two-factor authentication is unavailable; contact your administrator", http.StatusServiceUnavailable)
			return
		}
		if err == service.ErrEnable2FAFirst {
			writeError(w, "enable two-factor authentication in Security before signing in", http.StatusServiceUnavailable)
			return
		}
		if err != nil {
			writeError(w, "failed to start two-factor authentication", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"requires_2fa":       true,
			"challenge_id":       challenge.ChallengeID,
			"method":             challenge.Method,
			"methods_available":  challenge.MethodsAvailable,
			"email_masked":       challenge.EmailMasked,
		})
		return
	}

	tokens, err := h.authService.IssueTokens(r.Context(), user, deviceInfoFromRequest(r))
	if err != nil {
		writeError(w, "login failed", http.StatusInternalServerError)
		return
	}
	h.logAuthActivity(r, user, domain.ActionLogin)

	user.TwoFactorRequired = adminsettings.Require2FA()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"tokens": tokens,
		"user":   user,
	})
}

// Verify2FA handles POST /api/v1/auth/verify-2fa
func (h *AuthHandler) Verify2FA(w http.ResponseWriter, r *http.Request) {
	if !h.checkIP(w, r) {
		return
	}

	var req struct {
		ChallengeID string `json:"challenge_id"`
		Code        string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	tokens, user, err := h.authService.VerifyEmail2FA(r.Context(), req.ChallengeID, req.Code, deviceInfoFromRequest(r))
	if err != nil {
		switch err {
		case service.ErrInvalid2FACode:
			writeError(w, "invalid or expired verification code", http.StatusBadRequest)
		case service.ErrAccountSuspended:
			writeError(w, "account suspended", http.StatusForbidden)
		default:
			writeError(w, "verification failed", http.StatusInternalServerError)
		}
		return
	}
	h.logAuthActivity(r, user, domain.ActionLogin)

	user.TwoFactorRequired = adminsettings.Require2FA()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"tokens": tokens,
		"user":   user,
	})
}

// Send2FAEmail handles POST /api/v1/auth/2fa/send-email — email fallback for TOTP challenges.
func (h *AuthHandler) Send2FAEmail(w http.ResponseWriter, r *http.Request) {
	if !h.checkIP(w, r) {
		return
	}

	var req struct {
		ChallengeID string `json:"challenge_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	challenge, err := h.authService.SendEmail2FAFallback(r.Context(), req.ChallengeID)
	if err != nil {
		switch err {
		case service.ErrInvalid2FACode:
			writeError(w, "invalid or expired verification challenge", http.StatusBadRequest)
		case service.Err2FAUnavailable:
			writeError(w, "email two-factor authentication is unavailable; contact your administrator", http.StatusServiceUnavailable)
		case service.ErrAccountSuspended:
			writeError(w, "account suspended", http.StatusForbidden)
		default:
			writeError(w, "failed to send verification code", http.StatusInternalServerError)
		}
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"requires_2fa":      true,
		"challenge_id":      challenge.ChallengeID,
		"method":            challenge.Method,
		"methods_available": challenge.MethodsAvailable,
		"email_masked":      challenge.EmailMasked,
	})
}

// Refresh handles POST /api/v1/auth/refresh
func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	if !h.checkIP(w, r) {
		return
	}

	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	tokens, err := h.authService.Refresh(r.Context(), req.RefreshToken, deviceInfoFromRequest(r))
	if err != nil {
		if err == service.ErrAccountSuspended {
			writeError(w, "account suspended", http.StatusForbidden)
		} else {
			writeError(w, "invalid or expired refresh token", http.StatusUnauthorized)
		}
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"tokens": tokens,
	})
}

// Logout handles POST /api/v1/auth/logout
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	_ = h.authService.Logout(r.Context(), req.RefreshToken)
	writeJSON(w, http.StatusOK, map[string]string{"message": "logged out"})
}

// ResetPassword handles POST /api/v1/auth/reset-password
func (h *AuthHandler) ResetPassword(w http.ResponseWriter, r *http.Request) {
	if !h.checkIP(w, r) {
		return
	}

	var req struct {
		Token       string `json:"token"`
		Email       string `json:"email"`
		NewPassword string `json:"new_password"`
		CryptoUpdate *struct {
			KeySalt            []byte `json:"key_salt"`
			WrappedUEK         string `json:"wrapped_uek"`
			WrappedUEKRecovery string `json:"wrapped_uek_recovery"`
		} `json:"crypto_update"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Token == "" || req.Email == "" || req.NewPassword == "" {
		writeError(w, "token, email and new_password are required", http.StatusBadRequest)
		return
	}
	if len(req.NewPassword) < 6 {
		writeError(w, "password must be at least 6 characters", http.StatusBadRequest)
		return
	}
	if !h.passwordResetService.ConsumeResetToken(r.Context(), req.Token, req.Email) {
		writeError(w, "invalid or expired reset link", http.StatusBadRequest)
		return
	}
	if err := h.authService.ResetPasswordByEmail(r.Context(), req.Email, req.NewPassword); err != nil {
		writeError(w, "failed to reset password", http.StatusInternalServerError)
		return
	}

	if req.CryptoUpdate != nil && req.CryptoUpdate.WrappedUEK != "" {
		user, err := h.userRepo.GetByEmail(r.Context(), strings.ToLower(strings.TrimSpace(req.Email)))
		if err == nil && user != nil {
			_ = h.cryptoService.UpdateAccount(
				r.Context(),
				user.ID,
				req.CryptoUpdate.KeySalt,
				req.CryptoUpdate.WrappedUEK,
				req.CryptoUpdate.WrappedUEKRecovery,
			)
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "success", "message": "Password updated"})
}

// ResetPasswordCryptoInfo handles POST /api/v1/auth/reset-password/crypto-info
func (h *AuthHandler) ResetPasswordCryptoInfo(w http.ResponseWriter, r *http.Request) {
	if !h.checkIP(w, r) {
		return
	}

	var req struct {
		Token string `json:"token"`
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	userID, ok := h.passwordResetService.PeekResetToken(r.Context(), req.Token, req.Email)
	if !ok {
		writeError(w, "invalid or expired reset link", http.StatusBadRequest)
		return
	}
	data, err := h.cryptoService.GetAccount(r.Context(), userID)
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

// ForgotPassword handles POST /api/v1/auth/forgot-password
func (h *AuthHandler) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	if !h.checkIP(w, r) {
		return
	}

	var req struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	emailAddr := strings.ToLower(strings.TrimSpace(req.Email))
	if emailAddr == "" {
		writeError(w, "email is required", http.StatusBadRequest)
		return
	}

	raw, err := h.passwordResetService.CreateResetLink(r.Context(), emailAddr)
	if err != nil {
		writeError(w, "failed to process request", http.StatusInternalServerError)
		return
	}

	siteURL := adminsettings.SiteURL()
	if raw != "" && adminsettings.SMTPConfigured() {
		_ = h.passwordResetService.SendResetEmail(r.Context(), emailAddr, siteURL, raw)
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"message": "If an account exists for this email, a reset link has been sent.",
	})
}
