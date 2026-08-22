package sqlite

import (
	"context"
	"database/sql"
	"time"
)

// ClientMutationRepo tracks idempotent client mutation IDs.
type ClientMutationRepo struct {
	writer *sql.DB
}

// NewClientMutationRepo creates a client mutation repository.
func NewClientMutationRepo(db *DB) *ClientMutationRepo {
	return &ClientMutationRepo{writer: db.Writer}
}

// TryRecord returns true if the mutation ID was newly recorded.
func (r *ClientMutationRepo) TryRecord(ctx context.Context, userID, mutationID string) (bool, error) {
	if mutationID == "" {
		return true, nil
	}
	res, err := r.writer.ExecContext(ctx, `
		INSERT OR IGNORE INTO client_mutations (client_mutation_id, user_id, created_at)
		VALUES (?, ?, ?)`, mutationID, userID, time.Now())
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// Exists reports whether a mutation ID was already recorded.
func (r *ClientMutationRepo) Exists(ctx context.Context, userID, mutationID string) (bool, error) {
	if mutationID == "" {
		return false, nil
	}
	var count int
	err := r.writer.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM client_mutations WHERE client_mutation_id = ? AND user_id = ?`,
		mutationID, userID,
	).Scan(&count)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return count > 0, err
}
