package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/service"
	"github.com/go-chi/chi/v5"
)

// CryptoHandler handles E2E encryption key sync endpoints.
type CryptoHandler struct {
	cryptoService *service.CryptoService
}

func NewCryptoHandler(cryptoService *service.CryptoService) *CryptoHandler {
	return &CryptoHandler{cryptoService: cryptoService}
}

func (h *CryptoHandler) GetAccount(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	data, err := h.cryptoService.GetAccount(r.Context(), userID)
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (h *CryptoHandler) SetupAccount(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	var req struct {
		KeySalt            []byte `json:"key_salt"`
		WrappedUEK         string `json:"wrapped_uek"`
		WrappedUEKRecovery string `json:"wrapped_uek_recovery"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	err := h.cryptoService.SetupAccount(r.Context(), userID, req.KeySalt, req.WrappedUEK, req.WrappedUEKRecovery)
	if err != nil {
		if errors.Is(err, service.ErrCryptoAlreadySetup) {
			writeError(w, err.Error(), http.StatusConflict)
			return
		}
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]bool{"ok": true})
}

func (h *CryptoHandler) UpdateAccount(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	var req struct {
		KeySalt            []byte `json:"key_salt"`
		WrappedUEK         string `json:"wrapped_uek"`
		WrappedUEKRecovery string `json:"wrapped_uek_recovery"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	err := h.cryptoService.UpdateAccount(r.Context(), userID, req.KeySalt, req.WrappedUEK, req.WrappedUEKRecovery)
	if err != nil {
		if errors.Is(err, service.ErrCryptoNotSetup) {
			writeError(w, err.Error(), http.StatusNotFound)
			return
		}
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *CryptoHandler) ListEncryptionKeys(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	sinceStr := r.URL.Query().Get("since")
	var since time.Time
	if sinceStr != "" {
		parsed, err := time.Parse(time.RFC3339Nano, sinceStr)
		if err != nil {
			parsed, err = time.Parse(time.RFC3339, sinceStr)
			if err != nil {
				writeError(w, "invalid since parameter", http.StatusBadRequest)
				return
			}
		}
		since = parsed
	}
	keys, err := h.cryptoService.ListKeysSince(r.Context(), userID, since)
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if keys == nil {
		keys = []domain.EncryptionKeyEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"keys": keys})
}

func (h *CryptoHandler) GetFileEncryptionKey(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	fileID := chi.URLParam(r, "id")
	key, err := h.cryptoService.GetFileKey(r.Context(), userID, fileID)
	if err != nil {
		if errors.Is(err, service.ErrFileKeyNotFound) {
			writeError(w, err.Error(), http.StatusNotFound)
			return
		}
		if err.Error() == "access denied" {
			writeError(w, err.Error(), http.StatusForbidden)
			return
		}
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"file_id":          key.FileID,
		"wrapped_file_key": key.WrappedFileKey,
		"updated_at":       key.UpdatedAt,
	})
}

func (h *CryptoHandler) PutFileEncryptionKey(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	fileID := chi.URLParam(r, "id")
	var req struct {
		WrappedFileKey string `json:"wrapped_file_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	err := h.cryptoService.PutFileKey(r.Context(), userID, fileID, req.WrappedFileKey)
	if err != nil {
		if err.Error() == "access denied" || err.Error() == "file not found" {
			writeError(w, err.Error(), http.StatusForbidden)
			return
		}
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *CryptoHandler) BulkPutEncryptionKeys(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	var req struct {
		Keys map[string]string `json:"keys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	count, err := h.cryptoService.BulkPutFileKeys(r.Context(), userID, req.Keys)
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"imported": count})
}
