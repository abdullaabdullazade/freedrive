package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/email"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
	"github.com/abdullaabdullazade/freedrive/internal/service"
	"github.com/abdullaabdullazade/freedrive/internal/storage"
	"github.com/go-chi/chi/v5"
)

var (
	adminSettings   = map[string]interface{}{}
	adminSettingsMu sync.RWMutex
	settingsFile    = "data/settings.json"
)

func init() {
	loadSettings()
}

func loadSettings() {
	adminSettingsMu.Lock()
	defer adminSettingsMu.Unlock()

	if err := os.MkdirAll(filepath.Dir(settingsFile), 0755); err != nil {
		return
	}

	file, err := os.Open(settingsFile)
	if err != nil {
		return
	}
	defer file.Close()

	bytes, err := io.ReadAll(file)
	if err != nil {
		return
	}

	_ = json.Unmarshal(bytes, &adminSettings)
}

func saveSettings() {
	adminSettingsMu.RLock()
	defer adminSettingsMu.RUnlock()

	bytes, err := json.MarshalIndent(adminSettings, "", "  ")
	if err != nil {
		return
	}

	_ = os.WriteFile(settingsFile, bytes, 0644)
}

// AdminHandler handles admin endpoints.
type AdminHandler struct {
	userRepo             repository.UserRepository
	fileRepo             repository.FileRepository
	folderRepo           repository.FolderRepository
	activityRepo         repository.ActivityRepository
	authService          *service.AuthService
	passwordResetService *service.PasswordResetService
	diskStorage          *storage.DiskStorage
	dataDir              string
}

// NewAdminHandler creates a new admin handler.
func NewAdminHandler(
	userRepo repository.UserRepository,
	fileRepo repository.FileRepository,
	folderRepo repository.FolderRepository,
	activityRepo repository.ActivityRepository,
	authService *service.AuthService,
	passwordResetService *service.PasswordResetService,
	diskStorage *storage.DiskStorage,
	dataDir string,
) *AdminHandler {
	if dataDir != "" {
		adminSettingsMu.Lock()
		settingsFile = filepath.Join(dataDir, "settings.json")
		adminSettingsMu.Unlock()
		loadSettings()
	}
	return &AdminHandler{
		userRepo:             userRepo,
		fileRepo:             fileRepo,
		folderRepo:           folderRepo,
		activityRepo:         activityRepo,
		authService:          authService,
		passwordResetService: passwordResetService,
		diskStorage:          diskStorage,
		dataDir:              dataDir,
	}
}

// ListUsers handles GET /api/v1/admin/users
func (h *AdminHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.userRepo.List(r.Context())
	if err != nil {
		writeError(w, "failed to list users", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"users": users})
}

// CreateUser handles POST /api/v1/admin/users
func (h *AdminHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Username string `json:"username"`
		Password string `json:"password"`
		Role     string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	user, err := h.authService.Register(r.Context(), req.Email, req.Username, req.Password, "")
	if err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Update role if specified
	if req.Role != "" && req.Role != "user" {
		user.Role = domain.Role(req.Role)
		_ = h.userRepo.Update(r.Context(), user)
	}

	writeJSON(w, http.StatusCreated, user)
}

