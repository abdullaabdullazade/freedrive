package service

import (
	"context"
	"testing"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository/sqlite"
)

func setupCryptoTest(t *testing.T) (*CryptoService, *sqlite.CryptoRepo, *sqlite.FileRepo, *sqlite.UserRepo, context.Context, string) {
	t.Helper()
	db, err := sqlite.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	userRepo := sqlite.NewUserRepo(db)
	fileRepo := sqlite.NewFileRepo(db)
	cryptoRepo := sqlite.NewCryptoRepo(db)
	shareRepo := sqlite.NewShareRepo(db)
	folderRepo := sqlite.NewFolderRepo(db)
	access := NewAccessService(shareRepo, fileRepo, folderRepo)
	svc := NewCryptoService(cryptoRepo, fileRepo, access)

	ctx := context.Background()
	user := &domain.User{
		Email:        "crypto@test.local",
		Username:     "crypto",
		PasswordHash: "hash",
		Role:         "user",
	}
	if err := userRepo.Create(ctx, user); err != nil {
		t.Fatal(err)
	}

	return svc, cryptoRepo, fileRepo, userRepo, ctx, user.ID
}

func TestCryptoSetupAndGetAccount(t *testing.T) {
	svc, _, _, _, ctx, userID := setupCryptoTest(t)

	acc, err := svc.GetAccount(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if acc["has_crypto"].(bool) {
		t.Fatal("expected no crypto initially")
	}

	salt := []byte("test-salt-16bytes")
	err = svc.SetupAccount(ctx, userID, salt, "wrapped-uek", "wrapped-recovery")
	if err != nil {
		t.Fatal(err)
	}

	acc, err = svc.GetAccount(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if !acc["has_crypto"].(bool) {
		t.Fatal("expected has_crypto true")
	}
	if !acc["has_recovery"].(bool) {
		t.Fatal("expected has_recovery true")
	}

	err = svc.SetupAccount(ctx, userID, salt, "wrapped-uek2", "")
	if err != ErrCryptoAlreadySetup {
		t.Fatalf("expected ErrCryptoAlreadySetup, got %v", err)
	}
}

func TestCryptoFileKeyRoundtrip(t *testing.T) {
	svc, _, fileRepo, _, ctx, userID := setupCryptoTest(t)

	if err := svc.SetupAccount(ctx, userID, []byte("salt"), "wrapped-uek", ""); err != nil {
		t.Fatal(err)
	}

	file := &domain.File{
		Name:          "secret.bin",
		MimeType:      "application/octet-stream",
		Size:          100,
		EncryptedSize: 120,
		OwnerID:       userID,
		BlobPath:      "blobs/test",
		IV:            "iv123",
	}
	if err := fileRepo.Create(ctx, file); err != nil {
		t.Fatal(err)
	}

	if err := svc.PutFileKey(ctx, userID, file.ID, "wrapped-file-key"); err != nil {
		t.Fatal(err)
	}

	key, err := svc.GetFileKey(ctx, userID, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if key.WrappedFileKey != "wrapped-file-key" {
		t.Fatalf("unexpected key: %s", key.WrappedFileKey)
	}
}

func TestCryptoBulkAndDeltaSync(t *testing.T) {
	svc, _, fileRepo, _, ctx, userID := setupCryptoTest(t)
	if err := svc.SetupAccount(ctx, userID, []byte("salt"), "wrapped-uek", ""); err != nil {
		t.Fatal(err)
	}

	keys := make(map[string]string)
	for i := 0; i < 3; i++ {
		file := &domain.File{
			Name:          "f.bin",
			MimeType:      "application/octet-stream",
			Size:          10,
			EncryptedSize: 20,
			OwnerID:       userID,
			BlobPath:      "blobs/x",
			IV:            "iv",
		}
		if err := fileRepo.Create(ctx, file); err != nil {
			t.Fatal(err)
		}
		keys[file.ID] = "wrapped-" + file.ID
	}

	count, err := svc.BulkPutFileKeys(ctx, userID, keys)
	if err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Fatalf("expected 3 imported, got %d", count)
	}

	all, err := svc.ListKeysSince(ctx, userID, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 {
		t.Fatalf("expected 3 keys, got %d", len(all))
	}
}
