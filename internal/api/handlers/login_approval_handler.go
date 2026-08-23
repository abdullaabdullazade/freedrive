package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/service"
	"github.com/go-chi/chi/v5"
)

// LoginApprovalHandler serves phone sign-in prompts and push-token registration.
type LoginApprovalHandler struct {
	svc *service.LoginApprovalService
}

func NewLoginApprovalHandler(svc *service.LoginApprovalService) *LoginApprovalHandler {
	return &LoginApprovalHandler{svc: svc}
}

// Poll handles GET /api/v1/auth/login-approval/{id}?token=
func (h *LoginApprovalHandler) Poll(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		token = strings.TrimSpace(r.Header.Get("X-Login-Approval-Token"))
	}
	a, tokens, user, err := h.svc.PublicView(r.Context(), id, token)
	if err == service.ErrLoginApprovalPending {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":              domain.LoginApprovalPending,
			"pending_device_name": a.PendingDeviceName,
			"expires_at":          a.ExpiresAt,
		})
		return
	}
	if err == service.ErrLoginApprovalDenied {
		writeJSON(w, http.StatusOK, map[string]interface{}{"status": domain.LoginApprovalDenied})
		return
	}
	if err == service.ErrLoginApprovalExpired {
		writeJSON(w, http.StatusOK, map[string]interface{}{"status": domain.LoginApprovalExpired})
		return
	}
	if err != nil {
		writeError(w, "login approval not found", http.StatusNotFound)
		return
	}
	if user != nil {
		user.TwoFactorRequired = adminsettings.Require2FA()
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status": domain.LoginApprovalApproved,
		"tokens": tokens,
		"user":   user,
	})
}

// Get handles GET /api/v1/auth/login-approval/{id}/details (authenticated approver).
func (h *LoginApprovalHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	a, err := h.svc.GetForApprover(r.Context(), chi.URLParam(r, "id"), userID)
	if err != nil {
		writeError(w, "login approval not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"id":                  a.ID,
		"status":              a.Status,
		"pending_device_name": a.PendingDeviceName,
		"pending_device_type": a.PendingDeviceType,
		"ip_address":          a.IPAddress,
		"expires_at":          a.ExpiresAt,
		"created_at":          a.CreatedAt,
	})
}

// Approve handles POST /api/v1/auth/login-approval/{id}/approve
func (h *LoginApprovalHandler) Approve(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	a, err := h.svc.Approve(r.Context(), chi.URLParam(r, "id"), userID)
	if err == service.ErrLoginApprovalExpired {
		writeError(w, "login approval expired", http.StatusGone)
		return
	}
	if err != nil {
		writeError(w, "login approval not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  a.Status,
		"message": "approved",
	})
}

// Deny handles POST /api/v1/auth/login-approval/{id}/deny
func (h *LoginApprovalHandler) Deny(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	a, err := h.svc.Deny(r.Context(), chi.URLParam(r, "id"), userID)
	if err != nil {
		writeError(w, "login approval not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  a.Status,
		"message": "denied",
	})
}

// ListPending handles GET /api/v1/me/login-approvals/pending
func (h *LoginApprovalHandler) ListPending(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	list, err := h.svc.ListPendingForUser(r.Context(), userID)
	if err != nil {
		writeError(w, "failed to list login approvals", http.StatusInternalServerError)
		return
	}
	out := make([]map[string]interface{}, 0, len(list))
	for _, a := range list {
		out = append(out, map[string]interface{}{
			"id":                  a.ID,
			"status":              a.Status,
			"pending_device_name": a.PendingDeviceName,
			"pending_device_type": a.PendingDeviceType,
			"ip_address":          a.IPAddress,
			"expires_at":          a.ExpiresAt,
			"created_at":          a.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"approvals": out})
}

// Status handles GET /api/v1/me/login-approval/status
func (h *LoginApprovalHandler) Status(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	user, err := h.svc.UserByID(r.Context(), userID)
	if err != nil || user == nil {
		writeError(w, "user not found", http.StatusNotFound)
		return
	}
	enabled, hasTrusted, err := h.svc.TrustedMobileStatus(r.Context(), user)
	if err != nil {
		writeError(w, "failed to load login approval status", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"enabled":            enabled,
		"has_trusted_mobile": hasTrusted,
	})
}

// RegisterPushToken handles POST /api/v1/me/push-token
func (h *LoginApprovalHandler) RegisterPushToken(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	var req struct {
		ExpoPushToken string `json:"expo_push_token"`
		Platform      string `json:"platform"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	device := deviceInfoFromRequest(r)
	if err := h.svc.RegisterPushToken(r.Context(), userID, device.DeviceID, req.ExpoPushToken, req.Platform); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "registered"})
}

// UnregisterPushToken handles DELETE /api/v1/me/push-token
func (h *LoginApprovalHandler) UnregisterPushToken(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	var req struct {
		ExpoPushToken string `json:"expo_push_token"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	device := deviceInfoFromRequest(r)
	if err := h.svc.UnregisterPushToken(r.Context(), userID, device.DeviceID, req.ExpoPushToken); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "unregistered"})
}