// UpdateUser handles PATCH /api/v1/admin/users/{id}
func (h *AdminHandler) UpdateUser(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "id")

	user, err := h.userRepo.GetByID(r.Context(), userID)
	if err != nil || user == nil {
		writeError(w, "user not found", http.StatusNotFound)
		return
	}

	var req struct {
		Role              *string `json:"role"`
		QuotaBytes        *int64  `json:"quota_bytes"`
		Username          *string `json:"username"`
		Email             *string `json:"email"`
		Suspended         *bool   `json:"suspended"`
		Email2FAEnabled   *bool   `json:"email_2fa_enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Email != nil {
		email := strings.TrimSpace(*req.Email)
		if email == "" || !strings.Contains(email, "@") {
			writeError(w, "invalid email address", http.StatusBadRequest)
			return
		}
		existing, err := h.userRepo.GetByEmail(r.Context(), email)
		if err != nil {
			writeError(w, "failed to validate email", http.StatusInternalServerError)
			return
		}
		if existing != nil && existing.ID != userID {
			writeError(w, "email already in use", http.StatusConflict)
			return
		}
		user.Email = email
	}
	if req.Role != nil {
		user.Role = domain.Role(*req.Role)
	}
	if req.QuotaBytes != nil {
		user.QuotaBytes = *req.QuotaBytes
	}
	if req.Username != nil {
		user.Username = *req.Username
	}
	if req.Suspended != nil {
		user.Suspended = *req.Suspended
		if user.Suspended {
			_ = h.authService.RevokeAllUserSessions(r.Context(), user.ID)
		}
	}
	if req.Email2FAEnabled != nil {
		if !*req.Email2FAEnabled && adminsettings.Require2FA() {
			writeError(w, "cannot disable two-factor authentication while it is required globally", http.StatusBadRequest)
			return
		}
		user.Email2FAEnabled = *req.Email2FAEnabled
	}

	if err := h.userRepo.Update(r.Context(), user); err != nil {
		writeError(w, "failed to update user", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, user)
}

// Send2FAReminder handles POST /api/v1/admin/users/send-2fa-reminder
func (h *AdminHandler) Send2FAReminder(w http.ResponseWriter, r *http.Request) {
	if !adminsettings.SMTPConfigured() {
		writeError(w, "SMTP is not configured", http.StatusBadRequest)
		return
	}
	if adminsettings.Require2FA() {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"sent":    0,
			"message": "two-factor authentication is already required for everyone",
		})
		return
	}

	users, err := h.userRepo.List(r.Context())
	if err != nil {
		writeError(w, "failed to list users", http.StatusInternalServerError)
		return
	}

	sent := 0
	for _, user := range users {
		if user.Suspended || user.Email2FAEnabled || strings.TrimSpace(user.Email) == "" {
			continue
		}
		subject := "Enable two-factor authentication on FreeDrive"
		body := fmt.Sprintf(
			"Hello %s,\n\nYour FreeDrive administrator recommends enabling email two-factor authentication for your account.\n\nSign in to FreeDrive, open Security from your profile menu, and turn on email two-factor authentication.\n",
			chooseReminderName(user.Username, user.Email),
		)
		if err := email.SendFromSettings(user.Email, subject, body); err != nil {
			continue
		}
		sent++
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"sent": sent,
	})
}

func chooseReminderName(username, email string) string {
	if strings.TrimSpace(username) != "" {
		return username
	}
	return email
}

// RevokeUserSessions handles POST /api/v1/admin/users/{id}/revoke-sessions
func (h *AdminHandler) RevokeUserSessions(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "id")
	if userID == "" {
		writeError(w, "user id required", http.StatusBadRequest)
		return
	}
	if err := h.authService.RevokeAllUserSessions(r.Context(), userID); err != nil {
		writeError(w, "failed to revoke sessions", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// RevokeAllSessions handles POST /api/v1/admin/sessions/revoke-all
func (h *AdminHandler) RevokeAllSessions(w http.ResponseWriter, r *http.Request) {
	if err := h.authService.RevokeAllSessions(r.Context()); err != nil {
		writeError(w, "failed to revoke sessions", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DeleteInvite handles DELETE /api/v1/admin/invites/{id}
func (h *AdminHandler) DeleteInvite(w http.ResponseWriter, r *http.Request) {
	inviteID := chi.URLParam(r, "id")
	if inviteID == "" {
		writeError(w, "invite id required", http.StatusBadRequest)
		return
	}
	if err := h.userRepo.DeleteInvite(r.Context(), inviteID); err != nil {
		writeError(w, "failed to delete invite", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DeleteUser handles DELETE /api/v1/admin/users/{id}
func (h *AdminHandler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "id")
	currentUserID := middleware.GetUserID(r.Context())

	if userID == currentUserID {
		writeError(w, "cannot delete yourself", http.StatusBadRequest)
		return
	}

	target, err := h.userRepo.GetByID(r.Context(), userID)
	if err != nil {
		writeError(w, "failed to load user", http.StatusInternalServerError)
		return
	}
	if target == nil {
		writeError(w, "user not found", http.StatusNotFound)
		return
	}

	var blobPaths []string
	if h.fileRepo != nil {
		blobPaths, err = h.fileRepo.ListBlobPathsByOwner(r.Context(), userID)
		if err != nil {
			writeError(w, "failed to list user files", http.StatusInternalServerError)
			return
		}
	}

	if err := h.userRepo.Delete(r.Context(), userID); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}

	if h.diskStorage != nil {
		for _, p := range blobPaths {
			_ = h.diskStorage.Delete(p)
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "user deleted"})
}

// Stats handles GET /api/v1/admin/stats
func (h *AdminHandler) Stats(w http.ResponseWriter, r *http.Request) {
	userCount, _ := h.userRepo.Count(r.Context())
	users, _ := h.userRepo.List(r.Context())

	var totalUsed, totalQuota int64
	for _, u := range users {
		totalUsed += u.UsedBytes
		totalQuota += u.QuotaBytes
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"total_users": userCount,
		"total_used":  totalUsed,
		"total_quota": totalQuota,
		"users":       users,
	})
}

// CreateInvite handles POST /api/v1/admin/invites
func (h *AdminHandler) CreateInvite(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	var req struct {
		MaxUses    int    `json:"max_uses"`
		Role       string `json:"role"`
		QuotaBytes int64  `json:"quota_bytes"`
		Email      string `json:"email"`
		Message    string `json:"message"`
		SMTPServer string `json:"smtp_server"`
		SMTPPort   int    `json:"smtp_port"`
		SMTPUser   string `json:"smtp_user"`
		SMTPPass   string `json:"smtp_pass"`
		FromAddr   string `json:"from_address"`
		FromName   string `json:"from_name"`
		TLS        bool   `json:"tls"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Role == "" {
		req.Role = "user"
	}
	if req.MaxUses == 0 {
		req.MaxUses = 1
	}
	if req.QuotaBytes <= 0 {
		req.QuotaBytes = 10737418240 // 10 GB default
	}

	// Generate random invite code
	code := generateRandomString(8)
	inviteEmail := strings.ToLower(strings.TrimSpace(req.Email))
	invite := &domain.InviteLink{
		Code:       code,
		CreatedBy:  userID,
		Email:      inviteEmail,
		Role:       domain.Role(req.Role),
		QuotaBytes: req.QuotaBytes,
		MaxUses:    req.MaxUses,
	}

	if err := h.userRepo.CreateInvite(r.Context(), invite); err != nil {
		writeError(w, "failed to create invite", http.StatusInternalServerError)
		return
	}

	recipient := inviteEmail
	adminSettingsMu.RLock()
	emailCfg, _ := adminSettings["email"].(map[string]interface{})
	generalCfg, _ := adminSettings["general"].(map[string]interface{})
	smtpServer := asString(emailCfg["smtp_server"])
	smtpPort := asInt(emailCfg["smtp_port"], 0)
	smtpUser := asString(emailCfg["smtp_user"])
	smtpPass := asString(emailCfg["smtp_pass"])
	fromAddress := asString(emailCfg["from_address"])
	fromName := asString(emailCfg["from_name"])
	useTLS := asBool(emailCfg["tls"], false)
	siteURL := strings.TrimSpace(asString(generalCfg["site_url"]))
	adminSettingsMu.RUnlock()

	if strings.TrimSpace(req.SMTPServer) != "" {
		smtpServer = strings.TrimSpace(req.SMTPServer)
	}
	if req.SMTPPort > 0 {
		smtpPort = req.SMTPPort
	}
	if req.SMTPUser != "" || req.SMTPPass != "" {
		smtpUser = req.SMTPUser
		smtpPass = req.SMTPPass
	}
	if strings.TrimSpace(req.FromAddr) != "" {
		fromAddress = strings.TrimSpace(req.FromAddr)
	}
	if strings.TrimSpace(req.FromName) != "" {
		fromName = strings.TrimSpace(req.FromName)
	}
	useTLS = req.TLS

	siteURL = siteBaseURL(siteURL, r)
	inviteURL := fmt.Sprintf("%s?invite=%s", siteURL, url.QueryEscape(invite.Code))
	if inviteEmail != "" {
		inviteURL = fmt.Sprintf("%s&email=%s", inviteURL, url.QueryEscape(inviteEmail))
	}

	emailSent := false
	emailError := ""
	if recipient != "" {
		if smtpServer == "" || smtpPort == 0 || fromAddress == "" {
			emailError = "smtp settings are incomplete: set server, port and from address in admin settings"
		} else {
			displayName := chooseDisplayName("", recipient)
			subject := "You're invited to FreeDrive"
			message := strings.TrimSpace(req.Message)

			body := fmt.Sprintf(
				"Hello %s,\n\nYou've been invited to join FreeDrive.\n\nInvite link:\n%s\n\nSign in email (required): %s\nRole: %s\nQuota: %.1f GB\n",
				displayName,
				inviteURL,
				inviteEmail,
				strings.ToUpper(string(invite.Role)),
				float64(invite.QuotaBytes)/(1024*1024*1024),
			)
			if message != "" {
				body += fmt.Sprintf("\nMessage from admin:\n%s\n", message)
			}
			body += "\nUse the email address above when creating your account and when signing in.\nIf the link does not open automatically, copy and paste it into your browser.\n"

			emailSent = true // Assume success for fast response
			go func() {
				cfg := smtpConfig(smtpServer, smtpPort, smtpUser, smtpPass, fromAddress, fromName, useTLS)
				if err := email.Send(cfg, recipient, subject, body); err != nil {
					fmt.Fprintf(os.Stderr, "failed to send invite email to %s: %v\n", recipient, err)
				}
			}()
		}
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"id":          invite.ID,
		"code":        invite.Code,
		"created_by":  invite.CreatedBy,
		"email":       invite.Email,
		"role":        invite.Role,
		"quota_bytes": invite.QuotaBytes,
		"max_uses":    invite.MaxUses,
		"used_count":  invite.UsedCount,
		"expires_at":  invite.ExpiresAt,
		"created_at":  invite.CreatedAt,
		"invite_url":  inviteURL,
		"email_sent":  emailSent,
		"email_error": emailError,
	})
}

