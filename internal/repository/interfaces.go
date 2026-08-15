package repository

import (
	"context"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
)

// UserRepository defines data access for users.
type UserRepository interface {
	Create(ctx context.Context, user *domain.User) error
	GetByID(ctx context.Context, id string) (*domain.User, error)
	GetByEmail(ctx context.Context, email string) (*domain.User, error)
	Update(ctx context.Context, user *domain.User) error
	Delete(ctx context.Context, id string) error
	List(ctx context.Context) ([]domain.User, error)
	UpdateUsedBytes(ctx context.Context, userID string, delta int64) error
	Count(ctx context.Context) (int, error)

	// Refresh tokens
	CreateRefreshToken(ctx context.Context, token *domain.RefreshToken) error
	GetRefreshToken(ctx context.Context, tokenHash string) (*domain.RefreshToken, error)
	DeleteRefreshToken(ctx context.Context, tokenHash string) error
	DeleteUserRefreshTokens(ctx context.Context, userID string) error
	DeleteAllRefreshTokens(ctx context.Context) error

	// Invite links
	CreateInvite(ctx context.Context, invite *domain.InviteLink) error
	GetInviteByCode(ctx context.Context, code string) (*domain.InviteLink, error)
	IncrementInviteUsage(ctx context.Context, id string) error
	ListInvites(ctx context.Context) ([]domain.InviteLink, error)
	DeleteInvite(ctx context.Context, id string) error
	DeleteAllInvites(ctx context.Context) error
	WipeAllDataExcept(ctx context.Context, keepUserID string) error
}

// EmailChangeRepository defines data access for email change tokens.
type EmailChangeRepository interface {
	Create(ctx context.Context, token *domain.EmailChangeToken) error
	GetByTokenHash(ctx context.Context, tokenHash string) (*domain.EmailChangeToken, error)
	GetPendingByUserID(ctx context.Context, userID string) (*domain.EmailChangeToken, error)
	DeleteByUserID(ctx context.Context, userID string) error
	DeleteByID(ctx context.Context, id string) error
}

// Email2FARepository defines data access for login 2FA challenges.
type Email2FARepository interface {
	Create(ctx context.Context, challenge *domain.Email2FAChallenge) error
	GetByID(ctx context.Context, id string) (*domain.Email2FAChallenge, error)
	Update(ctx context.Context, challenge *domain.Email2FAChallenge) error
	DeleteByUserID(ctx context.Context, userID string) error
	DeleteByID(ctx context.Context, id string) error
}

// LoginApprovalRepository stores Google-style login prompts.
type LoginApprovalRepository interface {
	Create(ctx context.Context, a *domain.LoginApproval) error
	GetByID(ctx context.Context, id string) (*domain.LoginApproval, error)
	Update(ctx context.Context, a *domain.LoginApproval) error
	DeleteExpired(ctx context.Context) error
}

// PushTokenRepository stores Expo push tokens for trusted devices.
type PushTokenRepository interface {
	Upsert(ctx context.Context, token *domain.PushToken) error
	ListByUser(ctx context.Context, userID string) ([]domain.PushToken, error)
	DeleteByUserDevice(ctx context.Context, userID, deviceID string) error
	DeleteByToken(ctx context.Context, userID, expoPushToken string) error
}

// TotpBackupRepository defines data access for TOTP backup codes.
type TotpBackupRepository interface {
	ReplaceAll(ctx context.Context, userID string, codeHashes []string) error
	ConsumeUnused(ctx context.Context, userID, codeHash string) (bool, error)
	DeleteByUserID(ctx context.Context, userID string) error
}

