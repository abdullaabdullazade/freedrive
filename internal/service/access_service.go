package service

import (
	"context"
	"fmt"
	"strings"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
)

// AccessService evaluates file and folder permissions including shares.
type AccessService struct {
	shareRepo  repository.ShareRepository
	fileRepo   repository.FileRepository
	folderRepo repository.FolderRepository
}

// NewAccessService creates an access service.
func NewAccessService(
	shareRepo repository.ShareRepository,
	fileRepo repository.FileRepository,
	folderRepo repository.FolderRepository,
) *AccessService {
	return &AccessService{
		shareRepo:  shareRepo,
		fileRepo:   fileRepo,
		folderRepo: folderRepo,
	}
}

// ParsePermission maps UI and API permission strings to domain permissions.
func ParsePermission(value string) domain.Permission {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "viewer", "read":
		return domain.PermRead
	case "commenter":
		return domain.PermRead
	case "editor", "write":
		return domain.PermWrite
	case "upload":
		return domain.PermUpload
	default:
		return domain.PermRead
	}
}

func permissionRank(p domain.Permission) int {
	switch p {
	case domain.PermRead:
		return 1
	case domain.PermWrite:
		return 2
	case domain.PermUpload:
		return 3
	default:
		return 0
	}
}

func strongerPermission(current, candidate domain.Permission) domain.Permission {
	if permissionRank(candidate) > permissionRank(current) {
		return candidate
	}
	return current
}

// FilePermission returns the effective permission for a user on a file.
func (s *AccessService) FilePermission(ctx context.Context, fileID, userID string) (domain.Permission, error) {
	file, err := s.fileRepo.GetByID(ctx, fileID)
	if err != nil {
		return "", err
	}
	if file == nil {
		return "", fmt.Errorf("file not found")
	}
	if file.OwnerID == userID {
		return domain.PermWrite, nil
	}

	perm, ok, err := s.effectiveSharePermission(ctx, userID, fileID, file.FolderID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("access denied")
	}
	return perm, nil
}

// FolderPermission returns the effective permission for a user on a folder.
func (s *AccessService) FolderPermission(ctx context.Context, folderID, userID string) (domain.Permission, error) {
	folder, err := s.folderRepo.GetByID(ctx, folderID)
	if err != nil {
		return "", err
	}
	if folder == nil {
		return "", fmt.Errorf("folder not found")
	}
	if folder.OwnerID == userID {
		return domain.PermWrite, nil
	}

	perm, ok, err := s.effectiveSharePermission(ctx, userID, "", &folderID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("access denied")
	}
	return perm, nil
}

// CanReadFile reports whether the user may read/download a file.
func (s *AccessService) CanReadFile(ctx context.Context, fileID, userID string) error {
	_, err := s.FilePermission(ctx, fileID, userID)
	return err
}

// CanWriteFile reports whether the user may modify a file.
func (s *AccessService) CanWriteFile(ctx context.Context, fileID, userID string) error {
	perm, err := s.FilePermission(ctx, fileID, userID)
	if err != nil {
		return err
	}
	if permissionRank(perm) < permissionRank(domain.PermWrite) {
		return fmt.Errorf("access denied")
	}
	return nil
}

// CanWriteFolder reports whether the user may modify a folder.
func (s *AccessService) CanWriteFolder(ctx context.Context, folderID, userID string) error {
	perm, err := s.FolderPermission(ctx, folderID, userID)
	if err != nil {
		return err
	}
	if permissionRank(perm) < permissionRank(domain.PermWrite) {
		return fmt.Errorf("access denied")
	}
	return nil
}

// CanReadFolder reports whether the user may view a folder.
func (s *AccessService) CanReadFolder(ctx context.Context, folderID, userID string) error {
	_, err := s.FolderPermission(ctx, folderID, userID)
	return err
}

func (s *AccessService) effectiveSharePermission(ctx context.Context, userID, fileID string, folderID *string) (domain.Permission, bool, error) {
	shares, err := s.shareRepo.ListSharedWithUser(ctx, userID)
	if err != nil {
		return "", false, err
	}

	folderSet := map[string]bool{}
	if folderID != nil && *folderID != "" {
		crumbs, err := s.folderRepo.GetBreadcrumb(ctx, *folderID)
		if err != nil {
			return "", false, err
		}
		for _, crumb := range crumbs {
			folderSet[crumb.ID] = true
		}
	}

	var perm domain.Permission
	found := false
	for _, share := range shares {
		if fileID != "" && share.FileID != nil && *share.FileID == fileID {
			perm = strongerPermission(perm, share.Permission)
			found = true
			continue
		}
		if share.FolderID != nil && folderSet[*share.FolderID] {
			perm = strongerPermission(perm, share.Permission)
			found = true
		}
	}
	return perm, found, nil
}
