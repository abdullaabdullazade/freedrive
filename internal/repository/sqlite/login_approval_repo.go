package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
)

// LoginApprovalRepo implements repository.LoginApprovalRepository.
type LoginApprovalRepo struct {
	writer *sql.DB
	reader *sql.DB
}

func NewLoginApprovalRepo(db *DB) *LoginApprovalRepo {
	return &LoginApprovalRepo{writer: db.Writer, reader: db.Reader}
}

func (r *LoginApprovalRepo) Create(ctx context.Context, a *domain.LoginApproval) error {
	if a.ID == "" {
		a.ID = uuid.New().String()
	}
	if a.CreatedAt.IsZero() {
		a.CreatedAt = time.Now()
	}
	if a.Status == "" {
		a.Status = domain.LoginApprovalPending
	}
	_, err := r.writer.ExecContext(ctx, `
		INSERT INTO login_approvals (
			id, user_id, challenge_token, pending_device_id, pending_device_name, pending_device_type,
			ip_address, user_agent, status, expires_at, created_at, resolved_at,
			access_token, refresh_token, token_expires_in
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
		a.ID, a.UserID, a.ChallengeToken, a.PendingDeviceID, a.PendingDeviceName, a.PendingDeviceType,
		a.IPAddress, a.UserAgent, a.Status, a.ExpiresAt, a.CreatedAt,
		a.AccessToken, a.RefreshToken, a.TokenExpiresIn,
	)
	if err != nil {
		return fmt.Errorf("create login approval: %w", err)
	}
	return nil
}

func (r *LoginApprovalRepo) GetByID(ctx context.Context, id string) (*domain.LoginApproval, error) {
	row := r.reader.QueryRowContext(ctx, `
		SELECT id, user_id, challenge_token, pending_device_id, pending_device_name, pending_device_type,
		       ip_address, user_agent, status, expires_at, created_at, resolved_at,
		       access_token, refresh_token, token_expires_in
		FROM login_approvals WHERE id = ?`, id)
	a := &domain.LoginApproval{}
	var resolved sql.NullTime
	err := row.Scan(
		&a.ID, &a.UserID, &a.ChallengeToken, &a.PendingDeviceID, &a.PendingDeviceName, &a.PendingDeviceType,
		&a.IPAddress, &a.UserAgent, &a.Status, &a.ExpiresAt, &a.CreatedAt, &resolved,
		&a.AccessToken, &a.RefreshToken, &a.TokenExpiresIn,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if resolved.Valid {
		t := resolved.Time
		a.ResolvedAt = &t
	}
	return a, nil
}

func (r *LoginApprovalRepo) Update(ctx context.Context, a *domain.LoginApproval) error {
	_, err := r.writer.ExecContext(ctx, `
		UPDATE login_approvals SET
			status=?, resolved_at=?, access_token=?, refresh_token=?, token_expires_in=?
		WHERE id=?`,
		a.Status, a.ResolvedAt, a.AccessToken, a.RefreshToken, a.TokenExpiresIn, a.ID,
	)
	if err != nil {
		return fmt.Errorf("update login approval: %w", err)
	}
	return nil
}

func (r *LoginApprovalRepo) DeleteExpired(ctx context.Context) error {
	_, err := r.writer.ExecContext(ctx,
		`DELETE FROM login_approvals WHERE expires_at < ? OR status IN ('approved','denied','expired')`,
		time.Now().Add(-24*time.Hour),
	)
	return err
}
