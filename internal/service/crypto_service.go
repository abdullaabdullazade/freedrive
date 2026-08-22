package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
)

var (
	ErrCryptoAlreadySetup = errors.New("encryption account already configured")
	ErrCryptoNotSetup     = errors.New("encryption account not configured")
	ErrFileKeyNotFound    = errors.New("encryption key not found for file")
)

// CryptoService manages E2E encryption key sync.
type CryptoService struct {
	cryptoRepo repository.CryptoRepository
	fileRepo   repository.FileRepository
	access     *AccessService
}

func NewCryptoService(cryptoRepo repository.CryptoRepository, fileRepo repository.FileRepository, access *AccessService) *CryptoService {
	return &CryptoService{cryptoRepo: cryptoRepo, fileRepo: fileRepo, access: access}
}

// GetAccount returns the user's crypto account metadata.
func (s *CryptoService) GetAccount(ctx context.Context, userID string) (map[string]interface{}, error) {
	c, err := s.cryptoRepo.GetUserCrypto(ctx, userID)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return map[string]interface{}{
			"has_crypto":   false,
			"has_recovery": false,
		}, nil
	}
	return map[string]interface{}{
		"has_crypto":           true,
		"has_recovery":         c.WrappedUEKRecovery != "",
		"key_salt":             c.KeySalt,
		"wrapped_uek":          c.WrappedUEK,
		"wrapped_uek_recovery": c.WrappedUEKRecovery,
		"version":              c.Version,
		"updated_at":           c.UpdatedAt,
	}, nil
}

// SetupAccount creates the initial user crypto record.
func (s *CryptoService) SetupAccount(ctx context.Context, userID string, keySalt []byte, wrappedUEK, wrappedUEKRecovery string) error {
	existing, err := s.cryptoRepo.GetUserCrypto(ctx, userID)
	if err != nil {
		return err
	}
	if existing != nil {
		return ErrCryptoAlreadySetup
	}
	if len(keySalt) == 0 || wrappedUEK == "" {
		return fmt.Errorf("key_salt and wrapped_uek are required")
	}
	return s.cryptoRepo.CreateUserCrypto(ctx, &domain.UserCrypto{
		UserID:             userID,
		KeySalt:            keySalt,
		WrappedUEK:         wrappedUEK,
		WrappedUEKRecovery: wrappedUEKRecovery,
		Version:            1,
	})
}

// UpdateAccount updates wrapped UEK (e.g. after password change).
func (s *CryptoService) UpdateAccount(ctx context.Context, userID string, keySalt []byte, wrappedUEK, wrappedUEKRecovery string) error {
	existing, err := s.cryptoRepo.GetUserCrypto(ctx, userID)
	if err != nil {
		return err
	}
	if existing == nil {
		return ErrCryptoNotSetup
	}
	if len(keySalt) > 0 {
		existing.KeySalt = keySalt
	}
	if wrappedUEK != "" {
		existing.WrappedUEK = wrappedUEK
	}
	if wrappedUEKRecovery != "" {
		existing.WrappedUEKRecovery = wrappedUEKRecovery
	}
	return s.cryptoRepo.UpdateUserCrypto(ctx, existing)
}

// PutFileKey stores a wrapped file encryption key.
func (s *CryptoService) PutFileKey(ctx context.Context, userID, fileID, wrappedFileKey string) error {
	if wrappedFileKey == "" {
		return fmt.Errorf("wrapped_file_key is required")
	}
	file, err := s.fileRepo.GetByID(ctx, fileID)
	if err != nil {
		return err
	}
	if file == nil {
		return fmt.Errorf("file not found")
	}
	if file.OwnerID != userID {
		if err := s.access.CanWriteFile(ctx, fileID, userID); err != nil {
			return fmt.Errorf("access denied")
		}
	}
	return s.cryptoRepo.UpsertFileEncryptionKey(ctx, &domain.FileEncryptionKey{
		FileID:         fileID,
		OwnerID:        file.OwnerID,
		WrappedFileKey: wrappedFileKey,
	})
}

// GetFileKey returns a wrapped file encryption key if the user can read the file.
func (s *CryptoService) GetFileKey(ctx context.Context, userID, fileID string) (*domain.FileEncryptionKey, error) {
	if err := s.access.CanReadFile(ctx, fileID, userID); err != nil {
		return nil, fmt.Errorf("access denied")
	}
	key, err := s.cryptoRepo.GetFileEncryptionKey(ctx, fileID)
	if err != nil {
		return nil, err
	}
	if key == nil {
		return nil, ErrFileKeyNotFound
	}
	return key, nil
}

// BulkPutFileKeys upserts multiple wrapped file keys (migration).
func (s *CryptoService) BulkPutFileKeys(ctx context.Context, userID string, keys map[string]string) (int, error) {
	count := 0
	for fileID, wrappedKey := range keys {
		if wrappedKey == "" {
			continue
		}
		if err := s.PutFileKey(ctx, userID, fileID, wrappedKey); err != nil {
			// Skip files user doesn't own or that don't exist.
			continue
		}
		count++
	}
	return count, nil
}

// ListKeysSince returns encryption keys updated after the given timestamp.
func (s *CryptoService) ListKeysSince(ctx context.Context, userID string, since time.Time) ([]domain.EncryptionKeyEntry, error) {
	return s.cryptoRepo.ListFileEncryptionKeysSince(ctx, userID, since, 5000)
}
