package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/go-chi/chi/v5"
)

func (h *AdminHandler) backupDir() string {
	adminSettingsMu.RLock()
	backupCfg, _ := adminSettings["backup"].(map[string]interface{})
	location := strings.TrimSpace(asString(backupCfg["location"]))
	adminSettingsMu.RUnlock()
	if location != "" {
		return location
	}
	if h.dataDir != "" {
		return filepath.Join(h.dataDir, "backups")
	}
	return "/var/lib/freedrive/backups"
}

func safeBackupFilename(name string) (string, error) {
	base := filepath.Base(strings.TrimSpace(name))
	if base == "" || base == "." || strings.Contains(base, "..") {
		return "", fmt.Errorf("invalid filename")
	}
	if !strings.HasSuffix(strings.ToLower(base), ".json") {
		return "", fmt.Errorf("invalid backup file type")
	}
	return base, nil
}

func (h *AdminHandler) purgeTrashedFiles(ctx context.Context, files []domain.File) (int, int64) {
	removed := 0
	var freed int64
	for _, f := range files {
		if h.diskStorage != nil {
			_ = h.diskStorage.Delete(f.BlobPath)
		}
		_ = h.userRepo.UpdateUsedBytes(ctx, f.OwnerID, -f.EncryptedSize)
		freed += f.EncryptedSize
		removed++
	}
	return removed, freed
}

type storageBucketStat struct {
	Size  int64 `json:"size"`
	Count int   `json:"count"`
}

// StorageBreakdown handles GET /api/v1/admin/storage/breakdown
// Optional query: user_id — limit to one owner's non-trashed files.
func (h *AdminHandler) StorageBreakdown(w http.ResponseWriter, r *http.Request) {
	userID := strings.TrimSpace(r.URL.Query().Get("user_id"))

	var metas []domain.FileMeta
	var err error
	if userID != "" {
		metas, err = h.fileRepo.ListFileMetaByOwner(r.Context(), userID)
	} else {
		metas, err = h.fileRepo.ListFileMetaAll(r.Context())
	}
	if err != nil {
		writeError(w, "failed to compute storage breakdown", http.StatusInternalServerError)
		return
	}

	breakdown := map[string]*storageBucketStat{
		"images":    {Size: 0, Count: 0},
		"videos":    {Size: 0, Count: 0},
		"documents": {Size: 0, Count: 0},
		"audio":     {Size: 0, Count: 0},
		"archives":  {Size: 0, Count: 0},
		"other":     {Size: 0, Count: 0},
	}
	for _, m := range metas {
		key := adminStorageCategory(m.MimeType, m.Name)
		b := breakdown[key]
		if b == nil {
			b = breakdown["other"]
		}
		b.Size += m.EncryptedSize
		b.Count++
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"breakdown": breakdown,
	})
}

// adminStorageCategory maps a file into one of six admin Storage legend buckets.
func adminStorageCategory(mime, name string) string {
	mt := strings.ToLower(strings.TrimSpace(mime))
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))

	if strings.HasPrefix(mt, "image/") || imageExts[ext] {
		return "images"
	}
	if strings.HasPrefix(mt, "video/") || videoExts[ext] {
		return "videos"
	}
	if strings.HasPrefix(mt, "audio/") || audioExts[ext] {
		return "audio"
	}
	if strings.Contains(mt, "zip") || strings.Contains(mt, "rar") || strings.Contains(mt, "tar") ||
		strings.Contains(mt, "7z") || strings.Contains(mt, "gzip") || strings.Contains(mt, "x-compressed") ||
		archiveExts[ext] {
		return "archives"
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

// PurgeTrash handles POST /api/v1/admin/storage/purge-trash?days=30|0
func (h *AdminHandler) PurgeTrash(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days < 0 {
		days = 0
	}

	var files []domain.File
	var err error
	if days == 0 {
		files, err = h.fileRepo.PurgeAllTrashed(r.Context())
	} else {
		files, err = h.fileRepo.PurgeOldTrashed(r.Context(), days)
	}
	if err != nil {
		writeError(w, "failed to purge trash", http.StatusInternalServerError)
		return
	}

	// Before deleting folder rows, hard-delete any remaining files that still
	// point at those folders (avoids ON DELETE SET NULL → My Drive orphans).
	var foldersRemoved int
	if h.folderRepo != nil {
		var pending []domain.Folder
		var listErr error
		if days == 0 {
			pending, listErr = h.folderRepo.ListAllTrashed(r.Context())
		} else {
			pending, listErr = h.folderRepo.ListOldTrashed(r.Context(), days)
		}
		if listErr != nil {
			writeError(w, "failed to list trashed folders", http.StatusInternalServerError)
			return
		}
		if len(pending) > 0 {
			ids := make([]string, 0, len(pending))
			for _, f := range pending {
				ids = append(ids, f.ID)
			}
			leftover, getErr := h.fileRepo.GetByFolderIDs(r.Context(), ids)
			if getErr != nil {
				writeError(w, "failed to list files in trashed folders", http.StatusInternalServerError)
				return
			}
			for _, f := range leftover {
				versions, _ := h.fileRepo.GetVersions(r.Context(), f.ID)
				for _, v := range versions {
					if h.diskStorage != nil {
						_ = h.diskStorage.Delete(v.BlobPath)
					}
				}
				_ = h.fileRepo.Delete(r.Context(), f.ID)
				files = append(files, f)
			}
		}

		var folders []domain.Folder
		var folderErr error
		if days == 0 {
			folders, folderErr = h.folderRepo.PurgeAllTrashed(r.Context())
		} else {
			folders, folderErr = h.folderRepo.PurgeOldTrashed(r.Context(), days)
		}
		if folderErr != nil {
			writeError(w, "failed to purge trashed folders", http.StatusInternalServerError)
			return
		}
		foldersRemoved = len(folders)
	}

	removed, freed := h.purgeTrashedFiles(r.Context(), files)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"removed_files":   removed,
		"removed_folders": foldersRemoved,
		"freed_bytes":     freed,
	})
}

