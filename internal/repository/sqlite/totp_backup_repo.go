package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// TotpBackupRepo implements repository.TotpBackupRepository.
type TotpBackupRepo struct {
	writer *sql.DB
	reader *sql.DB
}

func NewTotpBackupRepo(db *DB) *TotpBackupRepo {
	return &TotpBackupRepo{writer: db.Writer, reader: db.Reader}
}

func (r *TotpBackupRepo) ReplaceAll(ctx context.Context, userID string, codeHashes []string) error {
	tx, err := r.writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, "DELETE FROM totp_backup_codes WHERE user_id = ?", userID); err != nil {
		return fmt.Errorf("clear totp backup codes: %w", err)
	}
	now := time.Now()
	for _, hash := range codeHashes {
		id := uuid.New().String()
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO totp_backup_codes (id, user_id, code_hash, used_at, created_at)
			 VALUES (?, ?, ?, NULL, ?)`,
			id, userID, hash, now,
		); err != nil {
			return fmt.Errorf("insert totp backup code: %w", err)
		}
	}
	return tx.Commit()
}

func (r *TotpBackupRepo) ConsumeUnused(ctx context.Context, userID, codeHash string) (bool, error) {
	tx, err := r.writer.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()

	var id string
	err = tx.QueryRowContext(ctx,
		`SELECT id FROM totp_backup_codes
		 WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
		 LIMIT 1`,
		userID, codeHash,
	).Scan(&id)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	res, err := tx.ExecContext(ctx,
		`UPDATE totp_backup_codes SET used_at = ? WHERE id = ? AND used_at IS NULL`,
		time.Now(), id,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return false, nil
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (r *TotpBackupRepo) DeleteByUserID(ctx context.Context, userID string) error {
	_, err := r.writer.ExecContext(ctx, "DELETE FROM totp_backup_codes WHERE user_id = ?", userID)
	return err
}
