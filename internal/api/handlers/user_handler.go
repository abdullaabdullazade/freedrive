package handlers

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
	"github.com/abdullaabdullazade/freedrive/internal/service"
)

// Max avatar data-URL length (~500 KB of base64 payload + header).
const maxAvatarURLLen = 700_000

// UserHandler handles user-specific endpoints.
type UserHandler struct {
	userRepo        repository.UserRepository
	fileRepo        repository.FileRepository
	emailChangeRepo repository.EmailChangeRepository
	authService     *service.AuthService
}

// NewUserHandler creates a new user handler.
func NewUserHandler(
	userRepo repository.UserRepository,
	fileRepo repository.FileRepository,
	emailChangeRepo repository.EmailChangeRepository,
	authService *service.AuthService,
) *UserHandler {
	return &UserHandler{
		userRepo:        userRepo,
		fileRepo:        fileRepo,
		emailChangeRepo: emailChangeRepo,
		authService:     authService,
	}
}

// GetMe handles GET /api/v1/me — returns the current authenticated user.
func (h *UserHandler) GetMe(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	user, err := h.userRepo.GetByID(r.Context(), userID)
	if err != nil || user == nil {
		writeError(w, "user not found", http.StatusNotFound)
		return
	}

	user.TwoFactorRequired = adminsettings.Require2FA()
	writeJSON(w, http.StatusOK, user)
}

// UpdateMe handles PATCH /api/v1/me — updates username and/or avatar for the current user.
func (h *UserHandler) UpdateMe(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	user, err := h.userRepo.GetByID(r.Context(), userID)
	if err != nil || user == nil {
		writeError(w, "user not found", http.StatusNotFound)
		return
	}

	var req struct {
		Username          *string `json:"username"`
		AvatarURL         *string `json:"avatar_url"`
		Email2FAEnabled   *bool   `json:"email_2fa_enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Username != nil {
		name := strings.TrimSpace(*req.Username)
		if name == "" {
			writeError(w, "username cannot be empty", http.StatusBadRequest)
			return
		}
		if len(name) > 120 {
			writeError(w, "username is too long", http.StatusBadRequest)
			return
		}
		user.Username = name
	}

	if req.AvatarURL != nil {
		avatar := strings.TrimSpace(*req.AvatarURL)
		if avatar == "" {
			user.AvatarURL = ""
		} else {
			if len(avatar) > maxAvatarURLLen {
				writeError(w, "avatar is too large", http.StatusBadRequest)
				return
			}
			if !strings.HasPrefix(avatar, "data:image/") {
				writeError(w, "avatar must be a data:image URL", http.StatusBadRequest)
				return
			}
			user.AvatarURL = avatar
		}
	}

	if req.Email2FAEnabled != nil {
		if err := service.CanSetEmail2FA(*req.Email2FAEnabled); err != nil {
			writeError(w, "two-factor authentication is required by administrator", http.StatusForbidden)
			return
		}
		user.Email2FAEnabled = *req.Email2FAEnabled
	}

	user.UpdatedAt = time.Now()
	if err := h.userRepo.Update(r.Context(), user); err != nil {
		writeError(w, "failed to update profile", http.StatusInternalServerError)
		return
	}

	user.TwoFactorRequired = adminsettings.Require2FA()
	writeJSON(w, http.StatusOK, user)
}

// MyStorage handles GET /api/v1/me/storage — returns the current user's quota and usage.
func (h *UserHandler) MyStorage(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	user, err := h.userRepo.GetByID(r.Context(), userID)
	if err != nil || user == nil {
		writeError(w, "user not found", http.StatusNotFound)
		return
	}

	// Compute real usage from the files table so the value is accurate even if
	// the tracked used_bytes counter has drifted; reconcile it when different.
	used, err := h.fileRepo.SumEncryptedSizeByOwner(r.Context(), userID)
	if err != nil {
		used = user.UsedBytes
	} else if used != user.UsedBytes {
		_ = h.userRepo.UpdateUsedBytes(r.Context(), userID, used-user.UsedBytes)
	}

	// Break usage down by category over the same (non-trashed) file set so the
	// four buckets add up exactly to used_bytes.
	breakdown := map[string]int64{"images": 0, "videos": 0, "documents": 0, "other": 0}
	fileCount := 0
	if metas, err := h.fileRepo.ListFileMetaByOwner(r.Context(), userID); err == nil {
		fileCount = len(metas)
		for _, m := range metas {
			breakdown[storageCategory(m.MimeType, m.Name)] += m.EncryptedSize
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"used_bytes":  used,
		"total_bytes": user.QuotaBytes,
		"free_bytes":  user.QuotaBytes - used,
		"breakdown":   breakdown,
		"file_count":  fileCount,
	})
}

// storageCategory maps a file to one of four storage buckets (images, videos,
// documents, other) using both MIME type and extension. Mirrors the frontend
// getStorageCategory so the UI and backend agree. Unknown types (audio,
// archives, binaries, fonts, ...) fall into "other".
func storageCategory(mime, name string) string {
	mt := strings.ToLower(strings.TrimSpace(mime))
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))

	if strings.HasPrefix(mt, "image/") || imageExts[ext] {
		return "images"
	}
	if strings.HasPrefix(mt, "video/") || videoExts[ext] {
		return "videos"
	}
	if mt == "application/pdf" ||
		strings.HasPrefix(mt, "text/") ||
		strings.Contains(mt, "word") || strings.Contains(mt, "opendocument") ||
		strings.Contains(mt, "spreadsheet") || strings.Contains(mt, "ms-excel") || strings.Contains(mt, "spreadsheetml") ||
		strings.Contains(mt, "presentation") || strings.Contains(mt, "powerpoint") ||
		mt == "application/json" ||
		docExts[ext] {
		return "documents"
	}
	return "other"
}

func toSet(items []string) map[string]bool {
	s := make(map[string]bool, len(items))
	for _, it := range items {
		s[it] = true
	}
	return s
}

var (
	imageExts = toSet([]string{"jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "heic", "heif", "avif", "raw", "cr2", "nef", "arw", "dng", "psd"})
	videoExts = toSet([]string{"mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v", "mpg", "mpeg", "3gp", "ts", "m2ts", "ogv", "mts"})
	audioExts = toSet([]string{"mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus", "aiff", "aif", "mid", "midi"})
	archiveExts = toSet([]string{"zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "iso", "cab", "lz", "lzma"})
	docExts   = toSet([]string{
		"pdf", "doc", "docx", "odt", "rtf", "txt", "md", "markdown", "pages",
		"ppt", "pptx", "odp", "key",
		"xls", "xlsx", "ods", "csv", "tsv", "numbers",
		"json", "jsonc", "xml", "html", "htm", "css", "js", "ts", "jsx", "tsx",
		"py", "c", "cpp", "h", "hpp", "sh", "bash", "go", "java", "php", "rb", "swift",
		"ini", "cfg", "conf", "yml", "yaml", "toml", "log",
	})
)
