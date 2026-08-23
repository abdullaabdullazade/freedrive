package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
)

// PushTokenRepo implements repository.PushTokenRepository.
type PushTokenRepo struct {
	writer *sql.DB
	reader *sql.DB
}

func NewPushTokenRepo(db *DB) *PushTokenRepo {
	return &PushTokenRepo{writer: db.Writer, reader: db.Reader}
}

func (r *PushTokenRepo) Upsert(ctx context.Context, token *domain.PushToken) error {
	now := time.Now()
	if token.ID == "" {
		token.ID = uuid.New().String()
	}
	if token.CreatedAt.IsZero() {
		token.CreatedAt = now
	}
	token.UpdatedAt = now
	if token.Platform == "" {
		token.Platform = "android"
	}
	_, err := r.writer.ExecContext(ctx, `
		INSERT INTO push_tokens (id, user_id, device_id, expo_push_token, platform, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, device_id) DO UPDATE SET
			expo_push_token = excluded.expo_push_token,
			platform = excluded.platform,
			updated_at = excluded.updated_at`,
		token.ID, token.UserID, token.DeviceID, token.ExpoPushToken, token.Platform, token.CreatedAt, token.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("upsert push token: %w", err)
	}
	return nil
}

func (r *PushTokenRepo) ListByUser(ctx context.Context, userID string) ([]domain.PushToken, error) {
	rows, err := r.reader.QueryContext(ctx, `
		SELECT id, user_id, device_id, expo_push_token, platform, created_at, updated_at
		FROM push_tokens WHERE user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.PushToken
	for rows.Next() {
		var t domain.PushToken
		if err := rows.Scan(&t.ID, &t.UserID, &t.DeviceID, &t.ExpoPushToken, &t.Platform, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (r *PushTokenRepo) DeleteByUserDevice(ctx context.Context, userID, deviceID string) error {
	_, err := r.writer.ExecContext(ctx,
		`DELETE FROM push_tokens WHERE user_id = ? AND device_id = ?`, userID, deviceID)
	return err
}

func (r *PushTokenRepo) DeleteByToken(ctx context.Context, userID, expoPushToken string) error {
	_, err := r.writer.ExecContext(ctx,
		`DELETE FROM push_tokens WHERE user_id = ? AND expo_push_token = ?`, userID, expoPushToken)
	return err
}
