package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
	"github.com/abdullaabdullazade/freedrive/internal/service"
	"github.com/go-chi/chi/v5"
)

// CommentHandler handles file comment endpoints.
type CommentHandler struct {
	commentRepo repository.CommentRepository
	access      *service.AccessService
	userRepo    repository.UserRepository
}

// NewCommentHandler creates a comment handler.
func NewCommentHandler(commentRepo repository.CommentRepository, access *service.AccessService, userRepo repository.UserRepository) *CommentHandler {
	return &CommentHandler{commentRepo: commentRepo, access: access, userRepo: userRepo}
}

// List handles GET /api/v1/files/{id}/comments
func (h *CommentHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	fileID := chi.URLParam(r, "id")
	if err := h.access.CanReadFile(r.Context(), fileID, userID); err != nil {
		writeError(w, "access denied", http.StatusForbidden)
		return
	}
	comments, err := h.commentRepo.GetByFileID(r.Context(), fileID)
	if err != nil {
		writeError(w, "failed to list comments", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"comments": comments})
}

// Create handles POST /api/v1/files/{id}/comments
func (h *CommentHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	fileID := chi.URLParam(r, "id")
	if err := h.access.CanReadFile(r.Context(), fileID, userID); err != nil {
		writeError(w, "access denied", http.StatusForbidden)
		return
	}

	var req struct {
		Content          string  `json:"content"`
		ParentID         *string `json:"parent_id"`
		AssignedTo       string  `json:"assigned_to"`
		AssignedToEmail  string  `json:"assigned_to_email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Content == "" {
		writeError(w, "content is required", http.StatusBadRequest)
		return
	}

	assignedTo := req.AssignedTo
	if assignedTo == "" && req.AssignedToEmail != "" {
		assignee, err := h.userRepo.GetByEmail(r.Context(), req.AssignedToEmail)
		if err != nil || assignee == nil {
			writeError(w, "assignee not found", http.StatusBadRequest)
			return
		}
		assignedTo = assignee.ID
	}

	user, _ := h.userRepo.GetByID(r.Context(), userID)
	comment := &domain.Comment{
		FileID:   fileID,
		UserID:   userID,
		Content:  req.Content,
		ParentID: req.ParentID,
	}
	if assignedTo != "" {
		comment.AssignedTo = &assignedTo
		assignee, _ := h.userRepo.GetByID(r.Context(), assignedTo)
		if assignee != nil {
			comment.AssignedToUsername = assignee.Username
		}
	}
	if user != nil {
		comment.Username = user.Username
	}
	if err := h.commentRepo.Create(r.Context(), comment); err != nil {
		writeError(w, "failed to create comment", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, comment)
}

// Delete handles DELETE /api/v1/files/{id}/comments/{commentId}
func (h *CommentHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	fileID := chi.URLParam(r, "id")
	commentID := chi.URLParam(r, "commentId")
	if err := h.access.CanReadFile(r.Context(), fileID, userID); err != nil {
		writeError(w, "access denied", http.StatusForbidden)
		return
	}

	comments, err := h.commentRepo.GetByFileID(r.Context(), fileID)
	if err != nil {
		writeError(w, "failed to load comments", http.StatusInternalServerError)
		return
	}
	var target *domain.Comment
	for i := range comments {
		if comments[i].ID == commentID {
			target = &comments[i]
			break
		}
	}
	if target == nil {
		writeError(w, "comment not found", http.StatusNotFound)
		return
	}
	if target.UserID != userID {
		if err := h.access.CanWriteFile(r.Context(), fileID, userID); err != nil {
			writeError(w, "access denied", http.StatusForbidden)
			return
		}
	}
	if err := h.commentRepo.Delete(r.Context(), commentID); err != nil {
		writeError(w, "failed to delete comment", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
