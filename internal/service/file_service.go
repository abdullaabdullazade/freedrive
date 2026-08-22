package service

import (
	"context"
	"fmt"
	"io"
	"log"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
	"github.com/abdullaabdullazade/freedrive/internal/storage"
)

// FileService handles file business logic.
type FileService struct {
	fileRepo     repository.FileRepository
	userRepo     repository.UserRepository
	storage      *storage.DiskStorage
	activityRepo repository.ActivityRepository
	access       *AccessService
	folderRepo   repository.FolderRepository
	syncChange   *SyncChangeService
}

// NewFileService creates a new file service.
func NewFileService(
	fileRepo repository.FileRepository,
	userRepo repository.UserRepository,
	store *storage.DiskStorage,
	activityRepo repository.ActivityRepository,
	access *AccessService,
	folderRepo repository.FolderRepository,
	syncChange *SyncChangeService,
) *FileService {
	return &FileService{
		fileRepo:     fileRepo,
		userRepo:     userRepo,
		storage:      store,
		activityRepo: activityRepo,
		access:       access,
		folderRepo:   folderRepo,
		syncChange:   syncChange,
	}
}

// Upload stores a file and creates metadata.
func (s *FileService) Upload(ctx context.Context, file *domain.File, blobPath string) error {
	if file.FolderID != nil && *file.FolderID != "" && s.folderRepo != nil {
		folder, err := s.folderRepo.GetByID(ctx, *file.FolderID)
		if err != nil {
			return err
		}
		if folder == nil {
			return fmt.Errorf("folder not found")
		}
		if folder.IsTrashed {
			return fmt.Errorf("cannot upload into a trashed folder")
		}
	}

	// Check quota
	user, err := s.userRepo.GetByID(ctx, file.OwnerID)
	if err != nil {
		return err
	}
	if user == nil {
		return fmt.Errorf("user not found")
	}
	if user.UsedBytes+file.EncryptedSize > user.QuotaBytes {
		return fmt.Errorf("quota exceeded: used %d + %d > %d", user.UsedBytes, file.EncryptedSize, user.QuotaBytes)
	}
	if err := s.checkServerCapacity(ctx, file.EncryptedSize); err != nil {
		return err
	}

	file.BlobPath = blobPath

	if err := s.fileRepo.Create(ctx, file); err != nil {
		return err
	}

	// Update user's used bytes
	if err := s.userRepo.UpdateUsedBytes(ctx, file.OwnerID, file.EncryptedSize); err != nil {
		return err
	}

	// Log activity
	s.logActivity(ctx, file.OwnerID, domain.ActionUpload, "file", file.ID, file.Name, "")

	if s.syncChange != nil {
		_ = s.syncChange.RecordFileCreate(ctx, file)
	}

	return nil
}

// Download returns a file's blob reader.
func (s *FileService) Download(ctx context.Context, fileID, userID string) (*domain.File, func() (interface{}, error), error) {
	if err := s.access.CanReadFile(ctx, fileID, userID); err != nil {
		return nil, nil, err
	}

	file, err := s.fileRepo.GetByID(ctx, fileID)
	if err != nil {
		return nil, nil, err
	}
	if file == nil {
		return nil, nil, fmt.Errorf("file not found")
	}

	// Update accessed_at
	now := time.Now()
	file.AccessedAt = now
	_ = s.fileRepo.Update(ctx, file)

	getReader := func() (interface{}, error) {
		return s.storage.Get(file.BlobPath)
	}

	return file, getReader, nil
}

// Get returns file metadata when the user may read the file.
func (s *FileService) Get(ctx context.Context, fileID, userID string) (*domain.File, error) {
	if err := s.access.CanReadFile(ctx, fileID, userID); err != nil {
		return nil, err
	}
	file, err := s.fileRepo.GetByID(ctx, fileID)
	if err != nil {
		return nil, err
	}
	if file == nil {
		return nil, fmt.Errorf("file not found")
	}
	return file, nil
}

