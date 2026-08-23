package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
)

// ShareRepo implements repository.ShareRepository.
type ShareRepo struct {
	writer *sql.DB
	reader *sql.DB
}

func NewShareRepo(db *DB) *ShareRepo {
	return &ShareRepo{writer: db.Writer, reader: db.Reader}
}

func (r *ShareRepo) CreateLink(ctx context.Context, link *domain.ShareLink) error {
	if link.ID == "" {
		link.ID = uuid.New().String()
	}
	link.CreatedAt = time.Now()
	_, err := r.writer.ExecContext(ctx,
		`INSERT INTO share_links (id, file_id, folder_id, created_by, token, permission, password_hash, expires_at, max_downloads, download_count, is_active, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		link.ID, link.FileID, link.FolderID, link.CreatedBy, link.Token, link.Permission,
		link.PasswordHash, link.ExpiresAt, link.MaxDownloads, link.DownloadCount, link.IsActive, link.CreatedAt)
	return err
}

func (r *ShareRepo) GetLinkByToken(ctx context.Context, token string) (*domain.ShareLink, error) {
	l := &domain.ShareLink{}
	err := r.reader.QueryRowContext(ctx,
		`SELECT id, file_id, folder_id, created_by, token, permission, password_hash, expires_at, max_downloads, download_count, is_active, created_at
		 FROM share_links WHERE token = ?`, token,
	).Scan(&l.ID, &l.FileID, &l.FolderID, &l.CreatedBy, &l.Token, &l.Permission,
		&l.PasswordHash, &l.ExpiresAt, &l.MaxDownloads, &l.DownloadCount, &l.IsActive, &l.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	l.HasPassword = l.PasswordHash != ""
	return l, err
}

func (r *ShareRepo) GetLinkByID(ctx context.Context, id string) (*domain.ShareLink, error) {
	l := &domain.ShareLink{}
	err := r.reader.QueryRowContext(ctx,
		`SELECT id, file_id, folder_id, created_by, token, permission, password_hash, expires_at, max_downloads, download_count, is_active, created_at
		 FROM share_links WHERE id = ?`, id,
	).Scan(&l.ID, &l.FileID, &l.FolderID, &l.CreatedBy, &l.Token, &l.Permission,
		&l.PasswordHash, &l.ExpiresAt, &l.MaxDownloads, &l.DownloadCount, &l.IsActive, &l.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	l.HasPassword = l.PasswordHash != ""
	return l, err
}

func (r *ShareRepo) UpdateLink(ctx context.Context, link *domain.ShareLink) error {
	_, err := r.writer.ExecContext(ctx,
		`UPDATE share_links SET permission=?, password_hash=?, expires_at=?, max_downloads=?, is_active=? WHERE id=?`,
		link.Permission, link.PasswordHash, link.ExpiresAt, link.MaxDownloads, link.IsActive, link.ID)
	return err
}

func (r *ShareRepo) DeleteLink(ctx context.Context, id string) error {
	_, err := r.writer.ExecContext(ctx, "DELETE FROM share_links WHERE id = ?", id)
	return err
}

func (r *ShareRepo) ListLinksByUser(ctx context.Context, userID string) ([]domain.ShareLink, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT id, file_id, folder_id, created_by, token, permission, password_hash, expires_at, max_downloads, download_count, is_active, created_at
		 FROM share_links WHERE created_by = ? ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var links []domain.ShareLink
	for rows.Next() {
		var l domain.ShareLink
		if err := rows.Scan(&l.ID, &l.FileID, &l.FolderID, &l.CreatedBy, &l.Token, &l.Permission,
			&l.PasswordHash, &l.ExpiresAt, &l.MaxDownloads, &l.DownloadCount, &l.IsActive, &l.CreatedAt); err != nil {
			return nil, err
		}
		l.HasPassword = l.PasswordHash != ""
		links = append(links, l)
	}
	return links, nil
}

func (r *ShareRepo) IncrementDownloadCount(ctx context.Context, id string) error {
	_, err := r.writer.ExecContext(ctx,
		"UPDATE share_links SET download_count = download_count + 1 WHERE id = ?", id)
	return err
}

func (r *ShareRepo) CreateUserShare(ctx context.Context, share *domain.UserShare) error {
	if share.ID == "" {
		share.ID = uuid.New().String()
	}
	share.CreatedAt = time.Now()
	_, err := r.writer.ExecContext(ctx,
		`INSERT INTO user_shares (id, file_id, folder_id, shared_by, shared_with, permission, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		share.ID, share.FileID, share.FolderID, share.SharedBy, share.SharedWith, share.Permission, share.CreatedAt)
	return err
}

func (r *ShareRepo) DeleteUserShare(ctx context.Context, id string) error {
	_, err := r.writer.ExecContext(ctx, "DELETE FROM user_shares WHERE id = ?", id)
	return err
}

func (r *ShareRepo) UpdateUserShare(ctx context.Context, share *domain.UserShare) error {
	_, err := r.writer.ExecContext(ctx,
		`UPDATE user_shares SET permission = ? WHERE id = ?`,
		share.Permission, share.ID,
	)
	return err
}

func (r *ShareRepo) GetUserShareByID(ctx context.Context, id string) (*domain.UserShare, error) {
	row := r.reader.QueryRowContext(ctx,
		`SELECT id, file_id, folder_id, shared_by, shared_with, permission, created_at
		 FROM user_shares WHERE id = ?`, id,
	)
	var s domain.UserShare
	err := row.Scan(&s.ID, &s.FileID, &s.FolderID, &s.SharedBy, &s.SharedWith, &s.Permission, &s.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (r *ShareRepo) ListSharedByUser(ctx context.Context, userID string) ([]domain.UserShare, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT id, file_id, folder_id, shared_by, shared_with, permission, created_at
		 FROM user_shares WHERE shared_by = ? ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var shares []domain.UserShare
	for rows.Next() {
		var s domain.UserShare
		if err := rows.Scan(&s.ID, &s.FileID, &s.FolderID, &s.SharedBy, &s.SharedWith, &s.Permission, &s.CreatedAt); err != nil {
			return nil, err
		}
		shares = append(shares, s)
	}
	return shares, nil
}

func (r *ShareRepo) ListSharedWithUser(ctx context.Context, userID string) ([]domain.UserShare, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT id, file_id, folder_id, shared_by, shared_with, permission, created_at
		 FROM user_shares WHERE shared_with = ? ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var shares []domain.UserShare
	for rows.Next() {
		var s domain.UserShare
		if err := rows.Scan(&s.ID, &s.FileID, &s.FolderID, &s.SharedBy, &s.SharedWith, &s.Permission, &s.CreatedAt); err != nil {
			return nil, err
		}
		shares = append(shares, s)
	}
	return shares, nil
}
