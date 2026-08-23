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

type computerFixture struct {
	ctx        context.Context
	svc        *ComputerService
	ownerID    string
	strangerID string
}

func setupComputerTest(t *testing.T) *computerFixture {
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
	computerRepo := sqlite.NewComputerRepo(db)
	folderRepo := sqlite.NewFolderRepo(db)
	svc := NewComputerService(computerRepo, folderRepo)

	f := &computerFixture{
		ctx:        ctx,
		svc:        svc,
		ownerID:    uuid.New().String(),
		strangerID: uuid.New().String(),
	}

	for _, u := range []struct {
		id, email string
	}{
		{f.ownerID, "owner@example.com"},
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

	return f
}

func TestComputerService_HeartbeatUpdatesLastSeen(t *testing.T) {
	f := setupComputerTest(t)

	computer, err := f.svc.Register(f.ctx, f.ownerID, "Work PC", "DESKTOP-1")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if computer.LastSeenAt != nil {
		t.Fatal("expected nil last_seen_at on new computer")
	}

	before := time.Now()
	updated, err := f.svc.Heartbeat(f.ctx, f.ownerID, computer.ID)
	if err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if updated.LastSeenAt == nil {
		t.Fatal("expected last_seen_at after heartbeat")
	}
	if updated.LastSeenAt.Before(before) {
		t.Fatalf("last_seen_at %v before heartbeat time %v", updated.LastSeenAt, before)
	}

	got, err := f.svc.Get(f.ctx, f.ownerID, computer.ID)
	if err != nil {
		t.Fatalf("get after heartbeat: %v", err)
	}
	if got.LastSeenAt == nil {
		t.Fatal("expected persisted last_seen_at")
	}
}

func TestComputerService_HeartbeatRejectsStranger(t *testing.T) {
	f := setupComputerTest(t)

	computer, err := f.svc.Register(f.ctx, f.ownerID, "Work PC", "DESKTOP-1")
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	_, err = f.svc.Heartbeat(f.ctx, f.strangerID, computer.ID)
	if err == nil {
		t.Fatal("expected error for stranger heartbeat")
	}
}

func TestComputerService_HeartbeatNotFound(t *testing.T) {
	f := setupComputerTest(t)

	_, err := f.svc.Heartbeat(f.ctx, f.ownerID, uuid.New().String())
	if err == nil {
		t.Fatal("expected error for missing computer")
	}
}

func TestComputerService_DeleteRemovesFromList(t *testing.T) {
	f := setupComputerTest(t)

	computer, err := f.svc.Register(f.ctx, f.ownerID, "Work PC", "DESKTOP-1")
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	if err := f.svc.Delete(f.ctx, f.ownerID, computer.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	list, err := f.svc.List(f.ctx, f.ownerID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("expected 0 computers after delete, got %d", len(list))
	}

	_, err = f.svc.Get(f.ctx, f.ownerID, computer.ID)
	if err == nil {
		t.Fatal("expected get to fail after delete")
	}
}

func TestComputerService_RegisterIsIdempotentByHostname(t *testing.T) {
	f := setupComputerTest(t)

	first, err := f.svc.Register(f.ctx, f.ownerID, "Work PC", "DESKTOP-1")
	if err != nil {
		t.Fatalf("first register: %v", err)
	}

	second, err := f.svc.Register(f.ctx, f.ownerID, "Work PC", "DESKTOP-1")
	if err != nil {
		t.Fatalf("second register: %v", err)
	}

	if first.ID != second.ID {
		t.Fatalf("expected same computer id, got %s and %s", first.ID, second.ID)
	}
	if first.RootFolderID != second.RootFolderID {
		t.Fatalf("expected same root folder, got %s and %s", first.RootFolderID, second.RootFolderID)
	}

	list, err := f.svc.List(f.ctx, f.ownerID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 computer, got %d", len(list))
	}
}
