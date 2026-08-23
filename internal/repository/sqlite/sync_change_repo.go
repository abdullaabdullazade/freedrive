package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
)

// SyncChangeRepo implements sync change persistence.
type SyncChangeRepo struct {
	writer *sql.DB
	reader *sql.DB
}

// NewSyncChangeRepo creates a sync change repository.
func NewSyncChangeRepo(db *DB) *SyncChangeRepo {
	return &SyncChangeRepo{writer: db.Writer, reader: db.Reader}
}

func (r *SyncChangeRepo) Append(ctx context.Context, change *domain.SyncChange) error {
	payload := change.Payload
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	isTombstone := 0
	if change.IsTombstone {
		isTombstone = 1
	}
	res, err := r.writer.ExecContext(ctx, `
		INSERT INTO sync_changes (
			user_id, computer_root_id, entity_type, entity_id, parent_id,
			operation, name, version, occurred_at, payload, is_tombstone
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		change.UserID, change.ComputerRootID, change.EntityType, change.EntityID,
		change.ParentID, change.Operation, change.Name, change.Version,
		change.OccurredAt, string(payload), isTombstone,
	)
	if err != nil {
		return err
	}
	seq, err := res.LastInsertId()
	if err != nil {
		return err
	}
	change.Seq = seq
	return nil
}

func (r *SyncChangeRepo) ListSince(ctx context.Context, userID, computerRootID string, cursor int64, limit int) ([]domain.SyncChange, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := r.reader.QueryContext(ctx, `
		SELECT seq, user_id, computer_root_id, entity_type, entity_id, parent_id,
		       operation, name, version, occurred_at, payload, is_tombstone
		FROM sync_changes
		WHERE user_id = ? AND computer_root_id = ? AND seq > ?
		ORDER BY seq ASC
		LIMIT ?`, userID, computerRootID, cursor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var changes []domain.SyncChange
	for rows.Next() {
		var c domain.SyncChange
		var parentID sql.NullString
		var payload string
		var isTombstone int
		if err := rows.Scan(
			&c.Seq, &c.UserID, &c.ComputerRootID, &c.EntityType, &c.EntityID, &parentID,
			&c.Operation, &c.Name, &c.Version, &c.OccurredAt, &payload, &isTombstone,
		); err != nil {
			return nil, err
		}
		if parentID.Valid {
			c.ParentID = &parentID.String
		}
		c.Payload = json.RawMessage(payload)
		c.IsTombstone = isTombstone == 1
		changes = append(changes, c)
	}
	return changes, rows.Err()
}

func (r *SyncChangeRepo) MaxSeq(ctx context.Context, userID, computerRootID string) (int64, error) {
	var max sql.NullInt64
	err := r.reader.QueryRowContext(ctx, `
		SELECT MAX(seq) FROM sync_changes WHERE user_id = ? AND computer_root_id = ?`,
		userID, computerRootID,
	).Scan(&max)
	if err != nil {
		return 0, err
	}
	if !max.Valid {
		return 0, nil
	}
	return max.Int64, nil
}

func (r *SyncChangeRepo) SnapshotBoundary(ctx context.Context, userID, computerRootID string) (int64, time.Time, error) {
	at := time.Now()
	res, err := r.writer.ExecContext(ctx, `
		INSERT INTO sync_changes (
			user_id, computer_root_id, entity_type, entity_id, parent_id,
			operation, name, version, occurred_at, payload, is_tombstone
		) VALUES (?, ?, 'folder', ?, ?, 'snapshot', '', 0, ?, '{}', 0)`,
		userID, computerRootID, computerRootID, computerRootID, at,
	)
	if err != nil {
		return 0, time.Time{}, err
	}
	seq, err := res.LastInsertId()
	return seq, at, err
}
