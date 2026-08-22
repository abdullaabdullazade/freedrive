package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
	"github.com/abdullaabdullazade/freedrive/internal/service"
	"github.com/abdullaabdullazade/freedrive/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const (
	uploadSessionTTL = 24 * time.Hour
	maxChunkBytes    = 9 << 20 // 8 MiB chunks + margin
)

var contentRangeRe = regexp.MustCompile(`(?i)^bytes\s+(\d+)-(\d+)/(\d+)$`)

// UploadHandler handles resumable chunked uploads.
type UploadHandler struct {
	sessions    repository.UploadSessionRepository
	fileRepo    repository.FileRepository
	userRepo    repository.UserRepository
	fileService *service.FileService
	disk        *storage.DiskStorage
	access      *service.AccessService
	maxUpload   int64
	dataDir     string
}

// NewUploadHandler creates an upload handler and starts expired-session cleanup.
func NewUploadHandler(
	sessions repository.UploadSessionRepository,
	fileRepo repository.FileRepository,
	userRepo repository.UserRepository,
	fileService *service.FileService,
	disk *storage.DiskStorage,
	access *service.AccessService,
	maxUpload int64,
	dataDir string,
) *UploadHandler {
	h := &UploadHandler{
		sessions:    sessions,
		fileRepo:    fileRepo,
		userRepo:    userRepo,
		fileService: fileService,
		disk:        disk,
		access:      access,
		maxUpload:   maxUpload,
		dataDir:     dataDir,
	}
	_ = os.MkdirAll(storage.UploadsDir(dataDir), 0755)
	go h.cleanupLoop()
	return h
}

func (h *UploadHandler) cleanupLoop() {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	h.cleanupExpired()
	for range ticker.C {
		h.cleanupExpired()
	}
}

func (h *UploadHandler) cleanupExpired() {
	expired, err := h.sessions.DeleteExpired(context.Background(), time.Now())
	if err != nil {
		return
	}
	for _, s := range expired {
		_ = os.Remove(s.TempPath)
	}
}

