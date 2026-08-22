package sqlite

import (
	"context"
	"testing"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

func setupCommentApprovalTestDB(t *testing.T) (*DB, context.Context) {
	t.Helper()
	dir := t.TempDir()
	ctx := context.Background()

	db, err := New(dir)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, ctx
}

func createTestUser(t *testing.T, repo *UserRepo, ctx context.Context, email, username string) *domain.User {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte("password"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	user := &domain.User{
		ID:           uuid.New().String(),
		Email:        email,
		Username:     username,
		PasswordHash: string(hash),
		Role:         domain.RoleUser,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}
	if err := repo.Create(ctx, user); err != nil {
		t.Fatalf("create user: %v", err)
	}
	return user
}

func createTestFile(t *testing.T, repo *FileRepo, ctx context.Context, ownerID, name string) *domain.File {
	t.Helper()
	file := &domain.File{
		ID:       uuid.New().String(),
		Name:     name,
		MimeType: "text/plain",
		Size:     12,
		OwnerID:  ownerID,
		BlobPath: "/tmp/" + name,
		IV:       "iv",
		Version:  1,
	}
	if err := repo.Create(ctx, file); err != nil {
		t.Fatalf("create file: %v", err)
	}
	return file
}

func TestCommentAssignedToRoundTrip(t *testing.T) {
	db, ctx := setupCommentApprovalTestDB(t)
	userRepo := NewUserRepo(db)
	commentRepo := NewCommentRepo(db)
	fileRepo := NewFileRepo(db)

	author := createTestUser(t, userRepo, ctx, "author@example.com", "author")
	assignee := createTestUser(t, userRepo, ctx, "assignee@example.com", "assignee")
	file := createTestFile(t, fileRepo, ctx, author.ID, "notes.txt")

	assignedID := assignee.ID
	comment := &domain.Comment{
		FileID:     file.ID,
		UserID:     author.ID,
		Content:    "Please review",
		AssignedTo: &assignedID,
	}
	if err := commentRepo.Create(ctx, comment); err != nil {
		t.Fatalf("create comment: %v", err)
	}

	comments, err := commentRepo.GetByFileID(ctx, file.ID)
	if err != nil {
		t.Fatalf("list comments: %v", err)
	}
	if len(comments) != 1 {
		t.Fatalf("expected 1 comment, got %d", len(comments))
	}
	got := comments[0]
	if got.AssignedTo == nil || *got.AssignedTo != assignee.ID {
		t.Fatalf("assigned_to = %v, want %s", got.AssignedTo, assignee.ID)
	}
	if got.AssignedToUsername != assignee.Username {
		t.Fatalf("assigned_to_username = %q, want %q", got.AssignedToUsername, assignee.Username)
	}

	if err := commentRepo.Delete(ctx, got.ID); err != nil {
		t.Fatalf("delete comment: %v", err)
	}
	remaining, err := commentRepo.GetByFileID(ctx, file.ID)
	if err != nil {
		t.Fatalf("list after delete: %v", err)
	}
	if len(remaining) != 0 {
		t.Fatalf("expected 0 comments after delete, got %d", len(remaining))
	}
}

func TestApprovalWorkflow(t *testing.T) {
	db, ctx := setupCommentApprovalTestDB(t)
	userRepo := NewUserRepo(db)
	approvalRepo := NewApprovalRepo(db)
	fileRepo := NewFileRepo(db)

	requester := createTestUser(t, userRepo, ctx, "requester@example.com", "requester")
	approver := createTestUser(t, userRepo, ctx, "approver@example.com", "approver")
	file := createTestFile(t, fileRepo, ctx, requester.ID, "contract.pdf")

	approval := &domain.FileApproval{
		FileID:      file.ID,
		RequestedBy: requester.ID,
		ApproverID:  approver.ID,
		Status:      "pending",
	}
	if err := approvalRepo.Create(ctx, approval); err != nil {
		t.Fatalf("create approval: %v", err)
	}

	stored, err := approvalRepo.GetByID(ctx, approval.ID)
	if err != nil || stored == nil {
		t.Fatalf("get approval: %v", err)
	}
	if stored.Status != "pending" {
		t.Fatalf("status = %q, want pending", stored.Status)
	}

	stored.Status = "approved"
	if err := approvalRepo.Update(ctx, stored); err != nil {
		t.Fatalf("update approval: %v", err)
	}

	updated, err := approvalRepo.GetByID(ctx, approval.ID)
	if err != nil || updated == nil {
		t.Fatalf("get updated approval: %v", err)
	}
	if updated.Status != "approved" {
		t.Fatalf("status = %q, want approved", updated.Status)
	}

	updated.Status = "rejected"
	if err := approvalRepo.Update(ctx, updated); err != nil {
		t.Fatalf("second update should not fail at repo level: %v", err)
	}
	final, _ := approvalRepo.GetByID(ctx, approval.ID)
	if final.Status != "rejected" {
		t.Fatalf("status = %q, want rejected after second update", final.Status)
	}
}

func TestSearchFollowUpsAssignedToMe(t *testing.T) {
	db, ctx := setupCommentApprovalTestDB(t)
	userRepo := NewUserRepo(db)
	commentRepo := NewCommentRepo(db)
	fileRepo := NewFileRepo(db)
	shareRepo := NewShareRepo(db)
	searchRepo := NewSearchRepo(db)

	owner := createTestUser(t, userRepo, ctx, "owner@example.com", "owner")
	assignee := createTestUser(t, userRepo, ctx, "me@example.com", "me")

	fileWithAssignment := createTestFile(t, fileRepo, ctx, owner.ID, "assigned.txt")
	fileWithout := createTestFile(t, fileRepo, ctx, owner.ID, "plain.txt")

	fileID := fileWithAssignment.ID
	if err := shareRepo.CreateUserShare(ctx, &domain.UserShare{
		FileID:      &fileID,
		SharedBy:    owner.ID,
		SharedWith:  assignee.ID,
		Permission:  "read",
	}); err != nil {
		t.Fatalf("share file: %v", err)
	}

	assigneeID := assignee.ID
	if err := commentRepo.Create(ctx, &domain.Comment{
		FileID:     fileWithAssignment.ID,
		UserID:     owner.ID,
		Content:    "action needed",
		AssignedTo: &assigneeID,
	}); err != nil {
		t.Fatalf("create assigned comment: %v", err)
	}
	if err := commentRepo.Create(ctx, &domain.Comment{
		FileID:  fileWithout.ID,
		UserID:  owner.ID,
		Content: "no assignee",
	}); err != nil {
		t.Fatalf("create plain comment: %v", err)
	}

	opts := domain.SearchOptions{
		Location:  "Anywhere",
		FollowUps: "Comments assigned to me only",
		Page:      1,
		PageSize:  50,
	}
	result, err := searchRepo.Search(ctx, assignee.ID, opts)
	if err != nil {
		t.Fatalf("search: %v", err)
	}

	if len(result.Files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(result.Files))
	}
	if result.Files[0].ID != fileWithAssignment.ID {
		t.Fatalf("file id = %s, want %s", result.Files[0].ID, fileWithAssignment.ID)
	}
}
