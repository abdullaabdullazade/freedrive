package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
)

// PasswordResetRepo implements repository.PasswordResetRepository.
type PasswordResetRepo struct {
	writer *sql.DB
	reader *sql.DB
}

func NewPasswordResetRepo(db *DB) *PasswordResetRepo {
	return &PasswordResetRepo{writer: db.Writer, reader: db.Reader}
}

func (r *PasswordResetRepo) Create(ctx context.Context, token *domain.PasswordResetToken) error {
	if token.ID == "" {
		token.ID = uuid.New().String()
	}
	if token.CreatedAt.IsZero() {
		token.CreatedAt = time.Now()
	}
	_, err := r.writer.ExecContext(ctx,
		`INSERT INTO password_reset_tokens (id, user_id, email, token_hash, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		token.ID, token.UserID, token.Email, token.TokenHash, token.ExpiresAt, token.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("create password reset token: %w", err)
	}
	return nil
}

func (r *PasswordResetRepo) GetByTokenHash(ctx context.Context, tokenHash string) (*domain.PasswordResetToken, error) {
	row := r.reader.QueryRowContext(ctx,
		`SELECT id, user_id, email, token_hash, expires_at, created_at
		 FROM password_reset_tokens WHERE token_hash = ?`, tokenHash,
	)
	var t domain.PasswordResetToken
	err := row.Scan(&t.ID, &t.UserID, &t.Email, &t.TokenHash, &t.ExpiresAt, &t.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (r *PasswordResetRepo) DeleteByUserID(ctx context.Context, userID string) error {
	_, err := r.writer.ExecContext(ctx, "DELETE FROM password_reset_tokens WHERE user_id = ?", userID)
	return err
}

func (r *PasswordResetRepo) DeleteByID(ctx context.Context, id string) error {
	_, err := r.writer.ExecContext(ctx, "DELETE FROM password_reset_tokens WHERE id = ?", id)
	return err
}
