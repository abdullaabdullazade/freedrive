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

type folderCreateFixture struct {
	ctx       context.Context
	svc       *FolderService
	folderRepo *sqlite.FolderRepo
	ownerID   string
	parentID  string
}

func setupFolderCreateTest(t *testing.T) *folderCreateFixture {
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
	activityRepo := sqlite.NewActivityRepo(db)
	access := NewAccessService(shareRepo, fileRepo, folderRepo)
	svc := NewFolderService(folderRepo, fileRepo, userRepo, nil, activityRepo, nil, access, nil)

	ownerID := uuid.New().String()
	hash, _ := bcrypt.GenerateFromPassword([]byte("pass"), bcrypt.DefaultCost)
	if err := userRepo.Create(ctx, &domain.User{
		ID: ownerID, Email: "owner@example.com", Username: "owner",
		PasswordHash: string(hash), Role: domain.RoleUser,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("create user: %v", err)
	}

	parent := &domain.Folder{
		ID: uuid.New().String(), Name: "Parent", OwnerID: ownerID,
	}
	if err := folderRepo.Create(ctx, parent); err != nil {
		t.Fatalf("create parent: %v", err)
	}

	return &folderCreateFixture{
		ctx:        ctx,
		svc:        svc,
		folderRepo: folderRepo,
		ownerID:    ownerID,
		parentID:   parent.ID,
	}
}

func TestFolderService_CreateReusesLiveFolder(t *testing.T) {
	f := setupFolderCreateTest(t)
	parentID := f.parentID

	first := &domain.Folder{
		Name: "Docs", OwnerID: f.ownerID, ParentID: &parentID,
	}
	if err := f.svc.Create(f.ctx, first); err != nil {
		t.Fatalf("create first: %v", err)
	}
	if first.ID == "" {
		t.Fatal("expected id on first create")
	}

	second := &domain.Folder{
		Name: "Docs", OwnerID: f.ownerID, ParentID: &parentID,
	}
	if err := f.svc.Create(f.ctx, second); err != nil {
		t.Fatalf("create second: %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("expected reuse of live folder id %s, got %s", first.ID, second.ID)
	}
	if second.IsTrashed {
		t.Fatal("expected live folder")
	}
}

func TestFolderService_CreateDoesNotRestoreTrashedFolder(t *testing.T) {
	f := setupFolderCreateTest(t)
	parentID := f.parentID

	original := &domain.Folder{
		Name: "immich-backup", OwnerID: f.ownerID, ParentID: &parentID,
	}
	if err := f.svc.Create(f.ctx, original); err != nil {
		t.Fatalf("create: %v", err)
	}
	originalID := original.ID

	if err := f.folderRepo.MoveToTrash(f.ctx, originalID); err != nil {
		t.Fatalf("trash: %v", err)
	}
	trashed, err := f.folderRepo.GetByID(f.ctx, originalID)
	if err != nil || trashed == nil || !trashed.IsTrashed {
		t.Fatalf("expected trashed folder, got %#v err=%v", trashed, err)
	}

	again := &domain.Folder{
		Name: "immich-backup", OwnerID: f.ownerID, ParentID: &parentID,
	}
	if err := f.svc.Create(f.ctx, again); err != nil {
		t.Fatalf("create after trash: %v", err)
	}
	if again.ID == originalID {
		t.Fatal("expected a new live folder, not restore of trashed id")
	}
	if again.IsTrashed {
		t.Fatal("expected new folder to be live")
	}

	stillTrashed, err := f.folderRepo.GetByID(f.ctx, originalID)
	if err != nil || stillTrashed == nil || !stillTrashed.IsTrashed {
		t.Fatalf("original should remain trashed, got %#v err=%v", stillTrashed, err)
	}
	if stillTrashed.Name == "immich-backup" {
		t.Fatalf("trashed name should be renamed to free UNIQUE, got %q", stillTrashed.Name)
	}

	// Live reuse still works for the new folder.
	third := &domain.Folder{
		Name: "immich-backup", OwnerID: f.ownerID, ParentID: &parentID,
	}
	if err := f.svc.Create(f.ctx, third); err != nil {
		t.Fatalf("create after new live: %v", err)
	}
	if third.ID != again.ID {
		t.Fatalf("expected reuse of live id %s, got %s", again.ID, third.ID)
	}
}