// CreateSession handles POST /api/v1/uploads/sessions
func (h *UploadHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	h.cleanupExpired()

	var req struct {
		Name           string  `json:"name"`
		MimeType       string  `json:"mime_type"`
		IV             string  `json:"iv"`
		OriginalSize   int64   `json:"original_size"`
		EncryptedSize  int64   `json:"encrypted_size"`
		FolderID       *string `json:"folder_id"`
		FileID         *string `json:"file_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, "name is required", http.StatusBadRequest)
		return
	}
	if req.EncryptedSize <= 0 {
		writeError(w, "encrypted_size must be positive", http.StatusBadRequest)
		return
	}
	maxBytes := adminsettings.EffectiveMaxUploadBytes(h.maxUpload)
	if req.EncryptedSize > maxBytes {
		writeError(w, "file too large", http.StatusBadRequest)
		return
	}
	if !adminsettings.AllowedTypesUnlimited() {
		if allowed := adminsettings.AllowedTypes(); len(allowed) > 0 {
			ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(req.Name), "."))
			if ext == "" || !containsString(allowed, ext) {
				writeError(w, "file type not allowed", http.StatusBadRequest)
				return
			}
		}
	}
	if req.MimeType == "" {
		req.MimeType = "application/octet-stream"
	}

	user, err := h.userRepo.GetByID(r.Context(), userID)
	if err != nil || user == nil {
		writeError(w, "user not found", http.StatusNotFound)
		return
	}

	var replaceFile *domain.File
	if req.FileID != nil && *req.FileID != "" {
		if err := h.access.CanWriteFile(r.Context(), *req.FileID, userID); err != nil {
			writeError(w, err.Error(), http.StatusForbidden)
			return
		}
		replaceFile, err = h.fileRepo.GetByID(r.Context(), *req.FileID)
		if err != nil || replaceFile == nil {
			writeError(w, "file not found", http.StatusNotFound)
			return
		}
		delta := req.EncryptedSize - replaceFile.EncryptedSize
		if user.UsedBytes+delta > user.QuotaBytes {
			writeError(w, "quota exceeded", http.StatusBadRequest)
			return
		}
	} else {
		if user.UsedBytes+req.EncryptedSize > user.QuotaBytes {
			writeError(w, "quota exceeded", http.StatusBadRequest)
			return
		}
	}

	sessionID := uuid.New().String()
	userUploadDir := filepath.Join(storage.UploadsDir(h.dataDir), userID)
	if err := os.MkdirAll(userUploadDir, 0755); err != nil {
		writeError(w, "failed to prepare upload", http.StatusInternalServerError)
		return
	}
	tempPath := filepath.Join(userUploadDir, sessionID+".part")
	f, err := os.Create(tempPath)
	if err != nil {
		writeError(w, "failed to prepare upload", http.StatusInternalServerError)
		return
	}
	_ = f.Close()

	now := time.Now()
	session := &domain.UploadSession{
		ID:            sessionID,
		UserID:        userID,
		FileID:        req.FileID,
		Name:          req.Name,
		MimeType:      req.MimeType,
		IV:            req.IV,
		OriginalSize:  req.OriginalSize,
		EncryptedSize: req.EncryptedSize,
		FolderID:      req.FolderID,
		TempPath:      tempPath,
		ReceivedBytes: 0,
		CreatedAt:     now,
		ExpiresAt:     now.Add(uploadSessionTTL),
	}
	if err := h.sessions.Create(r.Context(), session); err != nil {
		_ = os.Remove(tempPath)
		writeError(w, "failed to create session", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"id":              session.ID,
		"encrypted_size":  session.EncryptedSize,
		"received_bytes":  session.ReceivedBytes,
		"expires_at":      session.ExpiresAt,
		"chunk_size_hint": 8 << 20,
	})
}

// GetSession handles GET /api/v1/uploads/sessions/{id}
func (h *UploadHandler) GetSession(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	session, ok := h.loadOwnedSession(w, r, userID)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"id":             session.ID,
		"encrypted_size": session.EncryptedSize,
		"received_bytes": session.ReceivedBytes,
		"expires_at":     session.ExpiresAt,
		"name":           session.Name,
	})
}

// AbortSession handles DELETE /api/v1/uploads/sessions/{id}
func (h *UploadHandler) AbortSession(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	session, ok := h.loadOwnedSession(w, r, userID)
	if !ok {
		return
	}
	_ = h.sessions.Delete(r.Context(), session.ID)
	_ = os.Remove(session.TempPath)
	w.WriteHeader(http.StatusNoContent)
}

// PutChunk handles PUT /api/v1/uploads/sessions/{id}
func (h *UploadHandler) PutChunk(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	session, ok := h.loadOwnedSession(w, r, userID)
	if !ok {
		return
	}
	if time.Now().After(session.ExpiresAt) {
		_ = h.sessions.Delete(r.Context(), session.ID)
		_ = os.Remove(session.TempPath)
		writeError(w, "upload session expired", http.StatusGone)
		return
	}

	rangeHdr := r.Header.Get("Content-Range")
	m := contentRangeRe.FindStringSubmatch(strings.TrimSpace(rangeHdr))
	if m == nil {
		writeError(w, "Content-Range required (bytes start-end/total)", http.StatusBadRequest)
		return
	}
	start, _ := strconv.ParseInt(m[1], 10, 64)
	end, _ := strconv.ParseInt(m[2], 10, 64)
	total, _ := strconv.ParseInt(m[3], 10, 64)
	if total != session.EncryptedSize {
		writeError(w, "Content-Range total mismatch", http.StatusBadRequest)
		return
	}
	if start != session.ReceivedBytes {
		writeError(w, fmt.Sprintf("unexpected offset: expected %d", session.ReceivedBytes), http.StatusConflict)
		return
	}
	if end < start || end >= total {
		writeError(w, "invalid Content-Range", http.StatusBadRequest)
		return
	}
	chunkLen := end - start + 1
	if chunkLen > maxChunkBytes {
		writeError(w, "chunk too large", http.StatusRequestEntityTooLarge)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxChunkBytes+1024)
	f, err := os.OpenFile(session.TempPath, os.O_WRONLY, 0644)
	if err != nil {
		writeError(w, "failed to open temp file", http.StatusInternalServerError)
		return
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		f.Close()
		writeError(w, "failed to seek temp file", http.StatusInternalServerError)
		return
	}
	written, err := io.Copy(f, io.LimitReader(r.Body, chunkLen))
	closeErr := f.Close()
	if err != nil {
		writeError(w, "failed to write chunk", http.StatusInternalServerError)
		return
	}
	if closeErr != nil {
		writeError(w, "failed to write chunk", http.StatusInternalServerError)
		return
	}
	if written != chunkLen {
		writeError(w, "incomplete chunk body", http.StatusBadRequest)
		return
	}

	received := end + 1
	if err := h.sessions.UpdateReceived(r.Context(), session.ID, received); err != nil {
		writeError(w, "failed to update session", http.StatusInternalServerError)
		return
	}
	session.ReceivedBytes = received

	if received < session.EncryptedSize {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"id":             session.ID,
			"received_bytes": received,
			"encrypted_size": session.EncryptedSize,
			"complete":       false,
		})
		return
	}

	file, err := h.finalize(r.Context(), session)
	if err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	status := http.StatusCreated
	if session.FileID != nil && *session.FileID != "" {
		status = http.StatusOK
	}
	writeJSON(w, status, file)
}

func (h *UploadHandler) finalize(ctx context.Context, session *domain.UploadSession) (*domain.File, error) {
	info, err := os.Stat(session.TempPath)
	if err != nil {
		return nil, fmt.Errorf("temp file missing")
	}
	if info.Size() != session.EncryptedSize {
		return nil, fmt.Errorf("assembled size mismatch")
	}

	blobPath, size, err := h.disk.Import(session.UserID, session.TempPath)
	if err != nil {
		return nil, fmt.Errorf("failed to store file")
	}
	if size != session.EncryptedSize {
		_ = h.disk.Delete(blobPath)
		return nil, fmt.Errorf("stored size mismatch")
	}

	var result *domain.File
	if session.FileID != nil && *session.FileID != "" {
		result, err = h.fileService.UpdateContentFromBlob(
			ctx,
			*session.FileID,
			session.UserID,
			session.Name,
			session.MimeType,
			session.IV,
			session.OriginalSize,
			session.EncryptedSize,
			blobPath,
		)
	} else {
		f := &domain.File{
			Name:          session.Name,
			MimeType:      session.MimeType,
			Size:          session.OriginalSize,
			EncryptedSize: session.EncryptedSize,
			OwnerID:       session.UserID,
			IV:            session.IV,
			Version:       1,
			FolderID:      session.FolderID,
		}
		err = h.fileService.Upload(ctx, f, blobPath)
		result = f
	}
	if err != nil {
		_ = h.disk.Delete(blobPath)
		return nil, err
	}

	_ = h.sessions.Delete(ctx, session.ID)
	_ = os.Remove(session.TempPath) // may already be gone after Import rename
	return result, nil
}

func (h *UploadHandler) loadOwnedSession(w http.ResponseWriter, r *http.Request, userID string) (*domain.UploadSession, bool) {
	id := chi.URLParam(r, "id")
	session, err := h.sessions.GetByID(r.Context(), id)
	if err != nil {
		writeError(w, "failed to load session", http.StatusInternalServerError)
		return nil, false
	}
	if session == nil || session.UserID != userID {
		writeError(w, "session not found", http.StatusNotFound)
		return nil, false
	}
	return session, true
}