// FileRepository defines data access for files.
type FileRepository interface {
	Create(ctx context.Context, file *domain.File) error
	GetByID(ctx context.Context, id string) (*domain.File, error)
	Update(ctx context.Context, file *domain.File) error
	Delete(ctx context.Context, id string) error
	List(ctx context.Context, opts domain.FileListOptions) ([]domain.File, int, error)
	GetByFolderID(ctx context.Context, folderID *string, ownerID string) ([]domain.File, error)
	GetByFolderIDPage(ctx context.Context, folderID *string, ownerID string, limit, offset int) ([]domain.File, int, error)
	GetByFolderIDs(ctx context.Context, folderIDs []string) ([]domain.File, error)
	MoveToTrash(ctx context.Context, id string) error
	RestoreFromTrash(ctx context.Context, id string) error
	GetTrashedFiles(ctx context.Context, ownerID string) ([]domain.File, error)
	PurgeOldTrashed(ctx context.Context, days int) ([]domain.File, error)
	PurgeAllTrashed(ctx context.Context) ([]domain.File, error)
	PurgeAllTrashedForOwner(ctx context.Context, ownerID string) ([]domain.File, error)
	ListDuplicateGroups(ctx context.Context) ([]domain.DuplicateGroup, error)
	ListDuplicateFilesToRemove(ctx context.Context) ([]domain.File, error)
	ListAllBlobPaths(ctx context.Context) ([]string, error)
	ListBlobPathsByOwner(ctx context.Context, ownerID string) ([]string, error)
	CountByOwner(ctx context.Context, ownerID string) (int, error)
	SumEncryptedSizeByOwner(ctx context.Context, ownerID string) (int64, error)
	SumAllEncryptedSize(ctx context.Context) (int64, error)
	ListFileMetaByOwner(ctx context.Context, ownerID string) ([]domain.FileMeta, error)
	ListFileMetaAll(ctx context.Context) ([]domain.FileMeta, error)

	// Versioning
	CreateVersion(ctx context.Context, version *domain.FileVersion) error
	GetVersions(ctx context.Context, fileID string) ([]domain.FileVersion, error)
	GetVersion(ctx context.Context, fileID string, version int) (*domain.FileVersion, error)
	DeleteOldVersions(ctx context.Context, fileID string, keepCount int) ([]domain.FileVersion, error)
}

// ComputerRepository defines data access for registered desktop devices.
type ComputerRepository interface {
	Create(ctx context.Context, computer *domain.Computer) error
	GetByID(ctx context.Context, id string) (*domain.Computer, error)
	GetByOwnerAndHostname(ctx context.Context, ownerID, hostname string) (*domain.Computer, error)
	ListByOwner(ctx context.Context, ownerID string) ([]domain.Computer, error)
	Delete(ctx context.Context, id string) error
	UpdateLastSeen(ctx context.Context, id string, at time.Time) error
	IsComputerRoot(ctx context.Context, folderID string) (bool, error)
	IsInComputerTree(ctx context.Context, folderID string) (bool, error)
	GetComputerForFolder(ctx context.Context, folderID string) (*domain.Computer, error)
}

// FolderRepository defines data access for folders.
type FolderRepository interface {
	Create(ctx context.Context, folder *domain.Folder) error
	GetByID(ctx context.Context, id string) (*domain.Folder, error)
	// GetByParentName returns a folder by parent + name + owner, including trashed rows.
	GetByParentName(ctx context.Context, parentID *string, name, ownerID string) (*domain.Folder, error)
	Update(ctx context.Context, folder *domain.Folder) error
	Delete(ctx context.Context, id string) error
	GetChildren(ctx context.Context, parentID *string, ownerID string) ([]domain.Folder, error)
	ListAll(ctx context.Context, ownerID, search string) ([]domain.Folder, error)
	GetBreadcrumb(ctx context.Context, id string) ([]domain.Breadcrumb, error)
	IsDescendant(ctx context.Context, folderID, potentialParentID string) (bool, error)
	MoveToTrash(ctx context.Context, id string) error
	RestoreFromTrash(ctx context.Context, id string) error
	GetTrashedFolders(ctx context.Context, ownerID string) ([]domain.Folder, error)
	ListAllTrashed(ctx context.Context) ([]domain.Folder, error)
	ListAllTrashedForOwner(ctx context.Context, ownerID string) ([]domain.Folder, error)
	ListOldTrashed(ctx context.Context, days int) ([]domain.Folder, error)
	PurgeAllTrashed(ctx context.Context) ([]domain.Folder, error)
	PurgeAllTrashedForOwner(ctx context.Context, ownerID string) ([]domain.Folder, error)
	PurgeOldTrashed(ctx context.Context, days int) ([]domain.Folder, error)
	ListSubtreeIDs(ctx context.Context, id string) ([]string, error)
}

// ShareRepository defines data access for sharing.
type ShareRepository interface {
	CreateLink(ctx context.Context, link *domain.ShareLink) error
	GetLinkByToken(ctx context.Context, token string) (*domain.ShareLink, error)
	GetLinkByID(ctx context.Context, id string) (*domain.ShareLink, error)
	UpdateLink(ctx context.Context, link *domain.ShareLink) error
	DeleteLink(ctx context.Context, id string) error
	ListLinksByUser(ctx context.Context, userID string) ([]domain.ShareLink, error)
	IncrementDownloadCount(ctx context.Context, id string) error

	CreateUserShare(ctx context.Context, share *domain.UserShare) error
	UpdateUserShare(ctx context.Context, share *domain.UserShare) error
	GetUserShareByID(ctx context.Context, id string) (*domain.UserShare, error)
	DeleteUserShare(ctx context.Context, id string) error
	ListSharedByUser(ctx context.Context, userID string) ([]domain.UserShare, error)
	ListSharedWithUser(ctx context.Context, userID string) ([]domain.UserShare, error)
}

