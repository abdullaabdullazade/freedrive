package service

import (
	"context"
	"fmt"
	"strconv"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
	"github.com/abdullaabdullazade/freedrive/internal/storage"
)

// FolderService handles folder business logic.
type FolderService struct {
	folderRepo   repository.FolderRepository
	fileRepo     repository.FileRepository
	userRepo     repository.UserRepository
	storage      *storage.DiskStorage
	activityRepo repository.ActivityRepository
	computerRepo repository.ComputerRepository
	access       *AccessService
	syncChange   *SyncChangeService
}

// NewFolderService creates a new folder service.
func NewFolderService(
	folderRepo repository.FolderRepository,
	fileRepo repository.FileRepository,
	userRepo repository.UserRepository,
	store *storage.DiskStorage,
	activityRepo repository.ActivityRepository,
	computerRepo repository.ComputerRepository,
	access *AccessService,
	syncChange *SyncChangeService,
) *FolderService {
	return &FolderService{
		folderRepo:   folderRepo,
		fileRepo:     fileRepo,
		userRepo:     userRepo,
		storage:      store,
		activityRepo: activityRepo,
		computerRepo: computerRepo,
		access:       access,
		syncChange:   syncChange,
	}
}

// Create creates a new folder. If a live folder with the same parent+name already
// exists, it is returned (idempotent). If a trashed folder with that name exists,
// it is renamed in the bin to free UNIQUE(parent_id,name,owner_id) and a new live
// folder is created — never auto-restored into My Drive (that would undo a
// mobile/web Move to bin when desktop sync retries create_or_resolve).
func (s *FolderService) Create(ctx context.Context, folder *domain.Folder) error {
	if folder.ParentID != nil && *folder.ParentID != "" {
		if err := s.access.CanWriteFolder(ctx, *folder.ParentID, folder.OwnerID); err != nil {
			return err
		}
		parent, err := s.folderRepo.GetByID(ctx, *folder.ParentID)
		if err != nil {
			return err
		}
		if parent == nil {
			return fmt.Errorf("parent folder not found")
		}
		if parent.IsTrashed {
			return fmt.Errorf("cannot create folder inside a trashed folder")
		}
	}

	existing, err := s.folderRepo.GetByParentName(ctx, folder.ParentID, folder.Name, folder.OwnerID)
	if err != nil {
		return err
	}
	if existing != nil {
		if !existing.IsTrashed {
			*folder = *existing
			return nil
		}
		suffix := existing.ID
		if len(suffix) > 8 {
			suffix = suffix[:8]
		}
		existing.Name = fmt.Sprintf("%s (bin %s)", existing.Name, suffix)
		if err := s.folderRepo.Update(ctx, existing); err != nil {
			return err
		}
	}

	if err := s.folderRepo.Create(ctx, folder); err != nil {
		return err
	}

	_ = s.activityRepo.Create(ctx, &domain.ActivityLog{
		UserID:     folder.OwnerID,
		Action:     domain.ActionCreate,
		TargetType: "folder",
		TargetID:   folder.ID,
		TargetName: folder.Name,
	})
	if s.syncChange != nil {
		_ = s.syncChange.RecordFolderCreate(ctx, folder)
	}
	return nil
}

// GetContents returns a folder's children (folders + paginated files).
// Child folders are always returned in full when offset is 0; subsequent pages
// return an empty folders slice so clients keep the first-page folder list.
func (s *FolderService) GetContents(ctx context.Context, folderID *string, ownerID string, opts domain.FolderContentsOptions) (*domain.FolderContents, error) {
	var folder *domain.Folder
	listOwner := ownerID
	if folderID != nil {
		var err error
		folder, err = s.folderRepo.GetByID(ctx, *folderID)
		if err != nil {
			return nil, err
		}
		if folder == nil {
			return nil, fmt.Errorf("folder not found")
		}
		if err := s.access.CanReadFolder(ctx, *folderID, ownerID); err != nil {
			return nil, err
		}
		listOwner = folder.OwnerID
	}

	pageSize := opts.PageSize
	if pageSize < 1 {
		pageSize = 100
	}
	if pageSize > 500 {
		pageSize = 500
	}
	offset := 0
	if opts.PageToken != "" {
		n, err := strconv.Atoi(opts.PageToken)
		if err != nil || n < 0 {
			return nil, fmt.Errorf("invalid page_token")
		}
		offset = n
	}

	var folders []domain.Folder
	if offset == 0 {
		var err error
		folders, err = s.folderRepo.GetChildren(ctx, folderID, listOwner)
		if err != nil {
			return nil, err
		}
		if folders == nil {
			folders = []domain.Folder{}
		}
	} else {
		folders = []domain.Folder{}
	}

	files, total, err := s.fileRepo.GetByFolderIDPage(ctx, folderID, listOwner, pageSize, offset)
	if err != nil {
		return nil, err
	}
	if files == nil {
		files = []domain.File{}
	}

	next := ""
	if offset+len(files) < total {
		next = strconv.Itoa(offset + len(files))
	}

	return &domain.FolderContents{
		Folder:        folder,
		Folders:       folders,
		Files:         files,
		NextPageToken: next,
		TotalFiles:    total,
	}, nil
}

