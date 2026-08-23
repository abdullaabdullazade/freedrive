package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
)

// CryptoRepo implements repository.CryptoRepository.
type CryptoRepo struct {
	writer *sql.DB
	reader *sql.DB
}

func NewCryptoRepo(db *DB) *CryptoRepo {
	return &CryptoRepo{writer: db.Writer, reader: db.Reader}
}

func (r *CryptoRepo) GetUserCrypto(ctx context.Context, userID string) (*domain.UserCrypto, error) {
	row := r.reader.QueryRowContext(ctx,
		`SELECT user_id, key_salt, wrapped_uek, wrapped_uek_recovery, version, updated_at
		 FROM user_crypto WHERE user_id = ?`, userID,
	)
	var c domain.UserCrypto
	var recovery sql.NullString
	err := row.Scan(&c.UserID, &c.KeySalt, &c.WrappedUEK, &recovery, &c.Version, &c.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get user crypto: %w", err)
	}
	if recovery.Valid {
		c.WrappedUEKRecovery = recovery.String
	}
	return &c, nil
}

func (r *CryptoRepo) CreateUserCrypto(ctx context.Context, crypto *domain.UserCrypto) error {
	if crypto.UpdatedAt.IsZero() {
		crypto.UpdatedAt = time.Now()
	}
	if crypto.Version == 0 {
		crypto.Version = 1
	}
	var recovery interface{}
	if crypto.WrappedUEKRecovery != "" {
		recovery = crypto.WrappedUEKRecovery
	}
	_, err := r.writer.ExecContext(ctx,
		`INSERT INTO user_crypto (user_id, key_salt, wrapped_uek, wrapped_uek_recovery, version, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		crypto.UserID, crypto.KeySalt, crypto.WrappedUEK, recovery, crypto.Version, crypto.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("create user crypto: %w", err)
	}
	return nil
}

func (r *CryptoRepo) UpdateUserCrypto(ctx context.Context, crypto *domain.UserCrypto) error {
	crypto.UpdatedAt = time.Now()
	var recovery interface{}
	if crypto.WrappedUEKRecovery != "" {
		recovery = crypto.WrappedUEKRecovery
	}
	res, err := r.writer.ExecContext(ctx,
		`UPDATE user_crypto SET key_salt = ?, wrapped_uek = ?, wrapped_uek_recovery = ?, version = ?, updated_at = ?
		 WHERE user_id = ?`,
		crypto.KeySalt, crypto.WrappedUEK, recovery, crypto.Version, crypto.UpdatedAt, crypto.UserID,
	)
	if err != nil {
		return fmt.Errorf("update user crypto: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("user crypto not found")
	}
	return nil
}

func (r *CryptoRepo) GetFileEncryptionKey(ctx context.Context, fileID string) (*domain.FileEncryptionKey, error) {
	row := r.reader.QueryRowContext(ctx,
		`SELECT file_id, owner_id, wrapped_file_key, updated_at
		 FROM file_encryption_keys WHERE file_id = ?`, fileID,
	)
	var k domain.FileEncryptionKey
	err := row.Scan(&k.FileID, &k.OwnerID, &k.WrappedFileKey, &k.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get file encryption key: %w", err)
	}
	return &k, nil
}

func (r *CryptoRepo) UpsertFileEncryptionKey(ctx context.Context, key *domain.FileEncryptionKey) error {
	if key.UpdatedAt.IsZero() {
		key.UpdatedAt = time.Now()
	}
	_, err := r.writer.ExecContext(ctx,
		`INSERT INTO file_encryption_keys (file_id, owner_id, wrapped_file_key, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(file_id) DO UPDATE SET
		   wrapped_file_key = excluded.wrapped_file_key,
		   updated_at = excluded.updated_at`,
		key.FileID, key.OwnerID, key.WrappedFileKey, key.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("upsert file encryption key: %w", err)
	}
	return nil
}

func (r *CryptoRepo) ListFileEncryptionKeysSince(ctx context.Context, ownerID string, since time.Time, limit int) ([]domain.EncryptionKeyEntry, error) {
	if limit <= 0 || limit > 5000 {
		limit = 5000
	}
	rows, err := r.reader.QueryContext(ctx,
		`SELECT file_id, wrapped_file_key, updated_at
		 FROM file_encryption_keys
		 WHERE owner_id = ? AND updated_at > ?
		 ORDER BY updated_at ASC
		 LIMIT ?`,
		ownerID, since, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list file encryption keys: %w", err)
	}
	defer rows.Close()

	var out []domain.EncryptionKeyEntry
	for rows.Next() {
		var e domain.EncryptionKeyEntry
		if err := rows.Scan(&e.FileID, &e.WrappedFileKey, &e.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
