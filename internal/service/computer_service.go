package service

import (
	"context"
	"fmt"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
)

// ComputerService handles registered desktop device logic.
type ComputerService struct {
	computerRepo repository.ComputerRepository
	folderRepo   repository.FolderRepository
}

// NewComputerService creates a new computer service.
func NewComputerService(computerRepo repository.ComputerRepository, folderRepo repository.FolderRepository) *ComputerService {
	return &ComputerService{
		computerRepo: computerRepo,
		folderRepo:   folderRepo,
	}
}

// List returns all computers registered for the user.
func (s *ComputerService) List(ctx context.Context, ownerID string) ([]domain.Computer, error) {
	return s.computerRepo.ListByOwner(ctx, ownerID)
}

// Get returns a single computer if it belongs to the user.
func (s *ComputerService) Get(ctx context.Context, ownerID, computerID string) (*domain.Computer, error) {
	computer, err := s.computerRepo.GetByID(ctx, computerID)
	if err != nil {
		return nil, err
	}
	if computer == nil || computer.OwnerID != ownerID {
		return nil, fmt.Errorf("computer not found")
	}
	return computer, nil
}

// Delete removes the computer registration row so it disappears from Lists
// immediately. Caller is responsible for PermanentDelete of the root folder.
func (s *ComputerService) Delete(ctx context.Context, ownerID, computerID string) error {
	computer, err := s.Get(ctx, ownerID, computerID)
	if err != nil {
		return err
	}
	return s.computerRepo.Delete(ctx, computer.ID)
}

// Register creates a computer root folder and device record, or returns an existing
// registration for the same owner and hostname.
func (s *ComputerService) Register(ctx context.Context, ownerID, name, hostname string) (*domain.Computer, error) {
	if name == "" {
		return nil, fmt.Errorf("computer name is required")
	}

	if hostname != "" {
		existing, err := s.computerRepo.GetByOwnerAndHostname(ctx, ownerID, hostname)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			return existing, nil
		}
	}

	folder := &domain.Folder{
		Name:    name,
		OwnerID: ownerID,
	}
	if err := s.folderRepo.Create(ctx, folder); err != nil {
		return nil, err
	}

	computer := &domain.Computer{
		OwnerID:      ownerID,
		Name:         name,
		Hostname:     hostname,
		RootFolderID: folder.ID,
	}
	if err := s.computerRepo.Create(ctx, computer); err != nil {
		return nil, err
	}
	return computer, nil
}

// Heartbeat updates last_seen_at for a registered computer.
func (s *ComputerService) Heartbeat(ctx context.Context, ownerID, computerID string) (*domain.Computer, error) {
	computer, err := s.Get(ctx, ownerID, computerID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	if err := s.computerRepo.UpdateLastSeen(ctx, computerID, now); err != nil {
		return nil, err
	}
	computer.LastSeenAt = &now
	return computer, nil
}

// IsInComputerTree reports whether a folder belongs to a registered computer.
func (s *ComputerService) IsInComputerTree(ctx context.Context, folderID string) (bool, error) {
	return s.computerRepo.IsInComputerTree(ctx, folderID)
}
