package service

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
)

// SyncChangeService records mutations in the computer sync change feed.
type SyncChangeService struct {
	changeRepo   repository.SyncChangeRepository
	computerRepo repository.ComputerRepository
}

// NewSyncChangeService creates a sync change recorder.
func NewSyncChangeService(
	changeRepo repository.SyncChangeRepository,
	computerRepo repository.ComputerRepository,
) *SyncChangeService {
	return &SyncChangeService{
		changeRepo:   changeRepo,
		computerRepo: computerRepo,
	}
}

func (s *SyncChangeService) recordFolder(ctx context.Context, folder *domain.Folder, operation string, payload domain.SyncChangePayload) error {
	if folder == nil {
		return nil
	}
	computer, err := s.computerRepo.GetComputerForFolder(ctx, folder.ID)
	if err != nil || computer == nil {
		return err
	}
	raw, _ := json.Marshal(payload)
	change := &domain.SyncChange{
		UserID:         folder.OwnerID,
		ComputerRootID: computer.RootFolderID,
		EntityType:     domain.SyncEntityFolder,
		EntityID:       folder.ID,
		ParentID:       folder.ParentID,
		Operation:      operation,
		Name:           folder.Name,
		Version:        0,
		OccurredAt:     time.Now(),
		Payload:        raw,
		IsTombstone:    operation == domain.SyncOpPermanentDelete,
	}
	return s.changeRepo.Append(ctx, change)
}

func (s *SyncChangeService) recordFile(ctx context.Context, file *domain.File, operation string, payload domain.SyncChangePayload) error {
	if file == nil {
		return nil
	}
	folderID := ""
	if file.FolderID != nil {
		folderID = *file.FolderID
	}
	if folderID == "" {
		return nil
	}
	computer, err := s.computerRepo.GetComputerForFolder(ctx, folderID)
	if err != nil || computer == nil {
		return err
	}
	if payload.MimeType == "" {
		payload.MimeType = file.MimeType
	}
	if payload.Size == 0 {
		payload.Size = file.Size
	}
	if payload.EncryptedSize == 0 {
		payload.EncryptedSize = file.EncryptedSize
	}
	if payload.UpdatedAt == "" {
		payload.UpdatedAt = file.UpdatedAt.Format(time.RFC3339)
	}
	raw, _ := json.Marshal(payload)
	parentID := file.FolderID
	change := &domain.SyncChange{
		UserID:         file.OwnerID,
		ComputerRootID: computer.RootFolderID,
		EntityType:     domain.SyncEntityFile,
		EntityID:       file.ID,
		ParentID:       parentID,
		Operation:      operation,
		Name:           file.Name,
		Version:        file.Version,
		OccurredAt:     time.Now(),
		Payload:        raw,
		IsTombstone:    operation == domain.SyncOpPermanentDelete,
	}
	return s.changeRepo.Append(ctx, change)
}

// RecordFolderCreate records folder creation in the computer tree.
func (s *SyncChangeService) RecordFolderCreate(ctx context.Context, folder *domain.Folder) error {
	return s.recordFolder(ctx, folder, domain.SyncOpCreate, domain.SyncChangePayload{})
}

// RecordFolderRename records a folder rename.
func (s *SyncChangeService) RecordFolderRename(ctx context.Context, folder *domain.Folder, oldName string) error {
	return s.recordFolder(ctx, folder, domain.SyncOpRename, domain.SyncChangePayload{OldName: oldName})
}

// RecordFolderMove records a folder move.
func (s *SyncChangeService) RecordFolderMove(ctx context.Context, folder *domain.Folder, oldParentID string) error {
	return s.recordFolder(ctx, folder, domain.SyncOpMove, domain.SyncChangePayload{OldParentID: oldParentID})
}

// RecordFolderTrash records moving a folder to trash.
func (s *SyncChangeService) RecordFolderTrash(ctx context.Context, folder *domain.Folder) error {
	return s.recordFolder(ctx, folder, domain.SyncOpTrash, domain.SyncChangePayload{})
}

// RecordFolderRestore records restoring a folder from trash.
func (s *SyncChangeService) RecordFolderRestore(ctx context.Context, folder *domain.Folder) error {
	return s.recordFolder(ctx, folder, domain.SyncOpRestore, domain.SyncChangePayload{})
}

// RecordFolderPermanentDelete records permanent folder deletion.
func (s *SyncChangeService) RecordFolderPermanentDelete(ctx context.Context, folder *domain.Folder) error {
	return s.recordFolder(ctx, folder, domain.SyncOpPermanentDelete, domain.SyncChangePayload{})
}

// RecordFileCreate records file creation in the computer tree.
func (s *SyncChangeService) RecordFileCreate(ctx context.Context, file *domain.File) error {
	return s.recordFile(ctx, file, domain.SyncOpCreate, domain.SyncChangePayload{})
}

// RecordFileUpdate records file content/metadata update.
func (s *SyncChangeService) RecordFileUpdate(ctx context.Context, file *domain.File) error {
	return s.recordFile(ctx, file, domain.SyncOpUpdate, domain.SyncChangePayload{})
}