// ListAll returns all of an owner's folders (flat), optionally filtered by name.
func (s *FolderService) ListAll(ctx context.Context, ownerID, search string) ([]domain.Folder, error) {
	return s.folderRepo.ListAll(ctx, ownerID, search)
}

// Get returns a single folder the user can read (used by PATCH response).
func (s *FolderService) Get(ctx context.Context, folderID, ownerID string) (*domain.Folder, error) {
	if err := s.access.CanReadFolder(ctx, folderID, ownerID); err != nil {
		return nil, err
	}
	folder, err := s.folderRepo.GetByID(ctx, folderID)
	if err != nil {
		return nil, err
	}
	if folder == nil {
		return nil, fmt.Errorf("folder not found")
	}
	return folder, nil
}

// Rename renames a folder.
func (s *FolderService) Rename(ctx context.Context, folderID, ownerID, newName string) error {
	if err := s.access.CanWriteFolder(ctx, folderID, ownerID); err != nil {
		return err
	}
	folder, err := s.folderRepo.GetByID(ctx, folderID)
	if err != nil {
		return err
	}
	if folder == nil {
		return fmt.Errorf("folder not found")
	}

	oldName := folder.Name
	folder.Name = newName
	if err := s.folderRepo.Update(ctx, folder); err != nil {
		return err
	}
	if s.syncChange != nil {
		_ = s.syncChange.RecordFolderRename(ctx, folder, oldName)
	}
	return nil
}

// Move moves a folder to a new parent.
func (s *FolderService) Move(ctx context.Context, folderID, ownerID string, newParentID *string) error {
	if err := s.access.CanWriteFolder(ctx, folderID, ownerID); err != nil {
		return err
	}
	folder, err := s.folderRepo.GetByID(ctx, folderID)
	if err != nil {
		return err
	}
	if folder == nil {
		return fmt.Errorf("folder not found")
	}

	if newParentID != nil && *newParentID != "" {
		if err := s.access.CanWriteFolder(ctx, *newParentID, ownerID); err != nil {
			return err
		}
	}

	isComputerRoot, err := s.computerRepo.IsComputerRoot(ctx, folderID)
	if err != nil {
		return err
	}
	if isComputerRoot {
		return fmt.Errorf("cannot move a registered computer folder")
	}

	sourceInComputer, err := s.computerRepo.IsInComputerTree(ctx, folderID)
	if err != nil {
		return err
	}

	var destInComputer bool
	if newParentID != nil {
		destInComputer, err = s.computerRepo.IsInComputerTree(ctx, *newParentID)
		if err != nil {
			return err
		}
	}

	if sourceInComputer != destInComputer {
		return fmt.Errorf("cannot move items between My Drive and Computers")
	}

	// Prevent moving folder into its own descendant
	if newParentID != nil {
		isDesc, err := s.folderRepo.IsDescendant(ctx, folderID, *newParentID)
		if err != nil {
			return err
		}
		if isDesc {
			return fmt.Errorf("cannot move folder into its own subfolder")
		}
	}

	oldParent := ""
	if folder.ParentID != nil {
		oldParent = *folder.ParentID
	}
	folder.ParentID = newParentID
	if err := s.folderRepo.Update(ctx, folder); err != nil {
		return err
	}
	if s.syncChange != nil {
		_ = s.syncChange.RecordFolderMove(ctx, folder, oldParent)
	}
	return nil
}

// Delete moves a folder and all its contents to trash.
func (s *FolderService) Delete(ctx context.Context, folderID, ownerID string) error {
	if err := s.access.CanWriteFolder(ctx, folderID, ownerID); err != nil {
		return err
	}
	folder, err := s.folderRepo.GetByID(ctx, folderID)
	if err != nil {
		return err
	}
	if folder == nil {
		return fmt.Errorf("folder not found")
	}

	isComputerRoot, err := s.computerRepo.IsComputerRoot(ctx, folderID)
	if err != nil {
		return err
	}
	if isComputerRoot {
		return fmt.Errorf("cannot delete a registered computer folder; remove the device from Computers instead")
	}

	// Soft-delete the whole subtree so files are not orphaned to root and the
	// folder can be restored as a whole.
	if err := s.folderRepo.MoveToTrash(ctx, folderID); err != nil {
		return err
	}

	_ = s.activityRepo.Create(ctx, &domain.ActivityLog{
		UserID:     ownerID,
		Action:     domain.ActionDelete,
		TargetType: "folder",
		TargetID:   folderID,
		TargetName: folder.Name,
	})
	if s.syncChange != nil {
		_ = s.syncChange.RecordFolderTrash(ctx, folder)
	}
	return nil
}