// Delete moves a file to trash.
func (s *FileService) Delete(ctx context.Context, fileID, userID string) error {
	if err := s.access.CanWriteFile(ctx, fileID, userID); err != nil {
		return err
	}
	file, err := s.fileRepo.GetByID(ctx, fileID)
	if err != nil {
		return err
	}
	if file == nil {
		return fmt.Errorf("file not found")
	}

	if err := s.fileRepo.MoveToTrash(ctx, fileID); err != nil {
		return err
	}

	s.logActivity(ctx, userID, domain.ActionDelete, "file", fileID, file.Name, "")
	if s.syncChange != nil {
		_ = s.syncChange.RecordFileTrash(ctx, file)
	}
	return nil
}

// PermanentDelete removes a file and its blob permanently.
func (s *FileService) PermanentDelete(ctx context.Context, fileID, userID string) error {
	file, err := s.fileRepo.GetByID(ctx, fileID)
	if err != nil {
		return err
	}
	if file == nil {
		return fmt.Errorf("file not found")
	}
	if file.OwnerID != userID {
		return fmt.Errorf("access denied")
	}

	// Delete versions
	versions, _ := s.fileRepo.GetVersions(ctx, fileID)
	for _, v := range versions {
		_ = s.storage.Delete(v.BlobPath)
	}

	// Delete main blob
	if err := s.storage.Delete(file.BlobPath); err != nil {
		return err
	}

	if err := s.fileRepo.Delete(ctx, fileID); err != nil {
		return err
	}

	// Return quota
	if err := s.userRepo.UpdateUsedBytes(ctx, userID, -file.EncryptedSize); err != nil {
		return err
	}

	if s.syncChange != nil {
		_ = s.syncChange.RecordFilePermanentDelete(ctx, file)
	}

	return nil
}

// Restore restores a file from trash.
func (s *FileService) Restore(ctx context.Context, fileID, userID string) error {
	file, err := s.fileRepo.GetByID(ctx, fileID)
	if err != nil {
		return err
	}
	if file == nil || file.OwnerID != userID {
		return fmt.Errorf("file not found")
	}

	if err := s.fileRepo.RestoreFromTrash(ctx, fileID); err != nil {
		return err
	}

	s.logActivity(ctx, userID, domain.ActionRestore, "file", fileID, file.Name, "")
	if s.syncChange != nil {
		_ = s.syncChange.RecordFileRestore(ctx, file)
	}
	return nil
}

// Rename renames a file.
func (s *FileService) Rename(ctx context.Context, fileID, userID, newName string) error {
	if err := s.access.CanWriteFile(ctx, fileID, userID); err != nil {
		return err
	}
	file, err := s.fileRepo.GetByID(ctx, fileID)
	if err != nil {
		return err
	}
	if file == nil {
		return fmt.Errorf("file not found")
	}

	oldName := file.Name
	file.Name = newName
	if err := s.fileRepo.Update(ctx, file); err != nil {
		return err
	}

	s.logActivity(ctx, userID, domain.ActionRename, "file", fileID, newName, fmt.Sprintf(`{"old_name":"%s"}`, oldName))
	if s.syncChange != nil {
		_ = s.syncChange.RecordFileRename(ctx, file, oldName)
	}
	return nil
}

// Move moves a file to another folder.
func (s *FileService) Move(ctx context.Context, fileID, userID string, folderID *string) error {
	if err := s.access.CanWriteFile(ctx, fileID, userID); err != nil {
		return err
	}
	if folderID != nil && *folderID != "" {
		if err := s.access.CanWriteFolder(ctx, *folderID, userID); err != nil {
			return err
		}
	}
	file, err := s.fileRepo.GetByID(ctx, fileID)
	if err != nil {
		return err
	}
	if file == nil {
		return fmt.Errorf("file not found")
	}

	file.FolderID = folderID
	if err := s.fileRepo.Update(ctx, file); err != nil {
		return err
	}

	s.logActivity(ctx, userID, domain.ActionMove, "file", fileID, file.Name, "")
	if s.syncChange != nil {
		oldParent := ""
		// old parent not tracked here; move payload optional
		_ = s.syncChange.RecordFileMove(ctx, file, oldParent)
	}
	return nil
}