// CommentRepository defines data access for comments.
type CommentRepository interface {
	Create(ctx context.Context, comment *domain.Comment) error
	GetByFileID(ctx context.Context, fileID string) ([]domain.Comment, error)
	Delete(ctx context.Context, id string) error
}

// PasswordResetRepository defines data access for password reset tokens.
type PasswordResetRepository interface {
	Create(ctx context.Context, token *domain.PasswordResetToken) error
	GetByTokenHash(ctx context.Context, tokenHash string) (*domain.PasswordResetToken, error)
	DeleteByUserID(ctx context.Context, userID string) error
	DeleteByID(ctx context.Context, id string) error
}

// ActivityRepository defines data access for activity logs.
type ActivityRepository interface {
	Create(ctx context.Context, log *domain.ActivityLog) error
	List(ctx context.Context, userID string, page, pageSize int) ([]domain.ActivityLog, int, error)
	ListAll(ctx context.Context, page, pageSize int) ([]domain.ActivityLog, int, error)
	// ListAllAuth returns only authentication events (login / failed_login) for the admin activity log.
	ListAllAuth(ctx context.Context, page, pageSize int) ([]domain.ActivityLog, int, error)
	DeleteAll(ctx context.Context) error
}

// SyncChangeRepository defines data access for the computer sync change feed.
type SyncChangeRepository interface {
	Append(ctx context.Context, change *domain.SyncChange) error
	ListSince(ctx context.Context, userID, computerRootID string, cursor int64, limit int) ([]domain.SyncChange, error)
	MaxSeq(ctx context.Context, userID, computerRootID string) (int64, error)
	SnapshotBoundary(ctx context.Context, userID, computerRootID string) (int64, time.Time, error)
}

// ClientMutationRepository tracks idempotent desktop mutation IDs.
type ClientMutationRepository interface {
	TryRecord(ctx context.Context, userID, mutationID string) (bool, error)
	Exists(ctx context.Context, userID, mutationID string) (bool, error)
}

// SessionRepository defines data access for login sessions.
type SessionRepository interface {
	Create(ctx context.Context, session *domain.Session) error
	GetByID(ctx context.Context, id string) (*domain.Session, error)
	GetByRefreshHash(ctx context.Context, tokenHash string) (*domain.Session, error)
	GetActiveByUserDevice(ctx context.Context, userID, deviceID string) (*domain.Session, error)
	ListActiveByUser(ctx context.Context, userID string) ([]domain.Session, error)
	// UpdateCredentials rotates the refresh token and refreshes device metadata.
	UpdateCredentials(ctx context.Context, session *domain.Session) error
	TouchLastSeen(ctx context.Context, id string, minAgeSeconds int) error
	RevokeByID(ctx context.Context, id, userID string) error
	RevokeAllForUser(ctx context.Context, userID string, exceptID string) error
	RevokeAll(ctx context.Context) error
	DeleteExpired(ctx context.Context) error
}

// CryptoRepository defines data access for E2E encryption key sync.
type CryptoRepository interface {
	GetUserCrypto(ctx context.Context, userID string) (*domain.UserCrypto, error)
	CreateUserCrypto(ctx context.Context, crypto *domain.UserCrypto) error
	UpdateUserCrypto(ctx context.Context, crypto *domain.UserCrypto) error

	GetFileEncryptionKey(ctx context.Context, fileID string) (*domain.FileEncryptionKey, error)
	UpsertFileEncryptionKey(ctx context.Context, key *domain.FileEncryptionKey) error
	ListFileEncryptionKeysSince(ctx context.Context, ownerID string, since time.Time, limit int) ([]domain.EncryptionKeyEntry, error)
}

// UploadSessionRepository persists resumable upload sessions.
type UploadSessionRepository interface {
	Create(ctx context.Context, session *domain.UploadSession) error
	GetByID(ctx context.Context, id string) (*domain.UploadSession, error)
	UpdateReceived(ctx context.Context, id string, receivedBytes int64) error
	Delete(ctx context.Context, id string) error
	DeleteExpired(ctx context.Context, now time.Time) ([]domain.UploadSession, error)
	ListByUser(ctx context.Context, userID string) ([]domain.UploadSession, error)
}
