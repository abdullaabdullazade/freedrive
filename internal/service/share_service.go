package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrShareTargetMissing = errors.New("file_id or folder_id is required")
	ErrShareNotFound      = errors.New("share not found")
	ErrShareLinkInvalid   = errors.New("invalid or expired share link")
)

// ShareService handles sharing business logic.
type ShareService struct {
	shareRepo  repository.ShareRepository
	fileRepo   repository.FileRepository
	folderRepo repository.FolderRepository
	userRepo   repository.UserRepository
	access     *AccessService
}

// NewShareService creates a share service.
func NewShareService(
	shareRepo repository.ShareRepository,
	fileRepo repository.FileRepository,
	folderRepo repository.FolderRepository,
	userRepo repository.UserRepository,
	access *AccessService,
) *ShareService {
	return &ShareService{
		shareRepo:  shareRepo,
		fileRepo:   fileRepo,
		folderRepo: folderRepo,
		userRepo:   userRepo,
		access:     access,
	}
}

// SharedItem is an enriched share listing entry.
type SharedItem struct {
	Share      domain.UserShare `json:"share"`
	ItemType   string           `json:"item_type"`
	ItemID     string           `json:"item_id"`
	ItemName   string           `json:"item_name"`
	OwnerID    string           `json:"owner_id"`
	OwnerName  string           `json:"owner_name,omitempty"`
	OwnerEmail string           `json:"owner_email,omitempty"`
}

// CreateUserShare shares a file or folder with another user.
func (s *ShareService) CreateUserShare(ctx context.Context, actorID string, share *domain.UserShare) (*domain.UserShare, error) {
	if share.FileID == nil && share.FolderID == nil {
		return nil, ErrShareTargetMissing
	}
	if share.SharedWith == "" {
		return nil, fmt.Errorf("shared_with is required")
	}
	share.Permission = ParsePermission(string(share.Permission))
	share.SharedBy = actorID

	if share.FileID != nil {
		file, err := s.fileRepo.GetByID(ctx, *share.FileID)
		if err != nil || file == nil || file.OwnerID != actorID {
			return nil, fmt.Errorf("access denied")
		}
	}
	if share.FolderID != nil {
		folder, err := s.folderRepo.GetByID(ctx, *share.FolderID)
		if err != nil || folder == nil || folder.OwnerID != actorID {
			return nil, fmt.Errorf("access denied")
		}
	}

	target, err := s.userRepo.GetByID(ctx, share.SharedWith)
	if err != nil || target == nil {
		return nil, fmt.Errorf("recipient not found")
	}

	if err := s.shareRepo.CreateUserShare(ctx, share); err != nil {
		return nil, err
	}
	return share, nil
}

// DeleteUserShare removes a user share if the actor owns the item or created the share.
func (s *ShareService) DeleteUserShare(ctx context.Context, actorID, shareID string) error {
	share, err := s.shareRepo.GetUserShareByID(ctx, shareID)
	if err != nil || share == nil {
		return ErrShareNotFound
	}
	if share.SharedBy != actorID {
		if share.FileID != nil {
			file, _ := s.fileRepo.GetByID(ctx, *share.FileID)
			if file == nil || file.OwnerID != actorID {
				return fmt.Errorf("access denied")
			}
		}
		if share.FolderID != nil {
			folder, _ := s.folderRepo.GetByID(ctx, *share.FolderID)
			if folder == nil || folder.OwnerID != actorID {
				return fmt.Errorf("access denied")
			}
		}
	}
	return s.shareRepo.DeleteUserShare(ctx, shareID)
}

// UpdateUserShare updates permission on an existing user share.
func (s *ShareService) UpdateUserShare(ctx context.Context, actorID, shareID string, permission domain.Permission) (*domain.UserShare, error) {
	share, err := s.shareRepo.GetUserShareByID(ctx, shareID)
	if err != nil || share == nil {
		return nil, ErrShareNotFound
	}
	if share.SharedBy != actorID {
		if share.FileID != nil {
			file, _ := s.fileRepo.GetByID(ctx, *share.FileID)
			if file == nil || file.OwnerID != actorID {
				return nil, fmt.Errorf("access denied")
			}
		}
		if share.FolderID != nil {
			folder, _ := s.folderRepo.GetByID(ctx, *share.FolderID)
			if folder == nil || folder.OwnerID != actorID {
				return nil, fmt.Errorf("access denied")
			}
		}
	}
	share.Permission = ParsePermission(string(permission))
	if err := s.shareRepo.UpdateUserShare(ctx, share); err != nil {
		return nil, err
	}
	return share, nil
}

// ListSharedWithMe returns shares where the user is the recipient.
func (s *ShareService) ListSharedWithMe(ctx context.Context, userID string) ([]SharedItem, error) {
	shares, err := s.shareRepo.ListSharedWithUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	return s.enrichShares(ctx, shares)
}

