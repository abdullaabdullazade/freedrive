package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
)

// CommentRepo implements repository.CommentRepository.
type CommentRepo struct {
	writer *sql.DB
	reader *sql.DB
}

func NewCommentRepo(db *DB) *CommentRepo {
	return &CommentRepo{writer: db.Writer, reader: db.Reader}
}

func (r *CommentRepo) Create(ctx context.Context, comment *domain.Comment) error {
	if comment.ID == "" {
		comment.ID = uuid.New().String()
	}
	now := time.Now()
	comment.CreatedAt = now
	comment.UpdatedAt = now

	_, err := r.writer.ExecContext(ctx,
		`INSERT INTO comments (id, file_id, user_id, content, parent_id, assigned_to, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		comment.ID, comment.FileID, comment.UserID, comment.Content, comment.ParentID, comment.AssignedTo, comment.CreatedAt, comment.UpdatedAt)
	return err
}

func (r *CommentRepo) GetByFileID(ctx context.Context, fileID string) ([]domain.Comment, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT c.id, c.file_id, c.user_id, u.username, c.content, c.parent_id, c.assigned_to, au.username, c.created_at, c.updated_at
		 FROM comments c
		 JOIN users u ON c.user_id = u.id
		 LEFT JOIN users au ON c.assigned_to = au.id
		 WHERE c.file_id = ? ORDER BY c.created_at ASC`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var comments []domain.Comment
	for rows.Next() {
		var c domain.Comment
		var assignedTo, assignedToUsername sql.NullString
		if err := rows.Scan(&c.ID, &c.FileID, &c.UserID, &c.Username, &c.Content, &c.ParentID, &assignedTo, &assignedToUsername, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		if assignedTo.Valid {
			v := assignedTo.String
			c.AssignedTo = &v
		}
		if assignedToUsername.Valid {
			c.AssignedToUsername = assignedToUsername.String
		}
		comments = append(comments, c)
	}
	return comments, nil
}

func (r *CommentRepo) Delete(ctx context.Context, id string) error {
	_, err := r.writer.ExecContext(ctx, "DELETE FROM comments WHERE id = ?", id)
	return err
}

// ActivityRepo implements repository.ActivityRepository.
type ActivityRepo struct {
	writer *sql.DB
	reader *sql.DB
}

func NewActivityRepo(db *DB) *ActivityRepo {
	return &ActivityRepo{writer: db.Writer, reader: db.Reader}
}

func (r *ActivityRepo) Create(ctx context.Context, log *domain.ActivityLog) error {
	if log.ID == "" {
		log.ID = uuid.New().String()
	}
	log.CreatedAt = time.Now()

	_, err := r.writer.ExecContext(ctx,
		`INSERT INTO activity_log (id, user_id, action, target_type, target_id, target_name, metadata, ip_address, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		log.ID, log.UserID, log.Action, log.TargetType, log.TargetID,
		log.TargetName, log.Metadata, log.IPAddress, log.CreatedAt)
	return err
}

func (r *ActivityRepo) List(ctx context.Context, userID string, page, pageSize int) ([]domain.ActivityLog, int, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}

	var total int
	if err := r.reader.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM activity_log WHERE user_id = ?", userID).Scan(&total); err != nil {
		return nil, 0, err
	}

	rows, err := r.reader.QueryContext(ctx,
		`SELECT a.id, a.user_id, u.username, a.action, a.target_type, a.target_id, a.target_name, a.metadata, a.ip_address, a.created_at
		 FROM activity_log a LEFT JOIN users u ON a.user_id = u.id
		 WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
		userID, pageSize, (page-1)*pageSize)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	logs, err := scanActivityRows(rows)
	if err != nil {
		return nil, 0, err
	}
	return logs, total, nil
}

func (r *ActivityRepo) ListAll(ctx context.Context, page, pageSize int) ([]domain.ActivityLog, int, error) {
	return r.listAllFiltered(ctx, page, pageSize, "")
}

// ListAllAuth returns login / failed_login events for the admin activity log.
func (r *ActivityRepo) ListAllAuth(ctx context.Context, page, pageSize int) ([]domain.ActivityLog, int, error) {
	return r.listAllFiltered(ctx, page, pageSize,
		"a.action IN ('login', 'failed_login')")
}

func (r *ActivityRepo) listAllFiltered(ctx context.Context, page, pageSize int, whereClause string) ([]domain.ActivityLog, int, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}

	countSQL := "SELECT COUNT(*) FROM activity_log"
	listSQL := `SELECT a.id, a.user_id, u.username, a.action, a.target_type, a.target_id, a.target_name, a.metadata, a.ip_address, a.created_at
		 FROM activity_log a LEFT JOIN users u ON a.user_id = u.id`
	if whereClause != "" {
		countSQL += " WHERE action IN ('login', 'failed_login')"
		listSQL += " WHERE " + whereClause
	}
	listSQL += " ORDER BY a.created_at DESC LIMIT ? OFFSET ?"

	var total int
	if err := r.reader.QueryRowContext(ctx, countSQL).Scan(&total); err != nil {
		return nil, 0, err
	}

	rows, err := r.reader.QueryContext(ctx, listSQL, pageSize, (page-1)*pageSize)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	logs, err := scanActivityRows(rows)
	if err != nil {
		return nil, 0, err
	}
	return logs, total, nil
}

func (r *ActivityRepo) DeleteAll(ctx context.Context) error {
	_, err := r.writer.ExecContext(ctx, "DELETE FROM activity_log")
	return err
}

// scanActivityRows reads activity rows null-safely so that orphaned rows (user
// deleted) or unusual date formats can never abort the query.
func scanActivityRows(rows *sql.Rows) ([]domain.ActivityLog, error) {
	var logs []domain.ActivityLog
	for rows.Next() {
		var l domain.ActivityLog
		var id, userID, username, action, targetType, targetID, targetName, metadata, ipAddress sql.NullString
		var createdAt sql.NullTime
		if err := rows.Scan(&id, &userID, &username, &action, &targetType, &targetID,
			&targetName, &metadata, &ipAddress, &createdAt); err != nil {
			return nil, err
		}
		l.ID = id.String
		l.UserID = userID.String
		l.Username = username.String
		l.Action = domain.ActivityAction(action.String)
		l.TargetType = targetType.String
		l.TargetID = targetID.String
		l.TargetName = targetName.String
		l.Metadata = metadata.String
		l.IPAddress = ipAddress.String
		l.CreatedAt = createdAt.Time
		logs = append(logs, l)
	}
	return logs, rows.Err()
}
