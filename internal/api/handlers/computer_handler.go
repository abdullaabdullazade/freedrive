package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/service"
	"github.com/go-chi/chi/v5"
)

// ComputerHandler handles computer endpoints.
type ComputerHandler struct {
	computerService *service.ComputerService
	folderService   *service.FolderService
	syncFeedService *service.SyncFeedService
}

// NewComputerHandler creates a new computer handler.
func NewComputerHandler(
	computerService *service.ComputerService,
	folderService *service.FolderService,
	syncFeedService *service.SyncFeedService,
) *ComputerHandler {
	return &ComputerHandler{
		computerService: computerService,
		folderService:   folderService,
		syncFeedService: syncFeedService,
	}
}

// List handles GET /api/v1/computers
func (h *ComputerHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	computers, err := h.computerService.List(r.Context(), userID)
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if computers == nil {
		computers = []domain.Computer{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"computers": computers})
}

// Get handles GET /api/v1/computers/{id}
func (h *ComputerHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	computerID := chi.URLParam(r, "id")

	computer, err := h.computerService.Get(r.Context(), userID, computerID)
	if err != nil {
		writeError(w, err.Error(), http.StatusNotFound)
		return
	}

	writeJSON(w, http.StatusOK, computer)
}

// Register handles POST /api/v1/computers/register
func (h *ComputerHandler) Register(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	var req struct {
		Name     string `json:"name"`
		Hostname string `json:"hostname"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	computer, err := h.computerService.Register(r.Context(), userID, req.Name, req.Hostname)
	if err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}

	writeJSON(w, http.StatusCreated, computer)
}

// Heartbeat handles POST /api/v1/computers/{id}/heartbeat
func (h *ComputerHandler) Heartbeat(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	computerID := chi.URLParam(r, "id")

	computer, err := h.computerService.Heartbeat(r.Context(), userID, computerID)
	if err != nil {
		writeError(w, err.Error(), http.StatusNotFound)
		return
	}

	writeJSON(w, http.StatusOK, computer)
}

// Delete handles DELETE /api/v1/computers/{id}
func (h *ComputerHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	computerID := chi.URLParam(r, "id")

	computer, err := h.computerService.Get(r.Context(), userID, computerID)
	if err != nil {
		writeError(w, err.Error(), http.StatusNotFound)
		return
	}

	rootFolderID := computer.RootFolderID

	// Delete the tree first so the computer root (parent_id NULL) never appears
	// briefly under My Drive after the computers row is dropped.
	if err := h.folderService.PermanentDelete(r.Context(), rootFolderID, userID); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := h.computerService.Delete(r.Context(), userID, computerID); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// Snapshot handles GET /api/v1/computers/{id}/snapshot
func (h *ComputerHandler) Snapshot(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	computerID := chi.URLParam(r, "id")

	snapshot, err := h.syncFeedService.Snapshot(r.Context(), userID, computerID)
	if err != nil {
		writeError(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

// Changes handles GET /api/v1/computers/{id}/changes?cursor=&limit=
func (h *ComputerHandler) Changes(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	computerID := chi.URLParam(r, "id")

	cursor, _ := strconv.ParseInt(r.URL.Query().Get("cursor"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 100
	}

	page, err := h.syncFeedService.ListChanges(r.Context(), userID, computerID, cursor, limit)
	if err != nil {
		writeError(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, page)
}