// ToggleStar toggles the starred state of a file.
func (s *FileService) ToggleStar(ctx context.Context, fileID, userID string) error {
	if err := s.access.CanWriteFile(ctx, fileID, userID); err != nil {
		return err
	}
	file, err := s.fileRepo.GetByID(ctx, fileID)
	if err != nil {
		return err
	}
	if file == nil {
		return fmt.Errorf("file not found")
	}

	file.IsStarred = !file.IsStarred
	return s.fileRepo.Update(ctx, file)
}

// EmptyTrashResult is returned by EmptyTrash.
type EmptyTrashResult struct {
	RemovedFiles   int   `json:"removed_files"`
	RemovedFolders int   `json:"removed_folders"`
	FreedBytes     int64 `json:"freed_bytes"`
}

// hardDeleteFileRows removes file DB rows (and version blobs) and returns main blob
// paths plus freed encrypted bytes. Callers delete main blobs asynchronously if desired.
func (s *FileService) hardDeleteFileRows(ctx context.Context, files []domain.File) (blobPaths []string, freed int64) {
	for _, f := range files {
		versions, _ := s.fileRepo.GetVersions(ctx, f.ID)
		for _, v := range versions {
			_ = s.storage.Delete(v.BlobPath)
		}
		blobPaths = append(blobPaths, f.BlobPath)
		freed += f.EncryptedSize
		_ = s.fileRepo.Delete(ctx, f.ID)
		_ = s.userRepo.UpdateUsedBytes(ctx, f.OwnerID, -f.EncryptedSize)
	}
	return blobPaths, freed
}

// purgeFilesInFolders hard-deletes every file still pointing at the given folders
// so folder DELETE cannot orphan them to My Drive via ON DELETE SET NULL.
func (s *FileService) purgeFilesInFolders(ctx context.Context, folderIDs []string) (blobPaths []string, count int, freed int64, err error) {
	if len(folderIDs) == 0 {
		return nil, 0, 0, nil
	}
	files, err := s.fileRepo.GetByFolderIDs(ctx, folderIDs)
	if err != nil {
		return nil, 0, 0, err
	}
	paths, freed := s.hardDeleteFileRows(ctx, files)
	return paths, len(files), freed, nil
}

func folderIDsOf(folders []domain.Folder) []string {
	ids := make([]string, 0, len(folders))
	for _, f := range folders {
		ids = append(ids, f.ID)
	}
	return ids
}

// EmptyTrash permanently removes all trashed files and folders for the owner.
// Database rows are cleared first so the trash list is empty immediately; blob
// I/O runs afterward (and does not block list freshness).
// Any non-trashed files still inside trashed folders are hard-deleted before
// folders are removed, so SQLite ON DELETE SET NULL cannot move them to My Drive.
func (s *FileService) EmptyTrash(ctx context.Context, ownerID string) (*EmptyTrashResult, error) {
	files, err := s.fileRepo.PurgeAllTrashedForOwner(ctx, ownerID)
	if err != nil {
		return nil, err
	}

	blobPaths := make([]string, 0, len(files))
	var freed int64
	for _, f := range files {
		blobPaths = append(blobPaths, f.BlobPath)
		freed += f.EncryptedSize
		_ = s.userRepo.UpdateUsedBytes(ctx, f.OwnerID, -f.EncryptedSize)
	}

	var foldersRemoved int
	if s.folderRepo != nil {
		pending, err := s.folderRepo.ListAllTrashedForOwner(ctx, ownerID)
		if err != nil {
			return nil, err
		}
		extraPaths, extraCount, extraFreed, err := s.purgeFilesInFolders(ctx, folderIDsOf(pending))
		if err != nil {
			return nil, err
		}
		blobPaths = append(blobPaths, extraPaths...)
		freed += extraFreed

		folders, err := s.folderRepo.PurgeAllTrashedForOwner(ctx, ownerID)
		if err != nil {
			return nil, err
		}
		foldersRemoved = len(folders)

		go func(paths []string) {
			for _, p := range paths {
				_ = s.storage.Delete(p)
			}
		}(blobPaths)

		return &EmptyTrashResult{
			RemovedFiles:   len(files) + extraCount,
			RemovedFolders: foldersRemoved,
			FreedBytes:     freed,
		}, nil
	}

	go func(paths []string) {
		for _, p := range paths {
			_ = s.storage.Delete(p)
		}
	}(blobPaths)

	return &EmptyTrashResult{
		RemovedFiles:   len(files),
		RemovedFolders: foldersRemoved,
		FreedBytes:     freed,
	}, nil
}

