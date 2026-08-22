package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
)

// ComputerRepo implements repository.ComputerRepository with SQLite.
type ComputerRepo struct {
	writer *sql.DB
	reader *sql.DB
}

// NewComputerRepo creates a new computer repository.
func NewComputerRepo(db *DB) *ComputerRepo {
	return &ComputerRepo{writer: db.Writer, reader: db.Reader}
}

func (r *ComputerRepo) Create(ctx context.Context, computer *domain.Computer) error {
	if computer.ID == "" {
		computer.ID = uuid.New().String()
	}
	now := time.Now()
	computer.CreatedAt = now
	computer.UpdatedAt = now

	_, err := r.writer.ExecContext(ctx,
		`INSERT INTO computers (id, owner_id, name, hostname, root_folder_id, last_seen_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		computer.ID, computer.OwnerID, computer.Name, computer.Hostname,
		computer.RootFolderID, computer.LastSeenAt, computer.CreatedAt, computer.UpdatedAt,
	)
	return err
}

func (r *ComputerRepo) GetByID(ctx context.Context, id string) (*domain.Computer, error) {
	c := &domain.Computer{}
	var lastSeen sql.NullTime
	err := r.reader.QueryRowContext(ctx,
		`SELECT id, owner_id, name, hostname, root_folder_id, last_seen_at, created_at, updated_at
		 FROM computers WHERE id = ?`, id,
	).Scan(&c.ID, &c.OwnerID, &c.Name, &c.Hostname, &c.RootFolderID,
		&lastSeen, &c.CreatedAt, &c.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if lastSeen.Valid {
		c.LastSeenAt = &lastSeen.Time
	}
	return c, nil
}

func (r *ComputerRepo) GetByOwnerAndHostname(ctx context.Context, ownerID, hostname string) (*domain.Computer, error) {
	if hostname == "" {
		return nil, nil
	}
	c := &domain.Computer{}
	var lastSeen sql.NullTime
	err := r.reader.QueryRowContext(ctx,
		`SELECT c.id, c.owner_id, c.name, c.hostname, c.root_folder_id, c.last_seen_at, c.created_at, c.updated_at
		 FROM computers c
		 INNER JOIN folders f ON f.id = c.root_folder_id
		 WHERE c.owner_id = ? AND c.hostname = ? AND f.is_trashed = 0
		 ORDER BY CASE WHEN c.last_seen_at IS NULL THEN 1 ELSE 0 END, c.last_seen_at DESC, c.created_at DESC
		 LIMIT 1`, ownerID, hostname,
	).Scan(&c.ID, &c.OwnerID, &c.Name, &c.Hostname, &c.RootFolderID,
		&lastSeen, &c.CreatedAt, &c.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if lastSeen.Valid {
		c.LastSeenAt = &lastSeen.Time
	}
	return c, nil
}

func (r *ComputerRepo) ListByOwner(ctx context.Context, ownerID string) ([]domain.Computer, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT c.id, c.owner_id, c.name, c.hostname, c.root_folder_id, c.last_seen_at, c.created_at, c.updated_at
		 FROM computers c
		 INNER JOIN folders f ON f.id = c.root_folder_id
		 WHERE c.owner_id = ? AND f.is_trashed = 0
		 ORDER BY c.name`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var computers []domain.Computer
	for rows.Next() {
		var c domain.Computer
		var lastSeen sql.NullTime
		if err := rows.Scan(&c.ID, &c.OwnerID, &c.Name, &c.Hostname, &c.RootFolderID,
			&lastSeen, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		if lastSeen.Valid {
			c.LastSeenAt = &lastSeen.Time
		}
		computers = append(computers, c)
	}
	return computers, rows.Err()
}

func (r *ComputerRepo) IsComputerRoot(ctx context.Context, folderID string) (bool, error) {
	var count int
	err := r.reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM computers WHERE root_folder_id = ?`, folderID,
	).Scan(&count)
	return count > 0, err
}

func (r *ComputerRepo) GetComputerForFolder(ctx context.Context, folderID string) (*domain.Computer, error) {
	c := &domain.Computer{}
	var lastSeen sql.NullTime
	err := r.reader.QueryRowContext(ctx, `
		WITH RECURSIVE ancestors AS (
			SELECT id, parent_id FROM folders WHERE id = ?
			UNION ALL
			SELECT f.id, f.parent_id FROM folders f
			INNER JOIN ancestors a ON f.id = a.parent_id
		)
		SELECT c.id, c.owner_id, c.name, c.hostname, c.root_folder_id, c.last_seen_at, c.created_at, c.updated_at
		FROM computers c
		INNER JOIN ancestors a ON c.root_folder_id = a.id
		LIMIT 1`, folderID,
	).Scan(&c.ID, &c.OwnerID, &c.Name, &c.Hostname, &c.RootFolderID,
		&lastSeen, &c.CreatedAt, &c.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if lastSeen.Valid {
		c.LastSeenAt = &lastSeen.Time
	}
	return c, nil
}

func (r *ComputerRepo) IsInComputerTree(ctx context.Context, folderID string) (bool, error) {
	var count int
	err := r.reader.QueryRowContext(ctx, `
		WITH RECURSIVE ancestors AS (
			SELECT id, parent_id FROM folders WHERE id = ?
			UNION ALL
			SELECT f.id, f.parent_id FROM folders f
			INNER JOIN ancestors a ON f.id = a.parent_id
		)
		SELECT COUNT(*) FROM ancestors a
		INNER JOIN computers c ON c.root_folder_id = a.id
	`, folderID).Scan(&count)
	return count > 0, err
}

func (r *ComputerRepo) Delete(ctx context.Context, id string) error {
	_, err := r.writer.ExecContext(ctx, `DELETE FROM computers WHERE id = ?`, id)
	return err
}

func (r *ComputerRepo) UpdateLastSeen(ctx context.Context, id string, at time.Time) error {
	_, err := r.writer.ExecContext(ctx,
		`UPDATE computers SET last_seen_at = ?, updated_at = ? WHERE id = ?`,
		at, time.Now(), id,
	)
	return err
}
