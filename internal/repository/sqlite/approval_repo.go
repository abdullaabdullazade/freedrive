package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
)

// ApprovalRepo implements approval persistence.
type ApprovalRepo struct {
	writer *sql.DB
	reader *sql.DB
}

// NewApprovalRepo creates an approval repository.
func NewApprovalRepo(db *DB) *ApprovalRepo {
	return &ApprovalRepo{writer: db.Writer, reader: db.Reader}
}

func (r *ApprovalRepo) Create(ctx context.Context, approval *domain.FileApproval) error {
	if approval.ID == "" {
		approval.ID = uuid.New().String()
	}
	if approval.Status == "" {
		approval.Status = "pending"
	}
	approval.CreatedAt = time.Now()
	_, err := r.writer.ExecContext(ctx,
		`INSERT INTO file_approvals (id, file_id, requested_by, approver_id, status, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		approval.ID, approval.FileID, approval.RequestedBy, approval.ApproverID, approval.Status, approval.CreatedAt)
	return err
}

func (r *ApprovalRepo) GetByID(ctx context.Context, id string) (*domain.FileApproval, error) {
	row := r.reader.QueryRowContext(ctx,
		`SELECT id, file_id, requested_by, approver_id, status, created_at
		 FROM file_approvals WHERE id = ?`, id,
	)
	var a domain.FileApproval
	err := row.Scan(&a.ID, &a.FileID, &a.RequestedBy, &a.ApproverID, &a.Status, &a.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (r *ApprovalRepo) Update(ctx context.Context, approval *domain.FileApproval) error {
	_, err := r.writer.ExecContext(ctx,
		`UPDATE file_approvals SET status = ? WHERE id = ?`,
		approval.Status, approval.ID,
	)
	return err
}

func (r *ApprovalRepo) List(ctx context.Context, userID, status string) ([]domain.FileApproval, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT id, file_id, requested_by, approver_id, status, created_at
		 FROM file_approvals
		 WHERE (approver_id = ? OR requested_by = ?) AND (? = '' OR status = ?)
		 ORDER BY created_at DESC`,
		userID, userID, status, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []domain.FileApproval
	for rows.Next() {
		var a domain.FileApproval
		if err := rows.Scan(&a.ID, &a.FileID, &a.RequestedBy, &a.ApproverID, &a.Status, &a.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	return list, nil
}