// ListTrash returns the roots of the owner's trashed folder subtrees.
func (s *FolderService) ListTrash(ctx context.Context, ownerID string) ([]domain.Folder, error) {
	return s.folderRepo.GetTrashedFolders(ctx, ownerID)
}

// Restore restores a trashed folder and its whole subtree.
func (s *FolderService) Restore(ctx context.Context, folderID, ownerID string) error {
	folder, err := s.folderRepo.GetByID(ctx, folderID)
	if err != nil {
		return err
	}
	if folder == nil || folder.OwnerID != ownerID {
		return fmt.Errorf("folder not found")
	}

	if err := s.folderRepo.RestoreFromTrash(ctx, folderID); err != nil {
		return err
	}

	_ = s.activityRepo.Create(ctx, &domain.ActivityLog{
		UserID:     ownerID,
		Action:     domain.ActionRestore,
		TargetType: "folder",
		TargetID:   folderID,
		TargetName: folder.Name,
	})
	if s.syncChange != nil {
		_ = s.syncChange.RecordFolderRestore(ctx, folder)
	}
	return nil
}

// PermanentDelete removes a folder subtree together with every contained file's
// blob, refunds quota, and deletes the folder rows.
func (s *FolderService) PermanentDelete(ctx context.Context, folderID, ownerID string) error {
	folder, err := s.folderRepo.GetByID(ctx, folderID)
	if err != nil {
		return err
	}
	if folder == nil || folder.OwnerID != ownerID {
		return fmt.Errorf("folder not found")
	}

	ids, err := s.folderRepo.ListSubtreeIDs(ctx, folderID)
	if err != nil {
		return err
	}

	files, err := s.fileRepo.GetByFolderIDs(ctx, ids)
	if err != nil {
		return err
	}

	for _, f := range files {
		if f.OwnerID != ownerID {
			continue
		}
		// Remove version blobs
		versions, _ := s.fileRepo.GetVersions(ctx, f.ID)
		for _, v := range versions {
			_ = s.storage.Delete(v.BlobPath)
		}
		// Remove main blob
		_ = s.storage.Delete(f.BlobPath)
		if err := s.fileRepo.Delete(ctx, f.ID); err != nil {
			return err
		}
		_ = s.userRepo.UpdateUsedBytes(ctx, ownerID, -f.EncryptedSize)
	}

	// Deleting the root folder cascades removal of descendant folder rows.
	if err := s.folderRepo.Delete(ctx, folderID); err != nil {
		return err
	}

	_ = s.activityRepo.Create(ctx, &domain.ActivityLog{
		UserID:     ownerID,
		Action:     domain.ActionDelete,
		TargetType: "folder",
		TargetID:   folderID,
		TargetName: folder.Name,
	})
	if s.syncChange != nil {
		_ = s.syncChange.RecordFolderPermanentDelete(ctx, folder)
	}
	return nil
}

// ToggleStar toggles starred status.
func (s *FolderService) ToggleStar(ctx context.Context, folderID, ownerID string) error {
	if err := s.access.CanWriteFolder(ctx, folderID, ownerID); err != nil {
		return err
	}
	folder, err := s.folderRepo.GetByID(ctx, folderID)
	if err != nil {
		return err
	}
	if folder == nil {
		return fmt.Errorf("folder not found")
	}

	folder.IsStarred = !folder.IsStarred
	return s.folderRepo.Update(ctx, folder)
}

// SetColor sets a folder's color label.
func (s *FolderService) SetColor(ctx context.Context, folderID, ownerID, color string) error {
	if err := s.access.CanWriteFolder(ctx, folderID, ownerID); err != nil {
		return err
	}
	folder, err := s.folderRepo.GetByID(ctx, folderID)
	if err != nil {
		return err
	}
	if folder == nil {
		return fmt.Errorf("folder not found")
	}

	folder.Color = color
	return s.folderRepo.Update(ctx, folder)
}

// GetBreadcrumb returns the path from root to the given folder.
func (s *FolderService) GetBreadcrumb(ctx context.Context, folderID, userID string) ([]domain.Breadcrumb, error) {
	if err := s.access.CanReadFolder(ctx, folderID, userID); err != nil {
		return nil, err
	}
	return s.folderRepo.GetBreadcrumb(ctx, folderID)
}
