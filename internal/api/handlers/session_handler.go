package handlers

import (
	"net/http"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/service"
	"github.com/go-chi/chi/v5"
)

// SessionHandler serves the logged-in devices API.
type SessionHandler struct {
	authService *service.AuthService
}

// NewSessionHandler creates a session handler.
func NewSessionHandler(authService *service.AuthService) *SessionHandler {
	return &SessionHandler{authService: authService}
}

type sessionView struct {
	ID         string    `json:"id"`
	DeviceName string    `json:"device_name"`
	DeviceType string    `json:"device_type"`
	IPAddress  string    `json:"ip_address"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
	Current    bool      `json:"current"`
}

// List handles GET /api/v1/auth/sessions
func (h *SessionHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	currentID := middleware.GetSessionID(r.Context())
	sessions, err := h.authService.ListSessions(r.Context(), userID)
	if err != nil {
		writeError(w, "failed to list sessions", http.StatusInternalServerError)
		return
	}

	out := make([]sessionView, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, sessionView{
			ID:         s.ID,
			DeviceName: s.DeviceName,
			DeviceType: s.DeviceType,
			IPAddress:  s.IPAddress,
			CreatedAt:  s.CreatedAt,
			LastSeenAt: s.LastSeenAt,
			Current:    s.ID == currentID,
		})
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"sessions": out})
}

// Revoke handles DELETE /api/v1/auth/sessions/{id}
func (h *SessionHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	sessionID := chi.URLParam(r, "id")
	if sessionID == "" {
		writeError(w, "session id required", http.StatusBadRequest)
		return
	}
	if err := h.authService.RevokeSession(r.Context(), userID, sessionID); err != nil {
		writeError(w, "failed to revoke session", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// RevokeOthers handles POST /api/v1/auth/sessions/revoke-others
func (h *SessionHandler) RevokeOthers(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	currentID := middleware.GetSessionID(r.Context())
	if err := h.authService.RevokeOtherSessions(r.Context(), userID, currentID); err != nil {
		writeError(w, "failed to revoke sessions", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
