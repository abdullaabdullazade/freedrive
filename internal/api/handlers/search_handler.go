package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
	"github.com/abdullaabdullazade/freedrive/internal/repository/sqlite"
	"github.com/abdullaabdullazade/freedrive/internal/service"
	"github.com/go-chi/chi/v5"
)

// SearchHandler handles advanced search endpoints.
type SearchHandler struct {
	searchRepo *sqlite.SearchRepo
}

// NewSearchHandler creates a search handler.
func NewSearchHandler(searchRepo *sqlite.SearchRepo) *SearchHandler {
	return &SearchHandler{searchRepo: searchRepo}
}

// Search handles GET /api/v1/search
func (h *SearchHandler) Search(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	q := r.URL.Query()

	modifiedAfter, modifiedBefore := sqlite.ParseModifiedRange(
		q.Get("modified"),
		q.Get("modified_from"),
		q.Get("modified_to"),
		time.Now(),
	)

	opts := domain.SearchOptions{
		Query:             q.Get("q"),
		Name:              q.Get("name"),
		Words:             q.Get("words"),
		Type:              q.Get("type"),
		Owner:             q.Get("owner"),
		OwnerEmail:        q.Get("owner_email"),
		Location:          q.Get("location"),
		InTrash:           q.Get("in_trash") == "true",
		Starred:           q.Get("starred") == "true",
		Encrypted:         q.Get("encrypted") == "true",
		ModifiedAfter:     modifiedAfter,
		ModifiedBefore:    modifiedBefore,
		SharedTo:          q.Get("shared_to"),
		ApprovalAwaiting:  q.Get("approval_awaiting") == "true",
		ApprovalRequested: q.Get("approval_requested") == "true",
		FollowUps:         q.Get("followups"),
	}

	if opts.FollowUps == "" {
		opts.FollowUps = "-"
	}
	if opts.Owner == "" {
		opts.Owner = "Anyone"
	}
	if opts.Location == "" {
		opts.Location = "Anywhere"
	}

	opts.Page, _ = strconv.Atoi(q.Get("page"))
	opts.PageSize, _ = strconv.Atoi(q.Get("page_size"))

	result, err := h.searchRepo.Search(r.Context(), userID, opts)
	if err != nil {
		writeError(w, "search failed", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"files":   result.Files,
		"folders": result.Folders,
		"total":   result.Total,
		"page":    result.Page,
	})
}

// ApprovalHandler handles file approval endpoints.
type ApprovalHandler struct {
	approvalRepo *sqlite.ApprovalRepo
	userRepo     repository.UserRepository
	access       *service.AccessService
}

// NewApprovalHandler creates an approval handler.
func NewApprovalHandler(approvalRepo *sqlite.ApprovalRepo, userRepo repository.UserRepository, access *service.AccessService) *ApprovalHandler {
	return &ApprovalHandler{approvalRepo: approvalRepo, userRepo: userRepo, access: access}
}

// Create handles POST /api/v1/files/{id}/approvals
func (h *ApprovalHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	fileID := chi.URLParam(r, "id")

	var body struct {
		ApproverID    string `json:"approver_id"`
		ApproverEmail string `json:"approver_email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	approverID := body.ApproverID
	if approverID == "" && body.ApproverEmail != "" {
		user, err := h.userRepo.GetByEmail(r.Context(), body.ApproverEmail)
		if err != nil || user == nil {
			writeError(w, "approver not found", http.StatusBadRequest)
			return
		}
		approverID = user.ID
	}
	if approverID == "" {
		writeError(w, "approver_id or approver_email required", http.StatusBadRequest)
		return
	}
	if err := h.access.CanWriteFile(r.Context(), fileID, userID); err != nil {
		writeError(w, "access denied", http.StatusForbidden)
		return
	}

	approval := &domain.FileApproval{
		FileID:      fileID,
		RequestedBy: userID,
		ApproverID:  approverID,
		Status:      "pending",
	}
	if err := h.approvalRepo.Create(r.Context(), approval); err != nil {
		writeError(w, "failed to create approval", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, approval)
}

// List handles GET /api/v1/approvals
func (h *ApprovalHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	status := r.URL.Query().Get("status")
	list, err := h.approvalRepo.List(r.Context(), userID, status)
	if err != nil {
		writeError(w, "failed to list approvals", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"approvals": list})
}

// Update handles PATCH /api/v1/approvals/{id}
func (h *ApprovalHandler) Update(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	approvalID := chi.URLParam(r, "id")

	var req struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	status := strings.ToLower(strings.TrimSpace(req.Status))
	if status != "approved" && status != "rejected" {
		writeError(w, "status must be approved or rejected", http.StatusBadRequest)
		return
	}

	approval, err := h.approvalRepo.GetByID(r.Context(), approvalID)
	if err != nil || approval == nil {
		writeError(w, "approval not found", http.StatusNotFound)
		return
	}
	if approval.ApproverID != userID {
		writeError(w, "access denied", http.StatusForbidden)
		return
	}
	if approval.Status != "pending" {
		writeError(w, "approval already resolved", http.StatusBadRequest)
		return
	}

	approval.Status = status
	if err := h.approvalRepo.Update(r.Context(), approval); err != nil {
		writeError(w, "failed to update approval", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, approval)
}
