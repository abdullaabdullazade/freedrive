package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
)

// UploadSessionRepo persists resumable upload sessions.
type UploadSessionRepo struct {
	writer *sql.DB
	reader *sql.DB
}

// NewUploadSessionRepo creates an upload session repository.
func NewUploadSessionRepo(db *DB) *UploadSessionRepo {
	return &UploadSessionRepo{writer: db.Writer, reader: db.Reader}
}

func scanUploadSession(row interface {
	Scan(dest ...any) error
}) (*domain.UploadSession, error) {
	var s domain.UploadSession
	var fileID, folderID sql.NullString
	err := row.Scan(
		&s.ID, &s.UserID, &fileID, &s.Name, &s.MimeType, &s.IV,
		&s.OriginalSize, &s.EncryptedSize, &folderID, &s.TempPath,
		&s.ReceivedBytes, &s.CreatedAt, &s.ExpiresAt,
	)
	if err != nil {
		return nil, err
	}
	if fileID.Valid && fileID.String != "" {
		s.FileID = &fileID.String
	}
	if folderID.Valid && folderID.String != "" {
		s.FolderID = &folderID.String
	}
	return &s, nil
}

const uploadSessionCols = `id, user_id, file_id, name, mime_type, iv, original_size, encrypted_size,
	folder_id, temp_path, received_bytes, created_at, expires_at`

// Create inserts a new upload session.
func (r *UploadSessionRepo) Create(ctx context.Context, session *domain.UploadSession) error {
	_, err := r.writer.ExecContext(ctx, `
		INSERT INTO upload_sessions (
			id, user_id, file_id, name, mime_type, iv, original_size, encrypted_size,
			folder_id, temp_path, received_bytes, created_at, expires_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		session.ID, session.UserID, nullStr(session.FileID), session.Name, session.MimeType, session.IV,
		session.OriginalSize, session.EncryptedSize, nullStr(session.FolderID), session.TempPath,
		session.ReceivedBytes, session.CreatedAt, session.ExpiresAt,
	)
	return err
}

func nullStr(p *string) interface{} {
	if p == nil || *p == "" {
		return nil
	}
	return *p
}

// GetByID returns a session by id.
func (r *UploadSessionRepo) GetByID(ctx context.Context, id string) (*domain.UploadSession, error) {
	row := r.reader.QueryRowContext(ctx,
		`SELECT `+uploadSessionCols+` FROM upload_sessions WHERE id = ?`, id)
	s, err := scanUploadSession(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return s, err
}

// UpdateReceived sets received_bytes.
func (r *UploadSessionRepo) UpdateReceived(ctx context.Context, id string, receivedBytes int64) error {
	_, err := r.writer.ExecContext(ctx,
		`UPDATE upload_sessions SET received_bytes = ? WHERE id = ?`, receivedBytes, id)
	return err
}

// Delete removes a session row.
func (r *UploadSessionRepo) Delete(ctx context.Context, id string) error {
	_, err := r.writer.ExecContext(ctx, `DELETE FROM upload_sessions WHERE id = ?`, id)
	return err
}

// DeleteExpired removes expired sessions and returns them (for temp file cleanup).
func (r *UploadSessionRepo) DeleteExpired(ctx context.Context, now time.Time) ([]domain.UploadSession, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT `+uploadSessionCols+` FROM upload_sessions WHERE expires_at <= ?`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var expired []domain.UploadSession
	for rows.Next() {
		s, err := scanUploadSession(rows)
		if err != nil {
			return nil, err
		}
		expired = append(expired, *s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(expired) == 0 {
		return nil, nil
	}
	_, err = r.writer.ExecContext(ctx, `DELETE FROM upload_sessions WHERE expires_at <= ?`, now)
	return expired, err
}

// ListByUser returns active sessions for a user.
func (r *UploadSessionRepo) ListByUser(ctx context.Context, userID string) ([]domain.UploadSession, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT `+uploadSessionCols+` FROM upload_sessions WHERE user_id = ? ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.UploadSession
	for rows.Next() {
		s, err := scanUploadSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}
