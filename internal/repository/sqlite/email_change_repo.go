package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
)

// EmailChangeRepo implements repository.EmailChangeRepository.
type EmailChangeRepo struct {
	writer *sql.DB
	reader *sql.DB
}

func NewEmailChangeRepo(db *DB) *EmailChangeRepo {
	return &EmailChangeRepo{writer: db.Writer, reader: db.Reader}
}

func (r *EmailChangeRepo) Create(ctx context.Context, token *domain.EmailChangeToken) error {
	if token.ID == "" {
		token.ID = uuid.New().String()
	}
	if token.CreatedAt.IsZero() {
		token.CreatedAt = time.Now()
	}
	_, err := r.writer.ExecContext(ctx,
		`INSERT INTO email_change_tokens (id, user_id, new_email, token_hash, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		token.ID, token.UserID, token.NewEmail, token.TokenHash, token.ExpiresAt, token.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("create email change token: %w", err)
	}
	return nil
}

func (r *EmailChangeRepo) GetByTokenHash(ctx context.Context, tokenHash string) (*domain.EmailChangeToken, error) {
	row := r.reader.QueryRowContext(ctx,
		`SELECT id, user_id, new_email, token_hash, expires_at, created_at
		 FROM email_change_tokens WHERE token_hash = ?`, tokenHash,
	)
	return scanEmailChangeToken(row)
}

func (r *EmailChangeRepo) GetPendingByUserID(ctx context.Context, userID string) (*domain.EmailChangeToken, error) {
	row := r.reader.QueryRowContext(ctx,
		`SELECT id, user_id, new_email, token_hash, expires_at, created_at
		 FROM email_change_tokens
		 WHERE user_id = ? AND expires_at > ?
		 ORDER BY created_at DESC LIMIT 1`, userID, time.Now(),
	)
	return scanEmailChangeToken(row)
}

func (r *EmailChangeRepo) DeleteByUserID(ctx context.Context, userID string) error {
	_, err := r.writer.ExecContext(ctx, "DELETE FROM email_change_tokens WHERE user_id = ?", userID)
	return err
}

func (r *EmailChangeRepo) DeleteByID(ctx context.Context, id string) error {
	_, err := r.writer.ExecContext(ctx, "DELETE FROM email_change_tokens WHERE id = ?", id)
	return err
}

func scanEmailChangeToken(row *sql.Row) (*domain.EmailChangeToken, error) {
	var t domain.EmailChangeToken
	err := row.Scan(&t.ID, &t.UserID, &t.NewEmail, &t.TokenHash, &t.ExpiresAt, &t.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}