// StartTrashPurge starts a background goroutine that purges old trash items.
func (s *FileService) StartTrashPurge(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				days := adminsettings.TrashAutoEmptyDays()
				if days <= 0 {
					continue
				}
				files, err := s.fileRepo.PurgeOldTrashed(ctx, days)
				if err != nil {
					log.Printf("trash purge error: %v", err)
					continue
				}
				for _, f := range files {
					_ = s.storage.Delete(f.BlobPath)
					_ = s.userRepo.UpdateUsedBytes(ctx, f.OwnerID, -f.EncryptedSize)
				}
				if s.folderRepo != nil {
					pending, err := s.folderRepo.ListOldTrashed(ctx, days)
					if err != nil {
						log.Printf("list old trashed folders error: %v", err)
						continue
					}
					extraPaths, _, _, err := s.purgeFilesInFolders(ctx, folderIDsOf(pending))
					if err != nil {
						log.Printf("purge files in old trashed folders error: %v", err)
						continue
					}
					for _, p := range extraPaths {
						_ = s.storage.Delete(p)
					}
					folders, err := s.folderRepo.PurgeOldTrashed(ctx, days)
					if err != nil {
						log.Printf("folder trash purge error: %v", err)
					} else if len(folders) > 0 {
						log.Printf("purged %d old trashed folders", len(folders))
					}
				}
				if len(files) > 0 {
					log.Printf("purged %d old trash items", len(files))
				}
			}
		}
	}()
}

// RecordDownload logs a file download in the activity log.
func (s *FileService) RecordDownload(ctx context.Context, userID, fileID, fileName string) {
	s.logActivity(ctx, userID, domain.ActionDownload, "file", fileID, fileName, "")
}

func (s *FileService) logActivity(ctx context.Context, userID string, action domain.ActivityAction, targetType, targetID, targetName, metadata string) {
	_ = s.activityRepo.Create(ctx, &domain.ActivityLog{
		UserID:     userID,
		Action:     action,
		TargetType: targetType,
		TargetID:   targetID,
		TargetName: targetName,
		Metadata:   metadata,
	})
}

