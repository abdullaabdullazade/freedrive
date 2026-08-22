package service

import (
	"context"
	"testing"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository/sqlite"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

type accessFixture struct {
	ctx            context.Context
	access         *AccessService
	ownerID        string
	viewerID       string
	editorID       string
	strangerID     string
	parentFolderID string
	nestedFileID   string
	directFileID   string
}

func setupAccessTest(t *testing.T) *accessFixture {
	t.Helper()
	ctx := context.Background()
	db, err := sqlite.New(t.TempDir())
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	userRepo := sqlite.NewUserRepo(db)
	fileRepo := sqlite.NewFileRepo(db)
	folderRepo := sqlite.NewFolderRepo(db)
	shareRepo := sqlite.NewShareRepo(db)
	access := NewAccessService(shareRepo, fileRepo, folderRepo)

	f := &accessFixture{
		ctx:        ctx,
		access:     access,
		ownerID:    uuid.New().String(),
		viewerID:   uuid.New().String(),
		editorID:   uuid.New().String(),
		strangerID: uuid.New().String(),
	}

	for _, u := range []struct {
		id, email string
	}{
		{f.ownerID, "owner@example.com"},
		{f.viewerID, "viewer@example.com"},
		{f.editorID, "editor@example.com"},
		{f.strangerID, "stranger@example.com"},
	} {
		hash, _ := bcrypt.GenerateFromPassword([]byte("pass"), bcrypt.DefaultCost)
		if err := userRepo.Create(ctx, &domain.User{
			ID: u.id, Email: u.email, Username: u.email, PasswordHash: string(hash),
			Role: domain.RoleUser, CreatedAt: time.Now(), UpdatedAt: time.Now(),
		}); err != nil {
			t.Fatalf("create user: %v", err)
		}
	}

	f.parentFolderID = uuid.New().String()
	childFolderID := uuid.New().String()
	f.nestedFileID = uuid.New().String()
	f.directFileID = uuid.New().String()

	if err := folderRepo.Create(ctx, &domain.Folder{
		ID: f.parentFolderID, Name: "Shared", OwnerID: f.ownerID,
	}); err != nil {
		t.Fatalf("create parent folder: %v", err)
	}
	if err := folderRepo.Create(ctx, &domain.Folder{
		ID: childFolderID, Name: "Child", OwnerID: f.ownerID, ParentID: &f.parentFolderID,
	}); err != nil {
		t.Fatalf("create child folder: %v", err)
	}
	if err := fileRepo.Create(ctx, &domain.File{
		ID: f.nestedFileID, Name: "doc.txt", MimeType: "text/plain", OwnerID: f.ownerID,
		FolderID: &childFolderID, BlobPath: "/tmp/x", IV: "iv", Version: 1,
	}); err != nil {
		t.Fatalf("create nested file: %v", err)
	}
	if err := fileRepo.Create(ctx, &domain.File{
		ID: f.directFileID, Name: "direct.txt", MimeType: "text/plain", OwnerID: f.ownerID,
		BlobPath: "/tmp/y", IV: "iv", Version: 1,
	}); err != nil {
		t.Fatalf("create direct file: %v", err)
	}

	if err := shareRepo.CreateUserShare(ctx, &domain.UserShare{
		FileID: &f.directFileID, SharedBy: f.ownerID, SharedWith: f.viewerID, Permission: domain.PermRead,
	}); err != nil {
		t.Fatalf("create file share: %v", err)
	}
	if err := shareRepo.CreateUserShare(ctx, &domain.UserShare{
		FolderID: &f.parentFolderID, SharedBy: f.ownerID, SharedWith: f.editorID, Permission: domain.PermWrite,
	}); err != nil {
		t.Fatalf("create folder share: %v", err)
	}

	return f
}

func TestAccessServiceOwnerAndFolderInheritance(t *testing.T) {
	f := setupAccessTest(t)

	if err := f.access.CanReadFile(f.ctx, f.nestedFileID, f.ownerID); err != nil {
		t.Fatalf("owner read nested: %v", err)
	}
	if err := f.access.CanWriteFile(f.ctx, f.nestedFileID, f.ownerID); err != nil {
		t.Fatalf("owner write nested: %v", err)
	}
	if err := f.access.CanReadFile(f.ctx, f.nestedFileID, f.editorID); err != nil {
		t.Fatalf("editor read nested via folder share: %v", err)
	}
	if err := f.access.CanWriteFile(f.ctx, f.nestedFileID, f.editorID); err != nil {
		t.Fatalf("editor write nested via folder share: %v", err)
	}
	if err := f.access.CanReadFile(f.ctx, f.nestedFileID, f.viewerID); err == nil {
		t.Fatal("viewer should not read nested file without share")
	}
	if err := f.access.CanReadFile(f.ctx, f.nestedFileID, f.strangerID); err == nil {
		t.Fatal("stranger should not read file")
	}
}

func TestAccessServiceDirectFileReadShare(t *testing.T) {
	f := setupAccessTest(t)

	if err := f.access.CanReadFile(f.ctx, f.directFileID, f.viewerID); err != nil {
		t.Fatalf("viewer read direct file: %v", err)
	}
	if err := f.access.CanWriteFile(f.ctx, f.directFileID, f.viewerID); err == nil {
		t.Fatal("viewer should not write with read permission")
	}
	if err := f.access.CanWriteFile(f.ctx, f.directFileID, f.ownerID); err != nil {
		t.Fatalf("owner write: %v", err)
	}
	if err := f.access.CanReadFile(f.ctx, f.directFileID, f.strangerID); err == nil {
		t.Fatal("stranger denied")
	}
}

func TestAccessServiceCanWriteFolder(t *testing.T) {
	f := setupAccessTest(t)

	if err := f.access.CanWriteFolder(f.ctx, f.parentFolderID, f.editorID); err != nil {
		t.Fatalf("editor write folder: %v", err)
	}
	if err := f.access.CanWriteFolder(f.ctx, f.parentFolderID, f.viewerID); err == nil {
		t.Fatal("viewer should not write folder")
	}
	if err := f.access.CanWriteFolder(f.ctx, f.parentFolderID, f.ownerID); err != nil {
		t.Fatalf("owner write folder: %v", err)
	}
	if err := f.access.CanWriteFolder(f.ctx, f.parentFolderID, f.strangerID); err == nil {
		t.Fatal("stranger denied")
	}
}