// ListDuplicates handles GET /api/v1/admin/storage/duplicates
func (h *AdminHandler) ListDuplicates(w http.ResponseWriter, r *http.Request) {
	groups, err := h.fileRepo.ListDuplicateGroups(r.Context())
	if err != nil {
		writeError(w, "failed to list duplicates", http.StatusInternalServerError)
		return
	}
	if groups == nil {
		groups = []domain.DuplicateGroup{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"groups": groups})
}

// PurgeDuplicates handles POST /api/v1/admin/storage/duplicates/purge
func (h *AdminHandler) PurgeDuplicates(w http.ResponseWriter, r *http.Request) {
	files, err := h.fileRepo.ListDuplicateFilesToRemove(r.Context())
	if err != nil {
		writeError(w, "failed to list duplicate files", http.StatusInternalServerError)
		return
	}

	groups, _ := h.fileRepo.ListDuplicateGroups(r.Context())
	removed := 0
	var freed int64
	for _, f := range files {
		versions, _ := h.fileRepo.GetVersions(r.Context(), f.ID)
		for _, v := range versions {
			if h.diskStorage != nil {
				_ = h.diskStorage.Delete(v.BlobPath)
			}
		}
		if h.diskStorage != nil {
			_ = h.diskStorage.Delete(f.BlobPath)
		}
		if err := h.fileRepo.Delete(r.Context(), f.ID); err != nil {
			continue
		}
		_ = h.userRepo.UpdateUsedBytes(r.Context(), f.OwnerID, -f.EncryptedSize)
		freed += f.EncryptedSize
		removed++
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"groups":        len(groups),
		"removed_files": removed,
		"freed_bytes":   freed,
	})
}

type backupEntry struct {
	Filename  string `json:"filename"`
	Size      int64  `json:"size"`
	CreatedAt string `json:"created_at"`
}

// ListBackups handles GET /api/v1/admin/backup/list
func (h *AdminHandler) ListBackups(w http.ResponseWriter, r *http.Request) {
	dir := h.backupDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, http.StatusOK, map[string]interface{}{"backups": []backupEntry{}})
			return
		}
		writeError(w, "failed to read backup directory", http.StatusInternalServerError)
		return
	}

	var backups []backupEntry
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		backups = append(backups, backupEntry{
			Filename:  e.Name(),
			Size:      info.Size(),
			CreatedAt: info.ModTime().UTC().Format(time.RFC3339),
		})
	}
	if backups == nil {
		backups = []backupEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"backups": backups})
}

// DownloadBackup handles GET /api/v1/admin/backup/download/{filename}
func (h *AdminHandler) DownloadBackup(w http.ResponseWriter, r *http.Request) {
	filename, err := safeBackupFilename(chi.URLParam(r, "filename"))
	if err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	fullPath := filepath.Join(h.backupDir(), filename)
	f, err := os.Open(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, "backup not found", http.StatusNotFound)
			return
		}
		writeError(w, "failed to open backup", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	http.ServeContent(w, r, filename, time.Time{}, f)
}

// RestoreBackup handles POST /api/v1/admin/backup/restore
func (h *AdminHandler) RestoreBackup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Filename string `json:"filename"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	filename, err := safeBackupFilename(req.Filename)
	if err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}

	fullPath := filepath.Join(h.backupDir(), filename)
	bytes, err := os.ReadFile(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, "backup not found", http.StatusNotFound)
			return
		}
		writeError(w, "failed to read backup", http.StatusInternalServerError)
		return
	}

	var payload struct {
		Kind     string                 `json:"kind"`
		Settings map[string]interface{} `json:"settings"`
	}
	if err := json.Unmarshal(bytes, &payload); err != nil {
		writeError(w, "invalid backup file", http.StatusBadRequest)
		return
	}
	if payload.Kind != "settings_snapshot" || payload.Settings == nil {
		writeError(w, "unsupported backup type", http.StatusBadRequest)
		return
	}

	adminSettingsMu.Lock()
	for k, v := range payload.Settings {
		adminSettings[k] = v
	}
	adminSettingsMu.Unlock()
	saveSettings()

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DeleteBackup handles DELETE /api/v1/admin/backup/{filename}
func (h *AdminHandler) DeleteBackup(w http.ResponseWriter, r *http.Request) {
	filename, err := safeBackupFilename(chi.URLParam(r, "filename"))
	if err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	fullPath := filepath.Join(h.backupDir(), filename)
	if err := os.Remove(fullPath); err != nil {
		if os.IsNotExist(err) {
			writeError(w, "backup not found", http.StatusNotFound)
			return
		}
		writeError(w, "failed to delete backup", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// WipeAllData handles POST /api/v1/admin/danger/wipe
func (h *AdminHandler) WipeAllData(w http.ResponseWriter, r *http.Request) {
	adminID := middleware.GetUserID(r.Context())
	if adminID == "" {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Confirm string `json:"confirm"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Confirm) != "WIPE" {
		writeError(w, `confirmation must be "WIPE"`, http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	if h.diskStorage != nil {
		paths, err := h.fileRepo.ListAllBlobPaths(ctx)
		if err != nil {
			writeError(w, "failed to list blobs", http.StatusInternalServerError)
			return
		}
		for _, p := range paths {
			_ = h.diskStorage.Delete(p)
		}
	}

	if err := h.userRepo.WipeAllDataExcept(ctx, adminID); err != nil {
		writeError(w, "wipe failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
