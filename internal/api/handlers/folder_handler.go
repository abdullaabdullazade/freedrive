package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
	"github.com/abdullaabdullazade/freedrive/internal/service"
	"github.com/go-chi/chi/v5"
)

// FolderHandler handles folder endpoints.
type FolderHandler struct {
	folderService *service.FolderService
	mutationRepo  repository.ClientMutationRepository
}

// NewFolderHandler creates a new folder handler.
func NewFolderHandler(folderService *service.FolderService, mutationRepo repository.ClientMutationRepository) *FolderHandler {
	return &FolderHandler{folderService: folderService, mutationRepo: mutationRepo}
}

// Create handles POST /api/v1/folders
func (h *FolderHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	var req struct {
		Name     string  `json:"name"`
		ParentID *string `json:"parent_id"`
		Color    string  `json:"color"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Name == "" {
		writeError(w, "folder name is required", http.StatusBadRequest)
		return
	}

	folder := &domain.Folder{
		Name:     req.Name,
		ParentID: req.ParentID,
		OwnerID:  userID,
		Color:    req.Color,
	}

	if err := h.folderService.Create(r.Context(), folder); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}

	writeJSON(w, http.StatusCreated, folder)
}

// Get handles GET /api/v1/folders/{id}
func (h *FolderHandler) Get(w http.ResponseWriter, r *http.Request) {
	folderID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())

	contents, err := h.folderService.GetContents(r.Context(), &folderID, userID, parseFolderContentsOpts(r))
	if err != nil {
		if err.Error() == "invalid page_token" {
			writeError(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeError(w, err.Error(), http.StatusNotFound)
		return
	}

	writeJSON(w, http.StatusOK, contents)
}

// GetRoot handles GET /api/v1/folders/root
func (h *FolderHandler) GetRoot(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	contents, err := h.folderService.GetContents(r.Context(), nil, userID, parseFolderContentsOpts(r))
	if err != nil {
		if err.Error() == "invalid page_token" {
			writeError(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, contents)
}

func parseFolderContentsOpts(r *http.Request) domain.FolderContentsOptions {
	opts := domain.FolderContentsOptions{
		PageToken: r.URL.Query().Get("page_token"),
	}
	if n, err := strconv.Atoi(r.URL.Query().Get("page_size")); err == nil {
		opts.PageSize = n
	}
	return opts
}

// ListAll handles GET /api/v1/folders/all
func (h *FolderHandler) ListAll(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	search := r.URL.Query().Get("search")

	folders, err := h.folderService.ListAll(r.Context(), userID, search)
	if err != nil {
		writeError(w, "failed to list folders", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"folders": folders,
	})
}

// Update handles PATCH /api/v1/folders/{id}
func (h *FolderHandler) Update(w http.ResponseWriter, r *http.Request) {
	folderID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())

	var req struct {
		Name          *string `json:"name"`
		ParentID      *string `json:"parent_id"`
		MoveRequested bool    `json:"move_requested"`
		Color         *string `json:"color"`
		Star          *bool   `json:"is_starred"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Name != nil {
		if err := h.folderService.Rename(r.Context(), folderID, userID, *req.Name); err != nil {
			writeError(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	if req.ParentID != nil || req.MoveRequested {
		if err := h.folderService.Move(r.Context(), folderID, userID, req.ParentID); err != nil {
			writeError(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	if req.Color != nil {
		if err := h.folderService.SetColor(r.Context(), folderID, userID, *req.Color); err != nil {
			writeError(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	if req.Star != nil {
		if err := h.folderService.SetStar(r.Context(), folderID, userID, *req.Star); err != nil {
			writeError(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	folder, err := h.folderService.Get(r.Context(), folderID, userID)
	if err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, folder)
}

// Delete handles DELETE /api/v1/folders/{id}
func (h *FolderHandler) Delete(w http.ResponseWriter, r *http.Request) {
	folderID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())

	if !acceptClientMutation(r.Context(), h.mutationRepo, r) {
		writeJSON(w, http.StatusOK, map[string]string{"message": "deleted"})
		return
	}

	if err := h.folderService.Delete(r.Context(), folderID, userID); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "deleted"})
}

// Restore handles POST /api/v1/folders/{id}/restore
func (h *FolderHandler) Restore(w http.ResponseWriter, r *http.Request) {
	folderID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())

	if err := h.folderService.Restore(r.Context(), folderID, userID); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "restored"})
}

// PermanentDelete handles DELETE /api/v1/folders/{id}/permanent
func (h *FolderHandler) PermanentDelete(w http.ResponseWriter, r *http.Request) {
	folderID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())

	if err := h.folderService.PermanentDelete(r.Context(), folderID, userID); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "permanently deleted"})
}

// Trash handles GET /api/v1/folders/trash
func (h *FolderHandler) Trash(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	folders, err := h.folderService.ListTrash(r.Context(), userID)
	if err != nil {
		writeError(w, "failed to list trash", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"folders": folders})
}

// GetBreadcrumb handles GET /api/v1/folders/{id}/breadcrumb
func (h *FolderHandler) GetBreadcrumb(w http.ResponseWriter, r *http.Request) {
	folderID := chi.URLParam(r, "id")
	userID := middleware.GetUserID(r.Context())

	crumbs, err := h.folderService.GetBreadcrumb(r.Context(), folderID, userID)
	if err != nil {
		writeError(w, err.Error(), http.StatusForbidden)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"breadcrumb": crumbs})
}
