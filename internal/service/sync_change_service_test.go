package service_test

import (
	"context"
	"testing"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository/sqlite"
	"github.com/abdullaabdullazade/freedrive/internal/service"
)

func TestSyncChangeFeedMonotonicSeq(t *testing.T) {
	db, err := sqlite.New(t.TempDir())
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	changeRepo := sqlite.NewSyncChangeRepo(db)
	computerRepo := sqlite.NewComputerRepo(db)
	folderRepo := sqlite.NewFolderRepo(db)
	fileRepo := sqlite.NewFileRepo(db)
	recorder := service.NewSyncChangeService(changeRepo, computerRepo)
	feed := service.NewSyncFeedService(changeRepo, computerRepo, folderRepo, fileRepo)

	ctx := context.Background()
	ownerID := "user-sync-test"
	userRepo := sqlite.NewUserRepo(db)
	if err := userRepo.Create(ctx, &domain.User{
		ID:           ownerID,
		Email:        "sync@test.local",
		Username:     "sync",
		PasswordHash: "hash",
		Role:         "user",
	}); err != nil {
		t.Fatalf("create user: %v", err)
	}

	root := &domain.Folder{OwnerID: ownerID, Name: "PC"}
	if err := folderRepo.Create(ctx, root); err != nil {
		t.Fatalf("create root: %v", err)
	}
	computer := &domain.Computer{OwnerID: ownerID, Name: "PC", RootFolderID: root.ID}
	if err := computerRepo.Create(ctx, computer); err != nil {
		t.Fatalf("create computer: %v", err)
	}

	child := &domain.Folder{OwnerID: ownerID, Name: "Docs", ParentID: &root.ID}
	if err := folderRepo.Create(ctx, child); err != nil {
		t.Fatalf("create child: %v", err)
	}
	_ = recorder.RecordFolderCreate(ctx, child)

	file := &domain.File{
		OwnerID:       ownerID,
		Name:          "note.txt",
		FolderID:      &child.ID,
		Version:       1,
		MimeType:      "text/plain",
		Size:          4,
		EncryptedSize: 4,
		BlobPath:      "blobs/test",
		IV:            "iv",
	}
	if err := fileRepo.Create(ctx, file); err != nil {
		t.Fatalf("create file: %v", err)
	}
	_ = recorder.RecordFileCreate(ctx, file)

	snapshot, err := feed.Snapshot(ctx, ownerID, computer.ID)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if snapshot.Cursor <= 0 {
		t.Fatalf("expected positive cursor, got %d", snapshot.Cursor)
	}

	page, err := feed.ListChanges(ctx, ownerID, computer.ID, 0, 50)
	if err != nil {
		t.Fatalf("list changes: %v", err)
	}
	if len(page.Changes) == 0 {
		t.Fatal("expected changes")
	}
	prev := int64(0)
	for _, c := range page.Changes {
		if c.Operation == "snapshot" {
			continue
		}
		if c.Seq <= prev {
			t.Fatalf("seq not monotonic: %d after %d", c.Seq, prev)
		}
		prev = c.Seq
	}
}