// UpdateContent replaces the encrypted blob for an existing file and creates a version snapshot.
func (s *FileService) UpdateContent(ctx context.Context, fileID, userID, name, mimeType, iv string, originalSize int64, r io.Reader) (*domain.File, error) {
	if err := s.access.CanWriteFile(ctx, fileID, userID); err != nil {
		return nil, err
	}
	file, err := s.fileRepo.GetByID(ctx, fileID)
	if err != nil {
		return nil, err
	}
	if file == nil {
		return nil, fmt.Errorf("file not found")
	}

	// Create a snapshot of current state before replacing content.
	if adminsettings.VersioningEnabled() {
		_ = s.fileRepo.CreateVersion(ctx, &domain.FileVersion{
			FileID:    file.ID,
			Version:   file.Version,
			Size:      file.Size,
			BlobPath:  file.BlobPath,
			IV:        file.IV,
			CreatedBy: userID,
		})
	}

	newBlobPath, newEncryptedSize, err := s.storage.Save(userID, r)
	if err != nil {
		return nil, err
	}

	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		_ = s.storage.Delete(newBlobPath)
		return nil, err
	}
	if user == nil {
		_ = s.storage.Delete(newBlobPath)
		return nil, fmt.Errorf("user not found")
	}

	newUsed := user.UsedBytes - file.EncryptedSize + newEncryptedSize
	if newUsed > user.QuotaBytes {
		_ = s.storage.Delete(newBlobPath)
		return nil, fmt.Errorf("quota exceeded")
	}
	if err := s.checkServerCapacity(ctx, newEncryptedSize-file.EncryptedSize); err != nil {
		_ = s.storage.Delete(newBlobPath)
		return nil, err
	}

	oldBlobPath := file.BlobPath
	oldEncryptedSize := file.EncryptedSize

	if name != "" {
		file.Name = name
	}
	if mimeType != "" {
		file.MimeType = mimeType
	}
	if originalSize > 0 {
		file.Size = originalSize
	}
	file.EncryptedSize = newEncryptedSize
	file.BlobPath = newBlobPath
	file.IV = iv
	file.Version += 1
	file.AccessedAt = time.Now()

	if err := s.fileRepo.Update(ctx, file); err != nil {
		_ = s.storage.Delete(newBlobPath)
		return nil, err
	}

	if err := s.userRepo.UpdateUsedBytes(ctx, userID, newEncryptedSize-oldEncryptedSize); err != nil {
		return nil, err
	}

	_ = s.storage.Delete(oldBlobPath)
	if adminsettings.VersioningEnabled() {
		if removed, err := s.fileRepo.DeleteOldVersions(ctx, file.ID, adminsettings.KeepVersions()); err == nil {
			for _, v := range removed {
				_ = s.storage.Delete(v.BlobPath)
			}
		}
	}
	s.logActivity(ctx, userID, domain.ActionUpload, "file", file.ID, file.Name, `{"updated":true}`)

	if s.syncChange != nil {
		_ = s.syncChange.RecordFileUpdate(ctx, file)
	}

	return file, nil
}

// UpdateContentFromBlob is like UpdateContent but uses an already-written blob path
// (e.g. after a resumable upload session is assembled on disk).
func (s *FileService) UpdateContentFromBlob(
	ctx context.Context,
	fileID, userID, name, mimeType, iv string,
	originalSize, encryptedSize int64,
	blobPath string,
) (*domain.File, error) {
	if err := s.access.CanWriteFile(ctx, fileID, userID); err != nil {
		_ = s.storage.Delete(blobPath)
		return nil, err
	}
	file, err := s.fileRepo.GetByID(ctx, fileID)
	if err != nil {
		_ = s.storage.Delete(blobPath)
		return nil, err
	}
	if file == nil {
		_ = s.storage.Delete(blobPath)
		return nil, fmt.Errorf("file not found")
	}

	if adminsettings.VersioningEnabled() {
		_ = s.fileRepo.CreateVersion(ctx, &domain.FileVersion{
			FileID:    file.ID,
			Version:   file.Version,
			Size:      file.Size,
			BlobPath:  file.BlobPath,
			IV:        file.IV,
			CreatedBy: userID,
		})
	}

	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		_ = s.storage.Delete(blobPath)
		return nil, err
	}
	if user == nil {
		_ = s.storage.Delete(blobPath)
		return nil, fmt.Errorf("user not found")
	}

	newUsed := user.UsedBytes - file.EncryptedSize + encryptedSize
	if newUsed > user.QuotaBytes {
		_ = s.storage.Delete(blobPath)
		return nil, fmt.Errorf("quota exceeded")
	}
	if err := s.checkServerCapacity(ctx, encryptedSize-file.EncryptedSize); err != nil {
		_ = s.storage.Delete(blobPath)
		return nil, err
	}

	oldBlobPath := file.BlobPath
	oldEncryptedSize := file.EncryptedSize

	if name != "" {
		file.Name = name
	}
	if mimeType != "" {
		file.MimeType = mimeType
	}
	if originalSize > 0 {
		file.Size = originalSize
	}
	file.EncryptedSize = encryptedSize
	file.BlobPath = blobPath
	file.IV = iv
	file.Version += 1
	file.AccessedAt = time.Now()

	if err := s.fileRepo.Update(ctx, file); err != nil {
		_ = s.storage.Delete(blobPath)
		return nil, err
	}

	if err := s.userRepo.UpdateUsedBytes(ctx, userID, encryptedSize-oldEncryptedSize); err != nil {
		return nil, err
	}

	_ = s.storage.Delete(oldBlobPath)
	if adminsettings.VersioningEnabled() {
		if removed, err := s.fileRepo.DeleteOldVersions(ctx, file.ID, adminsettings.KeepVersions()); err == nil {
			for _, v := range removed {
				_ = s.storage.Delete(v.BlobPath)
			}
		}
	}
	s.logActivity(ctx, userID, domain.ActionUpload, "file", file.ID, file.Name, `{"updated":true}`)

	if s.syncChange != nil {
		_ = s.syncChange.RecordFileUpdate(ctx, file)
	}

	return file, nil
}