// RecordFileRename records a file rename.
func (s *SyncChangeService) RecordFileRename(ctx context.Context, file *domain.File, oldName string) error {
	return s.recordFile(ctx, file, domain.SyncOpRename, domain.SyncChangePayload{OldName: oldName})
}

// RecordFileMove records a file move.
func (s *SyncChangeService) RecordFileMove(ctx context.Context, file *domain.File, oldParentID string) error {
	return s.recordFile(ctx, file, domain.SyncOpMove, domain.SyncChangePayload{OldParentID: oldParentID})
}

// RecordFileTrash records moving a file to trash.
func (s *SyncChangeService) RecordFileTrash(ctx context.Context, file *domain.File) error {
	return s.recordFile(ctx, file, domain.SyncOpTrash, domain.SyncChangePayload{})
}

// RecordFileRestore records restoring a file from trash.
func (s *SyncChangeService) RecordFileRestore(ctx context.Context, file *domain.File) error {
	return s.recordFile(ctx, file, domain.SyncOpRestore, domain.SyncChangePayload{})
}

// RecordFilePermanentDelete records permanent file deletion.
func (s *SyncChangeService) RecordFilePermanentDelete(ctx context.Context, file *domain.File) error {
	return s.recordFile(ctx, file, domain.SyncOpPermanentDelete, domain.SyncChangePayload{})
}

// SyncFeedService serves snapshots and change pages for desktop sync.
type SyncFeedService struct {
	changeRepo   repository.SyncChangeRepository
	computerRepo repository.ComputerRepository
	folderRepo   repository.FolderRepository
	fileRepo     repository.FileRepository
}

// NewSyncFeedService creates a sync feed service.
func NewSyncFeedService(
	changeRepo repository.SyncChangeRepository,
	computerRepo repository.ComputerRepository,
	folderRepo repository.FolderRepository,
	fileRepo repository.FileRepository,
) *SyncFeedService {
	return &SyncFeedService{
		changeRepo:   changeRepo,
		computerRepo: computerRepo,
		folderRepo:   folderRepo,
		fileRepo:     fileRepo,
	}
}

// Snapshot returns the full computer tree and a cursor boundary.
func (s *SyncFeedService) Snapshot(ctx context.Context, ownerID, computerID string) (*domain.ComputerSnapshot, error) {
	computer, err := s.computerRepo.GetByID(ctx, computerID)
	if err != nil {
		return nil, err
	}
	if computer == nil || computer.OwnerID != ownerID {
		return nil, fmt.Errorf("computer not found")
	}

	cursor, _, err := s.changeRepo.SnapshotBoundary(ctx, ownerID, computer.RootFolderID)
	if err != nil {
		return nil, err
	}

	subtreeIDs, err := s.folderRepo.ListSubtreeIDs(ctx, computer.RootFolderID)
	if err != nil {
		return nil, err
	}
	allFolderIDs := append([]string{computer.RootFolderID}, subtreeIDs...)

	var folders []domain.Folder
	for _, id := range allFolderIDs {
		f, err := s.folderRepo.GetByID(ctx, id)
		if err != nil {
			return nil, err
		}
		if f != nil && !f.IsTrashed {
			folders = append(folders, *f)
		}
	}

	files, err := s.fileRepo.GetByFolderIDs(ctx, allFolderIDs)
	if err != nil {
		return nil, err
	}
	activeFiles := make([]domain.File, 0, len(files))
	for _, f := range files {
		if !f.IsTrashed {
			activeFiles = append(activeFiles, f)
		}
	}

	return &domain.ComputerSnapshot{
		Cursor:  cursor,
		Folders: folders,
		Files:   activeFiles,
	}, nil
}

// ListChanges returns changes after cursor for a computer.
func (s *SyncFeedService) ListChanges(ctx context.Context, ownerID, computerID string, cursor int64, limit int) (*domain.SyncChangesPage, error) {
	computer, err := s.computerRepo.GetByID(ctx, computerID)
	if err != nil {
		return nil, err
	}
	if computer == nil || computer.OwnerID != ownerID {
		return nil, fmt.Errorf("computer not found")
	}

	changes, err := s.changeRepo.ListSince(ctx, ownerID, computer.RootFolderID, cursor, limit)
	if err != nil {
		return nil, err
	}
	if changes == nil {
		changes = []domain.SyncChange{}
	}

	nextCursor := cursor
	for _, c := range changes {
		if c.Operation == "snapshot" {
			continue
		}
		if c.Seq > nextCursor {
			nextCursor = c.Seq
		}
	}

	return &domain.SyncChangesPage{
		Changes:    changes,
		NextCursor: nextCursor,
	}, nil
}

// RecordClientMutation deduplicates client mutation IDs.
func RecordClientMutation(ctx context.Context, repo repository.ClientMutationRepository, userID, mutationID string) (bool, error) {
	return repo.TryRecord(ctx, userID, mutationID)
}

// ClientMutationSeen reports whether a mutation was already applied.
func ClientMutationSeen(ctx context.Context, repo repository.ClientMutationRepository, userID, mutationID string) (bool, error) {
	return repo.Exists(ctx, userID, mutationID)
}