// ListSharedByMe returns shares created by the user.
func (s *ShareService) ListSharedByMe(ctx context.Context, userID string) ([]SharedItem, error) {
	shares, err := s.shareRepo.ListSharedByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	return s.enrichShares(ctx, shares)
}

func (s *ShareService) enrichShares(ctx context.Context, shares []domain.UserShare) ([]SharedItem, error) {
	out := make([]SharedItem, 0, len(shares))
	for _, share := range shares {
		item := SharedItem{Share: share}
		if share.FileID != nil {
			file, err := s.fileRepo.GetByID(ctx, *share.FileID)
			if err != nil || file == nil {
				continue
			}
			item.ItemType = "file"
			item.ItemID = file.ID
			item.ItemName = file.Name
			item.OwnerID = file.OwnerID
		}
		if share.FolderID != nil {
			folder, err := s.folderRepo.GetByID(ctx, *share.FolderID)
			if err != nil || folder == nil {
				continue
			}
			item.ItemType = "folder"
			item.ItemID = folder.ID
			item.ItemName = folder.Name
			item.OwnerID = folder.OwnerID
		}
		if owner, _ := s.userRepo.GetByID(ctx, item.OwnerID); owner != nil {
			item.OwnerName = owner.Username
			item.OwnerEmail = owner.Email
		}
		out = append(out, item)
	}
	return out, nil
}

// CreateLink creates a public share link for a file or folder.
func (s *ShareService) CreateLink(ctx context.Context, actorID string, link *domain.ShareLink, password string) (*domain.ShareLink, error) {
	if link.FileID == nil && link.FolderID == nil {
		return nil, ErrShareTargetMissing
	}
	link.Permission = ParsePermission(string(link.Permission))
	link.CreatedBy = actorID
	link.IsActive = true
	link.Token = randomShareToken(32)

	if password != "" {
		hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			return nil, err
		}
		link.PasswordHash = string(hash)
	}

	if link.FileID != nil {
		file, err := s.fileRepo.GetByID(ctx, *link.FileID)
		if err != nil || file == nil || file.OwnerID != actorID {
			return nil, fmt.Errorf("access denied")
		}
	}
	if link.FolderID != nil {
		folder, err := s.folderRepo.GetByID(ctx, *link.FolderID)
		if err != nil || folder == nil || folder.OwnerID != actorID {
			return nil, fmt.Errorf("access denied")
		}
	}

	if err := s.shareRepo.CreateLink(ctx, link); err != nil {
		return nil, err
	}
	link.HasPassword = link.PasswordHash != ""
	link.PasswordHash = ""
	return link, nil
}

// DeleteLink removes a share link owned by the actor.
func (s *ShareService) DeleteLink(ctx context.Context, actorID, linkID string) error {
	link, err := s.shareRepo.GetLinkByID(ctx, linkID)
	if err != nil || link == nil {
		return ErrShareNotFound
	}
	if link.CreatedBy != actorID {
		return fmt.Errorf("access denied")
	}
	return s.shareRepo.DeleteLink(ctx, linkID)
}

// ListLinks returns share links created by the user.
func (s *ShareService) ListLinks(ctx context.Context, userID string) ([]domain.ShareLink, error) {
	links, err := s.shareRepo.ListLinksByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	for i := range links {
		links[i].HasPassword = links[i].PasswordHash != ""
		links[i].PasswordHash = ""
	}
	return links, nil
}

// ResolveLink validates a public share link and optional password.
func (s *ShareService) ResolveLink(ctx context.Context, token, password string) (*domain.ShareLink, error) {
	link, err := s.shareRepo.GetLinkByToken(ctx, token)
	if err != nil || link == nil || !link.IsActive {
		return nil, ErrShareLinkInvalid
	}
	if link.ExpiresAt != nil && time.Now().After(*link.ExpiresAt) {
		return nil, ErrShareLinkInvalid
	}
	if link.MaxDownloads != nil && link.DownloadCount >= *link.MaxDownloads {
		return nil, ErrShareLinkInvalid
	}
	if link.PasswordHash != "" {
		if password == "" || bcrypt.CompareHashAndPassword([]byte(link.PasswordHash), []byte(password)) != nil {
			return nil, ErrShareLinkInvalid
		}
	}
	link.HasPassword = link.PasswordHash != ""
	link.PasswordHash = ""
	return link, nil
}

// RecordLinkDownload increments the download counter for a share link.
func (s *ShareService) RecordLinkDownload(ctx context.Context, linkID string) error {
	return s.shareRepo.IncrementDownloadCount(ctx, linkID)
}

func randomShareToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
