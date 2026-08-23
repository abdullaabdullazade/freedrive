package sqlite

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
)

func TestGetByFolderIDPage(t *testing.T) {
	db, ctx := setupFolderTrashTestDB(t)
	userRepo := NewUserRepo(db)
	folderRepo := NewFolderRepo(db)
	fileRepo := NewFileRepo(db)

	owner := createTestUser(t, userRepo, ctx, "pager@example.com", "pager")
	folder := createTestFolder(t, folderRepo, ctx, owner.ID, "Busy", nil)

	for i := 0; i < 5; i++ {
		createTestFileInFolder(t, fileRepo, ctx, owner.ID, folder.ID, fmt.Sprintf("f%02d.txt", i))
	}

	page1, total, err := fileRepo.GetByFolderIDPage(ctx, &folder.ID, owner.ID, 2, 0)
	if err != nil {
		t.Fatalf("page1: %v", err)
	}
	if total != 5 {
		t.Fatalf("total=%d want 5", total)
	}
	if len(page1) != 2 {
		t.Fatalf("page1 len=%d want 2", len(page1))
	}

	page2, _, err := fileRepo.GetByFolderIDPage(ctx, &folder.ID, owner.ID, 2, 2)
	if err != nil {
		t.Fatalf("page2: %v", err)
	}
	if len(page2) != 2 {
		t.Fatalf("page2 len=%d want 2", len(page2))
	}

	page3, _, err := fileRepo.GetByFolderIDPage(ctx, &folder.ID, owner.ID, 2, 4)
	if err != nil {
		t.Fatalf("page3: %v", err)
	}
	if len(page3) != 1 {
		t.Fatalf("page3 len=%d want 1", len(page3))
	}

	seen := map[string]bool{}
	for _, f := range append(append(page1, page2...), page3...) {
		if seen[f.ID] {
			t.Fatalf("duplicate id %s across pages", f.ID)
		}
		seen[f.ID] = true
	}
	if len(seen) != 5 {
		t.Fatalf("unique files=%d want 5", len(seen))
	}
}

func createTestFileInFolder(t *testing.T, repo *FileRepo, ctx context.Context, ownerID, folderID, name string) *domain.File {
	t.Helper()
	now := time.Now()
	fid := folderID
	f := &domain.File{
		ID:            uuid.New().String(),
		Name:          name,
		MimeType:      "text/plain",
		Size:          1,
		EncryptedSize: 1,
		FolderID:      &fid,
		OwnerID:       ownerID,
		BlobPath:      uuid.New().String(),
		IV:            "iv",
		Version:       1,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := repo.Create(ctx, f); err != nil {
		t.Fatalf("create file: %v", err)
	}
	return f
}
