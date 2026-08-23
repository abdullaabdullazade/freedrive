package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
)

// SessionRepo persists login sessions.
type SessionRepo struct {
	writer *sql.DB
	reader *sql.DB
}

// NewSessionRepo creates a session repository.
func NewSessionRepo(db *DB) *SessionRepo {
	return &SessionRepo{writer: db.Writer, reader: db.Reader}
}

func (r *SessionRepo) Create(ctx context.Context, session *domain.Session) error {
	if session.ID == "" {
		session.ID = uuid.New().String()
	}
	now := time.Now()
	if session.CreatedAt.IsZero() {
		session.CreatedAt = now
	}
	if session.LastSeenAt.IsZero() {
		session.LastSeenAt = now
	}
	if session.DeviceType == "" {
		session.DeviceType = domain.DeviceTypeWeb
	}
	_, err := r.writer.ExecContext(ctx, `
		INSERT INTO sessions (
			id, user_id, refresh_token_hash, device_id, device_name, device_type,
			user_agent, ip_address, created_at, last_seen_at, expires_at, revoked_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		session.ID, session.UserID, session.RefreshTokenHash, session.DeviceID, session.DeviceName, session.DeviceType,
		session.UserAgent, session.IPAddress, session.CreatedAt, session.LastSeenAt, session.ExpiresAt,
	)
	return err
}

func scanSession(scanner interface {
	Scan(dest ...any) error
}) (*domain.Session, error) {
	s := &domain.Session{}
	var revoked sql.NullTime
	err := scanner.Scan(
		&s.ID, &s.UserID, &s.RefreshTokenHash, &s.DeviceID, &s.DeviceName, &s.DeviceType,
		&s.UserAgent, &s.IPAddress, &s.CreatedAt, &s.LastSeenAt, &s.ExpiresAt, &revoked,
	)
	if err != nil {
		return nil, err
	}
	if revoked.Valid {
		t := revoked.Time
		s.RevokedAt = &t
	}
	return s, nil
}

const sessionSelect = `
	SELECT id, user_id, refresh_token_hash, device_id, device_name, device_type,
	       user_agent, ip_address, created_at, last_seen_at, expires_at, revoked_at
	FROM sessions`

func (r *SessionRepo) GetByID(ctx context.Context, id string) (*domain.Session, error) {
	row := r.reader.QueryRowContext(ctx, sessionSelect+` WHERE id = ?`, id)
	s, err := scanSession(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return s, err
}

func (r *SessionRepo) GetByRefreshHash(ctx context.Context, tokenHash string) (*domain.Session, error) {
	row := r.reader.QueryRowContext(ctx, sessionSelect+` WHERE refresh_token_hash = ?`, tokenHash)
	s, err := scanSession(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return s, err
}

func (r *SessionRepo) GetActiveByUserDevice(ctx context.Context, userID, deviceID string) (*domain.Session, error) {
	if deviceID == "" {
		return nil, nil
	}
	row := r.reader.QueryRowContext(ctx, sessionSelect+`
		WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL AND expires_at > ?
		ORDER BY last_seen_at DESC
		LIMIT 1`, userID, deviceID, time.Now())
	s, err := scanSession(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return s, err
}

func (r *SessionRepo) ListActiveByUser(ctx context.Context, userID string) ([]domain.Session, error) {
	rows, err := r.reader.QueryContext(ctx, sessionSelect+`
		WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
		ORDER BY last_seen_at DESC`, userID, time.Now())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []domain.Session
	for rows.Next() {
		s, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

func (r *SessionRepo) UpdateCredentials(ctx context.Context, session *domain.Session) error {
	now := time.Now()
	session.LastSeenAt = now
	_, err := r.writer.ExecContext(ctx, `
		UPDATE sessions
		SET refresh_token_hash = ?, expires_at = ?, last_seen_at = ?,
		    device_id = ?, device_name = ?, device_type = ?,
		    user_agent = ?, ip_address = ?
		WHERE id = ? AND revoked_at IS NULL`,
		session.RefreshTokenHash, session.ExpiresAt, now,
		session.DeviceID, session.DeviceName, session.DeviceType,
		session.UserAgent, session.IPAddress,
		session.ID,
	)
	return err
}

func (r *SessionRepo) UpdateDeviceMeta(ctx context.Context, id, deviceType, deviceName string) error {
	_, err := r.writer.ExecContext(ctx, `
		UPDATE sessions
		SET device_type = ?, device_name = COALESCE(NULLIF(?, ''), device_name), last_seen_at = ?
		WHERE id = ? AND revoked_at IS NULL`,
		deviceType, deviceName, time.Now(), id,
	)
	return err
}

func (r *SessionRepo) TouchLastSeen(ctx context.Context, id string, minAgeSeconds int) error {
	threshold := time.Now().Add(-time.Duration(minAgeSeconds) * time.Second)
	_, err := r.writer.ExecContext(ctx, `
		UPDATE sessions SET last_seen_at = ?
		WHERE id = ? AND revoked_at IS NULL AND last_seen_at < ?`,
		time.Now(), id, threshold,
	)
	return err
}

func (r *SessionRepo) RevokeByID(ctx context.Context, id, userID string) error {
	_, err := r.writer.ExecContext(ctx, `
		UPDATE sessions SET revoked_at = ?
		WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
		time.Now(), id, userID,
	)
	return err
}

func (r *SessionRepo) RevokeAllForUser(ctx context.Context, userID string, exceptID string) error {
	if exceptID == "" {
		_, err := r.writer.ExecContext(ctx, `
			UPDATE sessions SET revoked_at = ?
			WHERE user_id = ? AND revoked_at IS NULL`,
			time.Now(), userID,
		)
		return err
	}
	_, err := r.writer.ExecContext(ctx, `
		UPDATE sessions SET revoked_at = ?
		WHERE user_id = ? AND id != ? AND revoked_at IS NULL`,
		time.Now(), userID, exceptID,
	)
	return err
}

func (r *SessionRepo) RevokeAll(ctx context.Context) error {
	_, err := r.writer.ExecContext(ctx, `
		UPDATE sessions SET revoked_at = ?
		WHERE revoked_at IS NULL`, time.Now())
	return err
}

func (r *SessionRepo) DeleteExpired(ctx context.Context) error {
	_, err := r.writer.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at < ?`, time.Now())
	return err
}
