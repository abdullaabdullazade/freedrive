package handlers

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
	"github.com/abdullaabdullazade/freedrive/internal/service"
	"github.com/abdullaabdullazade/freedrive/internal/storage"
	"github.com/go-chi/chi/v5"
)

// FileHandler handles file endpoints.
type FileHandler struct {
	fileService  *service.FileService
	fileRepo     repository.FileRepository
	storage      *storage.DiskStorage
	maxUpload    int64
	mutationRepo repository.ClientMutationRepository
}

// NewFileHandler creates a new file handler.
func NewFileHandler(
	fileService *service.FileService,
	fileRepo repository.FileRepository,
	store *storage.DiskStorage,
	maxUpload int64,
	mutationRepo repository.ClientMutationRepository,
) *FileHandler {
	return &FileHandler{
		fileService:  fileService,
		fileRepo:     fileRepo,
		storage:      store,
		maxUpload:    maxUpload,
		mutationRepo: mutationRepo,
	}
}

// Upload handles POST /api/v1/files/upload
func (h *FileHandler) Upload(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	// Limit upload size (config + admin setting)
	maxBytes := adminsettings.EffectiveMaxUploadBytes(h.maxUpload)
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)

	if err := r.ParseMultipartForm(64 << 20); err != nil { // 64MB memory
		writeError(w, "file too large or invalid form", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, "missing file field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Get metadata from form
	name := r.FormValue("name")
	if name == "" {
		name = header.Filename
	}

	if !adminsettings.AllowedTypesUnlimited() {
		if allowed := adminsettings.AllowedTypes(); len(allowed) > 0 {
			ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
			if ext == "" || !containsString(allowed, ext) {
				writeError(w, "file type not allowed", http.StatusBadRequest)
				return
			}
		}
	}
	mimeType := r.FormValue("mime_type")
	if mimeType == "" {
		mimeType = header.Header.Get("Content-Type")
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
	}
	iv := r.FormValue("iv")
	folderID := r.FormValue("folder_id")

	originalSize, _ := strconv.ParseInt(r.FormValue("original_size"), 10, 64)
	if originalSize == 0 {
		originalSize = header.Size
	}

	// Save blob to disk
	blobPath, encryptedSize, err := h.storage.Save(userID, file)
	if err != nil {
		writeError(w, "failed to store file", http.StatusInternalServerError)
		return
	}

	// Create file record
	f := &domain.File{
		Name:          name,
		MimeType:      mimeType,
		Size:          originalSize,
		EncryptedSize: encryptedSize,
		OwnerID:       userID,
		IV:            iv,
		Version:       1,
	}
	if folderID != "" {
		f.FolderID = &folderID
	}

	if err := h.fileService.Upload(r.Context(), f, blobPath); err != nil {
		_ = h.storage.Delete(blobPath)
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}

	writeJSON(w, http.StatusCreated, f)
}

// Download handles GET /api/v1/files/{id}/download
func (h *FileHandler) Download(w http.ResponseWriter, r *http.Request) {
	fileID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())

	file, getReader, err := h.fileService.Download(r.Context(), fileID, userID)
	if err != nil {
		writeError(w, err.Error(), http.StatusNotFound)
		return
	}

	readerIface, err := getReader()
	if err != nil {
		log.Printf("download blob missing file_id=%s blob_path=%s: %v", fileID, file.BlobPath, err)
		writeError(w, "blob missing", http.StatusNotFound)
		return
	}
	reader := readerIface.(io.ReadCloser)
	defer reader.Close()

	h.fileService.RecordDownload(r.Context(), userID, file.ID, file.Name)

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+file.Name+"\"")
	w.Header().Set("Content-Length", strconv.FormatInt(file.EncryptedSize, 10))
	w.Header().Set("X-File-IV", file.IV)
	w.Header().Set("X-File-Mime", file.MimeType)
	w.Header().Set("X-Original-Size", strconv.FormatInt(file.Size, 10))

	io.Copy(w, reader)
}

// List handles GET /api/v1/files
func (h *FileHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	opts := domain.FileListOptions{
		OwnerID:  userID,
		Search:   r.URL.Query().Get("search"),
		MimeType: r.URL.Query().Get("type"),
		SortBy:   r.URL.Query().Get("sort"),
		SortDir:  r.URL.Query().Get("dir"),
		Trashed:  r.URL.Query().Get("trashed") == "true",
		Starred:  r.URL.Query().Get("starred") == "true",
	}

	if folderID := r.URL.Query().Get("folder_id"); folderID != "" {
		opts.FolderID = &folderID
	}

	opts.Page, _ = strconv.Atoi(r.URL.Query().Get("page"))
	opts.PageSize, _ = strconv.Atoi(r.URL.Query().Get("page_size"))

	files, total, err := h.fileRepo.List(r.Context(), opts)
	if err != nil {
		writeError(w, "failed to list files", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"files": files,
		"total": total,
		"page":  opts.Page,
	})
}

