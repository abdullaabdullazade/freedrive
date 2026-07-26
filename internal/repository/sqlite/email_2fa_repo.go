package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
)

// Email2FARepo implements repository.Email2FARepository.
type Email2FARepo struct {
	writer *sql.DB
	reader *sql.DB
}

func NewEmail2FARepo(db *DB) *Email2FARepo {
	return &Email2FARepo{writer: db.Writer, reader: db.Reader}
}

func (r *Email2FARepo) Create(ctx context.Context, challenge *domain.Email2FAChallenge) error {
	if challenge.ID == "" {
		challenge.ID = uuid.New().String()
	}
	if challenge.CreatedAt.IsZero() {
		challenge.CreatedAt = time.Now()
	}
	if challenge.Method == "" {
		challenge.Method = domain.TwoFAMethodEmail
	}
	_, err := r.writer.ExecContext(ctx,
		`INSERT INTO email_2fa_challenges (id, user_id, method, code_hash, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		challenge.ID, challenge.UserID, challenge.Method, challenge.CodeHash, challenge.ExpiresAt, challenge.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("create email 2fa challenge: %w", err)
	}
	return nil
}

func (r *Email2FARepo) GetByID(ctx context.Context, id string) (*domain.Email2FAChallenge, error) {
	row := r.reader.QueryRowContext(ctx,
		`SELECT id, user_id, method, code_hash, expires_at, created_at
		 FROM email_2fa_challenges WHERE id = ?`, id,
	)
	var c domain.Email2FAChallenge
	err := row.Scan(&c.ID, &c.UserID, &c.Method, &c.CodeHash, &c.ExpiresAt, &c.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if c.Method == "" {
		c.Method = domain.TwoFAMethodEmail
	}
	return &c, nil
}

func (r *Email2FARepo) Update(ctx context.Context, challenge *domain.Email2FAChallenge) error {
	if challenge.Method == "" {
		challenge.Method = domain.TwoFAMethodEmail
	}
	_, err := r.writer.ExecContext(ctx,
		`UPDATE email_2fa_challenges SET method=?, code_hash=?, expires_at=? WHERE id=?`,
		challenge.Method, challenge.CodeHash, challenge.ExpiresAt, challenge.ID,
	)
	if err != nil {
		return fmt.Errorf("update email 2fa challenge: %w", err)
	}
	return nil
}

func (r *Email2FARepo) DeleteByUserID(ctx context.Context, userID string) error {
	_, err := r.writer.ExecContext(ctx, "DELETE FROM email_2fa_challenges WHERE user_id = ?", userID)
	return err
}

func (r *Email2FARepo) DeleteByID(ctx context.Context, id string) error {
	_, err := r.writer.ExecContext(ctx, "DELETE FROM email_2fa_challenges WHERE id = ?", id)
	return err
}
