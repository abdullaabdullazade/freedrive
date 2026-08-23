package storage

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

// DiskStorage manages file blobs on the local filesystem.
type DiskStorage struct {
	baseDir string
}

// NewDiskStorage creates a new disk storage manager.
func NewDiskStorage(dataDir string) (*DiskStorage, error) {
	blobDir := filepath.Join(dataDir, "blobs")
	if err := os.MkdirAll(blobDir, 0755); err != nil {
		return nil, fmt.Errorf("create blob dir: %w", err)
	}
	return &DiskStorage{baseDir: blobDir}, nil
}

// Save writes data from reader to a new blob file and returns its relative path.
func (ds *DiskStorage) Save(userID string, r io.Reader) (string, int64, error) {
	userDir := filepath.Join(ds.baseDir, userID)
	if err := os.MkdirAll(userDir, 0755); err != nil {
		return "", 0, fmt.Errorf("create user dir: %w", err)
	}

	blobName := uuid.New().String() + ".enc"
	blobPath := filepath.Join(userID, blobName)
	fullPath := filepath.Join(ds.baseDir, blobPath)

	f, err := os.Create(fullPath)
	if err != nil {
		return "", 0, fmt.Errorf("create blob file: %w", err)
	}
	defer f.Close()

	written, err := io.Copy(f, r)
	if err != nil {
		os.Remove(fullPath)
		return "", 0, fmt.Errorf("write blob: %w", err)
	}

	return blobPath, written, nil
}

// Get opens a blob file for reading.
func (ds *DiskStorage) Get(blobPath string) (io.ReadCloser, error) {
	fullPath := filepath.Join(ds.baseDir, blobPath)
	f, err := os.Open(fullPath)
	if err != nil {
		return nil, fmt.Errorf("open blob: %w", err)
	}
	return f, nil
}

// Delete removes a blob file from disk.
func (ds *DiskStorage) Delete(blobPath string) error {
	fullPath := filepath.Join(ds.baseDir, blobPath)
	if err := os.Remove(fullPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("delete blob: %w", err)
	}
	return nil
}

// Size returns the size of a blob file.
func (ds *DiskStorage) Size(blobPath string) (int64, error) {
	fullPath := filepath.Join(ds.baseDir, blobPath)
	info, err := os.Stat(fullPath)
	if err != nil {
		return 0, fmt.Errorf("stat blob: %w", err)
	}
	return info.Size(), nil
}

// DiskUsage returns total bytes used by a user's blobs.
func (ds *DiskStorage) DiskUsage(userID string) (int64, error) {
	userDir := filepath.Join(ds.baseDir, userID)
	var total int64

	err := filepath.Walk(userDir, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if !info.IsDir() {
			total += info.Size()
		}
		return nil
	})

	return total, err
}

// TotalDiskUsage returns total bytes used by all blobs.
func (ds *DiskStorage) TotalDiskUsage() (int64, error) {
	var total int64
	err := filepath.Walk(ds.baseDir, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total, err
}

// Import moves an existing absolute file into blob storage (no extra copy when rename works).
func (ds *DiskStorage) Import(userID, absSrcPath string) (string, int64, error) {
	info, err := os.Stat(absSrcPath)
	if err != nil {
		return "", 0, fmt.Errorf("stat import source: %w", err)
	}
	userDir := filepath.Join(ds.baseDir, userID)
	if err := os.MkdirAll(userDir, 0755); err != nil {
		return "", 0, fmt.Errorf("create user dir: %w", err)
	}
	blobName := uuid.New().String() + ".enc"
	blobPath := filepath.Join(userID, blobName)
	fullPath := filepath.Join(ds.baseDir, blobPath)
	if err := os.Rename(absSrcPath, fullPath); err != nil {
		// Cross-device rename fallback: copy then remove.
		in, err := os.Open(absSrcPath)
		if err != nil {
			return "", 0, fmt.Errorf("open import source: %w", err)
		}
		out, err := os.Create(fullPath)
		if err != nil {
			in.Close()
			return "", 0, fmt.Errorf("create blob file: %w", err)
		}
		written, copyErr := io.Copy(out, in)
		in.Close()
		closeErr := out.Close()
		if copyErr != nil {
			os.Remove(fullPath)
			return "", 0, fmt.Errorf("copy import: %w", copyErr)
		}
		if closeErr != nil {
			os.Remove(fullPath)
			return "", 0, closeErr
		}
		_ = os.Remove(absSrcPath)
		return blobPath, written, nil
	}
	return blobPath, info.Size(), nil
}

// UploadsDir returns the absolute staging directory for resumable uploads.
func UploadsDir(dataDir string) string {
	return filepath.Join(dataDir, "uploads")
}