// Get handles GET /api/v1/files/{id}
func (h *FileHandler) Get(w http.ResponseWriter, r *http.Request) {
	fileID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())
	file, err := h.fileService.Get(r.Context(), fileID, userID)
	if err != nil {
		writeError(w, err.Error(), http.StatusForbidden)
		return
	}
	writeJSON(w, http.StatusOK, file)
}

// Update handles PATCH /api/v1/files/{id}
func (h *FileHandler) Update(w http.ResponseWriter, r *http.Request) {
	fileID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())

	var req struct {
		Name     *string `json:"name"`
		FolderID *string `json:"folder_id"`
		Star     *bool   `json:"is_starred"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Name != nil {
		if err := h.fileService.Rename(r.Context(), fileID, userID, *req.Name); err != nil {
			writeError(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	if req.FolderID != nil {
		if err := h.fileService.Move(r.Context(), fileID, userID, req.FolderID); err != nil {
			writeError(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	if req.Star != nil {
		if err := h.fileService.ToggleStar(r.Context(), fileID, userID); err != nil {
			writeError(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	file, _ := h.fileRepo.GetByID(r.Context(), fileID)
	writeJSON(w, http.StatusOK, file)
}

// Delete handles DELETE /api/v1/files/{id}
func (h *FileHandler) Delete(w http.ResponseWriter, r *http.Request) {
	fileID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())

	if !acceptClientMutation(r.Context(), h.mutationRepo, r) {
		writeJSON(w, http.StatusOK, map[string]string{"message": "moved to trash"})
		return
	}

	if err := h.fileService.Delete(r.Context(), fileID, userID); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "moved to trash"})
}

// Restore handles POST /api/v1/files/{id}/restore
func (h *FileHandler) Restore(w http.ResponseWriter, r *http.Request) {
	fileID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())

	if err := h.fileService.Restore(r.Context(), fileID, userID); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "restored"})
}

// PermanentDelete handles DELETE /api/v1/files/{id}/permanent
func (h *FileHandler) PermanentDelete(w http.ResponseWriter, r *http.Request) {
	fileID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())

	if err := h.fileService.PermanentDelete(r.Context(), fileID, userID); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "permanently deleted"})
}

// GetVersions handles GET /api/v1/files/{id}/versions
func (h *FileHandler) GetVersions(w http.ResponseWriter, r *http.Request) {
	fileID := chi.URLParam(r, "id")
	versions, err := h.fileRepo.GetVersions(r.Context(), fileID)
	if err != nil {
		writeError(w, "failed to get versions", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"versions": versions})
}

// UpdateContent handles POST /api/v1/files/{id}/content
func (h *FileHandler) UpdateContent(w http.ResponseWriter, r *http.Request) {
	fileID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())

	maxBytes := adminsettings.EffectiveMaxUploadBytes(h.maxUpload)
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	if err := r.ParseMultipartForm(64 << 20); err != nil { // 64MB memory
		writeError(w, "file too large or invalid form", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, "missing file field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	name := r.FormValue("name")
	if name == "" {
		name = header.Filename
	}
	if !adminsettings.AllowedTypesUnlimited() {
		if allowed := adminsettings.AllowedTypes(); len(allowed) > 0 {
			ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
			if ext == "" || !containsString(allowed, ext) {
				writeError(w, "file type not allowed", http.StatusBadRequest)
				return
			}
		}
	}
	mimeType := r.FormValue("mime_type")
	if mimeType == "" {
		mimeType = header.Header.Get("Content-Type")
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
	}
	iv := r.FormValue("iv")

	originalSize, _ := strconv.ParseInt(r.FormValue("original_size"), 10, 64)
	if originalSize == 0 {
		originalSize = header.Size
	}

	updated, err := h.fileService.UpdateContent(r.Context(), fileID, userID, name, mimeType, iv, originalSize, file)
	if err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}

	writeJSON(w, http.StatusOK, updated)
}

// RestoreVersion handles POST /api/v1/files/{id}/versions/{version}/restore
func (h *FileHandler) RestoreVersion(w http.ResponseWriter, r *http.Request) {
	fileID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())
	version, _ := strconv.Atoi(chi.URLParam(r, "version"))
	if version < 1 {
		writeError(w, "invalid version", http.StatusBadRequest)
		return
	}

	updated, err := h.fileService.RestoreVersion(r.Context(), fileID, userID, version)
	if err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (h *FileHandler) Trash(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	files, err := h.fileRepo.GetTrashedFiles(r.Context(), userID)
	if err != nil {
		writeError(w, "failed to list trash", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"files": files})
}

// EmptyTrash handles POST /api/v1/trash/empty
func (h *FileHandler) EmptyTrash(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	result, err := h.fileService.EmptyTrash(r.Context(), userID)
	if err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func containsString(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}