// ResendInvite handles POST /api/v1/admin/invites/resend
func (h *AdminHandler) ResendInvite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email      string `json:"email"`
		Code       string `json:"code"`
		Role       string `json:"role"`
		QuotaBytes int64  `json:"quota_bytes"`
		Message    string `json:"message"`
		SMTPServer string `json:"smtp_server"`
		SMTPPort   int    `json:"smtp_port"`
		SMTPUser   string `json:"smtp_user"`
		SMTPPass   string `json:"smtp_pass"`
		FromAddr   string `json:"from_address"`
		FromName   string `json:"from_name"`
		TLS        bool   `json:"tls"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	recipient := strings.TrimSpace(req.Email)
	code := strings.TrimSpace(req.Code)
	if recipient == "" || code == "" {
		writeError(w, "email and invite code are required", http.StatusBadRequest)
		return
	}

	adminSettingsMu.RLock()
	emailCfg, _ := adminSettings["email"].(map[string]interface{})
	generalCfg, _ := adminSettings["general"].(map[string]interface{})
	smtpServer := asString(emailCfg["smtp_server"])
	smtpPort := asInt(emailCfg["smtp_port"], 0)
	smtpUser := asString(emailCfg["smtp_user"])
	smtpPass := asString(emailCfg["smtp_pass"])
	fromAddress := asString(emailCfg["from_address"])
	fromName := asString(emailCfg["from_name"])
	useTLS := asBool(emailCfg["tls"], false)
	siteURL := strings.TrimSpace(asString(generalCfg["site_url"]))
	adminSettingsMu.RUnlock()

	if strings.TrimSpace(req.SMTPServer) != "" {
		smtpServer = strings.TrimSpace(req.SMTPServer)
	}
	if req.SMTPPort > 0 {
		smtpPort = req.SMTPPort
	}
	if req.SMTPUser != "" || req.SMTPPass != "" {
		smtpUser = req.SMTPUser
		smtpPass = req.SMTPPass
	}
	if strings.TrimSpace(req.FromAddr) != "" {
		fromAddress = strings.TrimSpace(req.FromAddr)
	}
	if strings.TrimSpace(req.FromName) != "" {
		fromName = strings.TrimSpace(req.FromName)
	}
	useTLS = req.TLS

	if smtpServer == "" || smtpPort == 0 || fromAddress == "" {
		writeError(w, "smtp settings are incomplete: set server, port and from address in admin settings", http.StatusBadRequest)
		return
	}

	siteURL = siteBaseURL(siteURL, r)

	inviteURL := fmt.Sprintf("%s?invite=%s", siteURL, url.QueryEscape(code))
	recipientEmail := strings.ToLower(recipient)
	if recipientEmail != "" {
		inviteURL = fmt.Sprintf("%s&email=%s", inviteURL, url.QueryEscape(recipientEmail))
	}
	role := strings.TrimSpace(req.Role)
	if role == "" {
		role = "user"
	}
	quota := req.QuotaBytes
	if quota <= 0 {
		quota = 10737418240
	}
	subject := "FreeDrive Invite Link (Resent)"
	body := fmt.Sprintf(
		"Hello %s,\n\nYour FreeDrive invite link has been resent.\n\nInvite link:\n%s\n\nSign in email (required): %s\nRole: %s\nQuota: %.1f GB\n",
		chooseDisplayName("", recipient),
		inviteURL,
		recipientEmail,
		strings.ToUpper(role),
		float64(quota)/(1024*1024*1024),
	)
	if strings.TrimSpace(req.Message) != "" {
		body += fmt.Sprintf("\nMessage from admin:\n%s\n", strings.TrimSpace(req.Message))
	}
	body += "\nUse the email address above when creating your account and when signing in.\nIf the link does not open automatically, copy and paste it into your browser.\n"

	go func() {
		cfg := smtpConfig(smtpServer, smtpPort, smtpUser, smtpPass, fromAddress, fromName, useTLS)
		if err := email.Send(cfg, recipient, subject, body); err != nil {
			fmt.Fprintf(os.Stderr, "failed to resend invite email to %s: %v\n", recipient, err)
		}
	}()

	writeJSON(w, http.StatusOK, map[string]string{"status": "success", "message": "Invite email resent in background"})
}

// ListInvites handles GET /api/v1/admin/invites
func (h *AdminHandler) ListInvites(w http.ResponseWriter, r *http.Request) {
	invites, err := h.userRepo.ListInvites(r.Context())
	if err != nil {
		writeError(w, "failed to list invites", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"invites": invites})
}

// Activity handles GET /api/v1/admin/activity (authentication events only).
func (h *AdminHandler) Activity(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))

	logs, total, err := h.activityRepo.ListAllAuth(r.Context(), page, pageSize)
	if err != nil {
		log.Printf("activity list error (ListAllAuth): %v", err)
		writeError(w, "failed to list activity", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"activities": logs,
		"total":      total,
	})
}

// MyActivity handles GET /api/v1/activity (current authenticated user only).
func (h *AdminHandler) MyActivity(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if strings.TrimSpace(userID) == "" {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))

	logs, total, err := h.activityRepo.List(r.Context(), userID, page, pageSize)
	if err != nil {
		log.Printf("activity list error (List user=%s): %v", userID, err)
		writeError(w, "failed to list activity", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"activities": logs,
		"total":      total,
	})
}

// GetSettings handles GET /api/v1/admin/settings
func (h *AdminHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	adminSettingsMu.RLock()
	defer adminSettingsMu.RUnlock()
	writeJSON(w, http.StatusOK, adminSettings)
}

// SaveSettings handles POST /api/v1/admin/settings
func (h *AdminHandler) SaveSettings(w http.ResponseWriter, r *http.Request) {
	var payload map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	adminSettingsMu.Lock()
	for k, v := range payload {
		adminSettings[k] = v
	}
	adminSettingsMu.Unlock()
	saveSettings()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// RunBackupNow handles POST /api/v1/admin/backup/run
func (h *AdminHandler) RunBackupNow(w http.ResponseWriter, r *http.Request) {
	fullPath, err := adminsettings.RunSettingsBackup()
	if err != nil {
		writeError(w, "failed to create backup: "+err.Error(), http.StatusInternalServerError)
		return
	}

	info, err := os.Stat(fullPath)
	if err != nil {
		writeError(w, "backup created but could not be read", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":   "success",
		"at":       time.Now().UTC().Format(time.RFC3339),
		"size":     formatBytes(info.Size()),
		"filename": filepath.Base(fullPath),
		"path":     fullPath,
	})
}

// SendPasswordReset handles POST /api/v1/admin/users/{id}/reset-password
func (h *AdminHandler) SendPasswordReset(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "id")
	user, err := h.userRepo.GetByID(r.Context(), userID)
	if err != nil || user == nil {
		writeError(w, "user not found", http.StatusNotFound)
		return
	}
	if strings.TrimSpace(user.Email) == "" {
		writeError(w, "target user has no email address", http.StatusBadRequest)
		return
	}

	adminSettingsMu.RLock()
	emailCfg, _ := adminSettings["email"].(map[string]interface{})
	generalCfg, _ := adminSettings["general"].(map[string]interface{})
	smtpServer := asString(emailCfg["smtp_server"])
	smtpPort := asInt(emailCfg["smtp_port"], 0)
	smtpUser := asString(emailCfg["smtp_user"])
	smtpPass := asString(emailCfg["smtp_pass"])
	fromAddress := asString(emailCfg["from_address"])
	fromName := asString(emailCfg["from_name"])
	useTLS := asBool(emailCfg["tls"], false)
	siteURL := strings.TrimSpace(asString(generalCfg["site_url"]))
	adminSettingsMu.RUnlock()

	if smtpServer == "" || smtpPort == 0 || fromAddress == "" {
		writeError(w, "smtp settings are incomplete: set server, port and from address in admin settings", http.StatusBadRequest)
		return
	}

	siteURL = siteBaseURL(siteURL, r)

	token, err := h.passwordResetService.CreateResetLink(r.Context(), user.Email)
	if err != nil {
		writeError(w, "failed to create reset token", http.StatusInternalServerError)
		return
	}
	resetURL := fmt.Sprintf("%s/reset-password?token=%s&email=%s", siteURL, token, url.QueryEscape(user.Email))
	subject := "FreeDrive Password Reset"
	body := fmt.Sprintf(
		"Hello %s,\n\nA password reset was requested for your FreeDrive account.\n\nReset link:\n%s\n\nIf you did not request this, you can ignore this email.\n",
		chooseDisplayName(user.Username, user.Email),
		resetURL,
	)

	go func() {
		cfg := smtpConfig(smtpServer, smtpPort, smtpUser, smtpPass, fromAddress, fromName, useTLS)
		if err := email.Send(cfg, user.Email, subject, body); err != nil {
			fmt.Fprintf(os.Stderr, "failed to send reset email to %s: %v\n", user.Email, err)
		}
	}()

	writeJSON(w, http.StatusOK, map[string]string{"status": "success", "message": "Password reset email sent in background"})
}

// TestEmail handles POST /api/v1/admin/test-email
func (h *AdminHandler) TestEmail(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ToAddress   string `json:"to_address"`
		SMTPServer  string `json:"smtp_server"`
		SMTPPort    int    `json:"smtp_port"`
		SMTPUser    string `json:"smtp_user"`
		SMTPPass    string `json:"smtp_pass"`
		FromAddress string `json:"from_address"`
		FromName    string `json:"from_name"`
		TLS         bool   `json:"tls"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.ToAddress == "" || req.SMTPServer == "" || req.SMTPPort == 0 || req.FromAddress == "" {
		writeError(w, "missing required email fields", http.StatusBadRequest)
		return
	}

	cfg := smtpConfig(req.SMTPServer, req.SMTPPort, req.SMTPUser, req.SMTPPass, req.FromAddress, req.FromName, req.TLS)
	if err := email.Send(
		cfg,
		req.ToAddress,
		"FreeDrive Test Email",
		"This is a test email sent from your FreeDrive Admin Panel.\nIf you received this, your SMTP configuration is correct!\n",
	); err != nil {
		writeError(w, "failed to send email: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "success", "message": "Email sent successfully"})
}

func smtpConfig(server string, port int, user, pass, fromAddr, fromName string, useTLS bool) adminsettings.SMTPConfig {
	return adminsettings.SMTPConfig{
		Server:      server,
		Port:        port,
		User:        user,
		Pass:        pass,
		FromAddress: fromAddr,
		FromName:    fromName,
		TLS:         useTLS,
	}
}

func asString(v interface{}) string {
	switch x := v.(type) {
	case string:
		return x
	default:
		return ""
	}
}

func siteBaseURL(raw string, r *http.Request) string {
	raw = strings.TrimSpace(raw)
	if raw != "" {
		if u, err := url.Parse(raw); err == nil && u.Scheme != "" && u.Host != "" {
			return strings.TrimRight(fmt.Sprintf("%s://%s", u.Scheme, u.Host), "/")
		}
	}

	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return strings.TrimRight(fmt.Sprintf("%s://%s", scheme, r.Host), "/")
}

func asInt(v interface{}, fallback int) int {
	switch x := v.(type) {
	case float64:
		return int(x)
	case int:
		return x
	case int64:
		return int(x)
	case string:
		i, err := strconv.Atoi(strings.TrimSpace(x))
		if err == nil {
			return i
		}
	}
	return fallback
}

func asBool(v interface{}, fallback bool) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		s := strings.ToLower(strings.TrimSpace(x))
		return s == "1" || s == "true" || s == "yes" || s == "on"
	default:
		return fallback
	}
}

func chooseDisplayName(username, email string) string {
	if strings.TrimSpace(username) != "" {
		return username
	}
	return email
}

func formatBytes(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	kb := float64(n) / 1024
	if kb < 1024 {
		return fmt.Sprintf("%.1f KB", kb)
	}
	mb := kb / 1024
	if mb < 1024 {
		return fmt.Sprintf("%.1f MB", mb)
	}
	gb := mb / 1024
	return fmt.Sprintf("%.2f GB", gb)
}
