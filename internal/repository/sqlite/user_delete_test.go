package sqlite

import (
	"context"
	"testing"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
)

func TestUserRepoDeleteClearsNonCascadeFKs(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	db, err := New(dir)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	userRepo := NewUserRepo(db)
	folderRepo := NewFolderRepo(db)
	fileRepo := NewFileRepo(db)

	owner := createTestUser(t, userRepo, ctx, "owner-del@example.com", "owner-del")
	other := createTestUser(t, userRepo, ctx, "other-del@example.com", "other-del")

	folder := &domain.Folder{
		ID:      uuid.New().String(),
		Name:    "Docs",
		OwnerID: owner.ID,
	}
	if err := folderRepo.Create(ctx, folder); err != nil {
		t.Fatalf("create folder: %v", err)
	}

	file := &domain.File{
		ID:            uuid.New().String(),
		Name:          "a.txt",
		MimeType:      "text/plain",
		Size:          3,
		EncryptedSize: 3,
		OwnerID:       owner.ID,
		FolderID:      &folder.ID,
		BlobPath:      "/tmp/a.txt",
		IV:            "iv",
		Version:       1,
	}
	if err := fileRepo.Create(ctx, file); err != nil {
		t.Fatalf("create file: %v", err)
	}

	// Non-cascade blockers that previously prevented DELETE FROM users.
	if err := userRepo.CreateInvite(ctx, &domain.InviteLink{
		Code:       "INVITE-DEL-1",
		CreatedBy:  owner.ID,
		Email:      "invitee@example.com",
		Role:       "user",
		QuotaBytes: 1 << 30,
		MaxUses:    1,
	}); err != nil {
		t.Fatalf("create invite: %v", err)
	}

	if _, err := db.Writer.ExecContext(ctx, `
		INSERT INTO share_links (id, file_id, created_by, token, permission)
		VALUES (?, ?, ?, ?, 'read')`,
		uuid.New().String(), file.ID, owner.ID, "tok-del-1"); err != nil {
		t.Fatalf("create share link: %v", err)
	}

	if _, err := db.Writer.ExecContext(ctx, `
		INSERT INTO user_shares (id, file_id, shared_by, shared_with, permission)
		VALUES (?, ?, ?, ?, 'read')`,
		uuid.New().String(), file.ID, owner.ID, other.ID); err != nil {
		t.Fatalf("create user share: %v", err)
	}

	if _, err := db.Writer.ExecContext(ctx, `
		INSERT INTO comments (id, file_id, user_id, content)
		VALUES (?, ?, ?, 'hi')`,
		uuid.New().String(), file.ID, owner.ID); err != nil {
		t.Fatalf("create comment: %v", err)
	}

	if _, err := db.Writer.ExecContext(ctx, `
		INSERT INTO activity_log (id, user_id, action, target_type, target_id)
		VALUES (?, ?, 'upload', 'file', ?)`,
		uuid.New().String(), owner.ID, file.ID); err != nil {
		t.Fatalf("create activity: %v", err)
	}

	if _, err := db.Writer.ExecContext(ctx, `
		INSERT INTO file_versions (id, file_id, version, size, blob_path, iv, created_by)
		VALUES (?, ?, 1, 3, '/tmp/a-v1.txt', 'iv', ?)`,
		uuid.New().String(), file.ID, owner.ID); err != nil {
		t.Fatalf("create file version: %v", err)
	}

	if err := userRepo.Delete(ctx, owner.ID); err != nil {
		t.Fatalf("delete user: %v", err)
	}

	got, err := userRepo.GetByID(ctx, owner.ID)
	if err != nil {
		t.Fatalf("get deleted user: %v", err)
	}
	if got != nil {
		t.Fatal("expected user row to be gone")
	}

	gotFile, err := fileRepo.GetByID(ctx, file.ID)
	if err != nil {
		t.Fatalf("get file: %v", err)
	}
	if gotFile != nil {
		t.Fatal("expected owned file to cascade-delete with user")
	}

	gotFolder, err := folderRepo.GetByID(ctx, folder.ID)
	if err != nil {
		t.Fatalf("get folder: %v", err)
	}
	if gotFolder != nil {
		t.Fatal("expected owned folder to cascade-delete with user")
	}

	var remainingFiles int
	if err := db.Reader.QueryRowContext(ctx, "SELECT COUNT(*) FROM files WHERE owner_id = ?", owner.ID).Scan(&remainingFiles); err != nil {
		t.Fatalf("count files: %v", err)
	}
	if remainingFiles != 0 {
		t.Fatalf("expected 0 owned files after delete, got %d", remainingFiles)
	}
	var remainingFolders int
	if err := db.Reader.QueryRowContext(ctx, "SELECT COUNT(*) FROM folders WHERE owner_id = ?", owner.ID).Scan(&remainingFolders); err != nil {
		t.Fatalf("count folders: %v", err)
	}
	if remainingFolders != 0 {
		t.Fatalf("expected 0 owned folders after delete, got %d", remainingFolders)
	}
}
