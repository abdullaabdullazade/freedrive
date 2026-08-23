package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/service"
)

type contextKey string

const (
	UserIDKey    contextKey = "user_id"
	UserRoleKey  contextKey = "user_role"
	UserEmailKey contextKey = "user_email"
	UsernameKey  contextKey = "username"
	SessionIDKey contextKey = "session_id"
)

// Auth returns middleware that validates JWT tokens and active sessions.
func Auth(authService *service.AuthService) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if header == "" {
				http.Error(w, `{"error":"missing authorization header"}`, http.StatusUnauthorized)
				return
			}

			parts := strings.SplitN(header, " ", 2)
			if len(parts) != 2 || parts[0] != "Bearer" {
				http.Error(w, `{"error":"invalid authorization format"}`, http.StatusUnauthorized)
				return
			}

			claims, err := authService.ValidateAccessToken(parts[1])
			if err != nil {
				http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
				return
			}

			user, err := authService.ValidateSession(r.Context(), claims.SessionID, claims.UserID)
			if err != nil {
				http.Error(w, `{"error":"session expired"}`, http.StatusUnauthorized)
				return
			}

			deviceType := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Device-Type")))
			if deviceType == domain.DeviceTypeMobile {
				authService.SyncSessionDeviceMeta(r.Context(), claims.SessionID, service.DeviceInfo{
					DeviceType: domain.DeviceTypeMobile,
					DeviceName: strings.TrimSpace(r.Header.Get("X-Device-Name")),
				})
			}

			ctx := context.WithValue(r.Context(), UserIDKey, user.ID)
			ctx = context.WithValue(ctx, UserRoleKey, user.Role)
			ctx = context.WithValue(ctx, UserEmailKey, user.Email)
			ctx = context.WithValue(ctx, UsernameKey, user.Username)
			ctx = context.WithValue(ctx, SessionIDKey, claims.SessionID)

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireAdmin returns middleware that restricts access to admin users.
func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		role, ok := r.Context().Value(UserRoleKey).(domain.Role)
		if !ok || role != domain.RoleAdmin {
			http.Error(w, `{"error":"admin access required"}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// GetUserID extracts the user ID from the request context.
func GetUserID(ctx context.Context) string {
	if v, ok := ctx.Value(UserIDKey).(string); ok {
		return v
	}
	return ""
}

// GetUserRole extracts the user role from the request context.
func GetUserRole(ctx context.Context) domain.Role {
	if v, ok := ctx.Value(UserRoleKey).(domain.Role); ok {
		return v
	}
	return ""
}

// GetSessionID extracts the session ID from the request context.
func GetSessionID(ctx context.Context) string {
	if v, ok := ctx.Value(SessionIDKey).(string); ok {
		return v
	}
	return ""
}
