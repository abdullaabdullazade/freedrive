package service

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository/sqlite"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

func TestPasswordResetTokenSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()

	db, err := sqlite.New(dir)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	userRepo := sqlite.NewUserRepo(db)
	resetRepo := sqlite.NewPasswordResetRepo(db)
	svc := NewPasswordResetService(userRepo, resetRepo)

	hash, err := bcrypt.GenerateFromPassword([]byte("old-password"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	user := &domain.User{
		ID:           uuid.New().String(),
		Email:        "reset-test@example.com",
		Username:     "reset-test",
		PasswordHash: string(hash),
		Role:         domain.RoleUser,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}
	if err := userRepo.Create(ctx, user); err != nil {
		t.Fatalf("create user: %v", err)
	}

	raw, err := svc.CreateResetLink(ctx, user.Email)
	if err != nil {
		t.Fatalf("create reset link: %v", err)
	}
	if raw == "" {
		t.Fatal("expected non-empty raw token")
	}

	dbPath := filepath.Join(dir, "freedrive.db")
	if err := db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}
	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf("db file missing after close: %v", err)
	}

	db2, err := sqlite.New(dir)
	if err != nil {
		t.Fatalf("reopen db: %v", err)
	}
	defer db2.Close()

	svc2 := NewPasswordResetService(sqlite.NewUserRepo(db2), sqlite.NewPasswordResetRepo(db2))
	if !svc2.ConsumeResetToken(ctx, raw, user.Email) {
		t.Fatal("token should be valid after simulated server restart")
	}
	if svc2.ConsumeResetToken(ctx, raw, user.Email) {
		t.Fatal("token should be single-use")
	}
}