// RestoreVersion restores a historical version as the latest file content.
func (s *FileService) RestoreVersion(ctx context.Context, fileID, userID string, version int) (*domain.File, error) {
	if err := s.access.CanWriteFile(ctx, fileID, userID); err != nil {
		return nil, err
	}
	file, err := s.fileRepo.GetByID(ctx, fileID)
	if err != nil {
		return nil, err
	}
	if file == nil {
		return nil, fmt.Errorf("file not found")
	}

	if adminsettings.VersioningEnabled() {
		_ = s.fileRepo.CreateVersion(ctx, &domain.FileVersion{
			FileID:    file.ID,
			Version:   file.Version,
			Size:      file.Size,
			BlobPath:  file.BlobPath,
			IV:        file.IV,
			CreatedBy: userID,
		})
	}

	v, err := s.fileRepo.GetVersion(ctx, fileID, version)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, fmt.Errorf("version not found")
	}

	reader, err := s.storage.Get(v.BlobPath)
	if err != nil {
		return nil, err
	}
	defer reader.Close()

	newBlobPath, newEncryptedSize, err := s.storage.Save(userID, reader)
	if err != nil {
		return nil, err
	}

	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		_ = s.storage.Delete(newBlobPath)
		return nil, err
	}
	if user == nil {
		_ = s.storage.Delete(newBlobPath)
		return nil, fmt.Errorf("user not found")
	}

	newUsed := user.UsedBytes - file.EncryptedSize + newEncryptedSize
	if newUsed > user.QuotaBytes {
		_ = s.storage.Delete(newBlobPath)
		return nil, fmt.Errorf("quota exceeded")
	}
	if err := s.checkServerCapacity(ctx, newEncryptedSize-file.EncryptedSize); err != nil {
		_ = s.storage.Delete(newBlobPath)
		return nil, err
	}

	oldBlobPath := file.BlobPath
	oldEncryptedSize := file.EncryptedSize

	file.BlobPath = newBlobPath
	file.EncryptedSize = newEncryptedSize
	file.Size = v.Size
	file.IV = v.IV
	file.Version += 1
	file.AccessedAt = time.Now()

	if err := s.fileRepo.Update(ctx, file); err != nil {
		_ = s.storage.Delete(newBlobPath)
		return nil, err
	}

	if err := s.userRepo.UpdateUsedBytes(ctx, userID, newEncryptedSize-oldEncryptedSize); err != nil {
		return nil, err
	}

	_ = s.storage.Delete(oldBlobPath)
	s.logActivity(ctx, userID, domain.ActionRestore, "file", file.ID, file.Name, fmt.Sprintf(`{"version":%d}`, version))

	return file, nil
}

func (s *FileService) checkServerCapacity(ctx context.Context, additionalBytes int64) error {
	cap := adminsettings.TotalCapacityBytes()
	if cap <= 0 || additionalBytes <= 0 {
		return nil
	}
	used, err := s.fileRepo.SumAllEncryptedSize(ctx)
	if err != nil {
		return err
	}
	if used+additionalBytes > cap {
		return fmt.Errorf("server storage capacity exceeded")
	}
	return nil
}
