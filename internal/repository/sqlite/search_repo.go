package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
)

// SearchRepo runs advanced search queries across files and folders.
type SearchRepo struct {
	reader *sql.DB
}

// NewSearchRepo creates a search repository.
func NewSearchRepo(db *DB) *SearchRepo {
	return &SearchRepo{reader: db.Reader}
}

// Search executes advanced search for the authenticated user.
func (r *SearchRepo) Search(ctx context.Context, userID string, opts domain.SearchOptions) (*domain.SearchResult, error) {
	page := opts.Page
	if page < 1 {
		page = 1
	}
	pageSize := opts.PageSize
	if pageSize < 1 || pageSize > 200 {
		pageSize = 50
	}

	includeFiles := opts.Type == "" || opts.Type != "Folders"
	includeFolders := opts.Type == "" || opts.Type == "Folders"

	var files []domain.File
	var folders []domain.Folder
	fileTotal := 0
	folderTotal := 0

	if includeFiles {
		var err error
		files, fileTotal, err = r.searchFiles(ctx, userID, opts, page, pageSize)
		if err != nil {
			return nil, err
		}
	}
	if includeFolders {
		var err error
		folders, folderTotal, err = r.searchFolders(ctx, userID, opts, page, pageSize)
		if err != nil {
			return nil, err
		}
	}

	total := fileTotal + folderTotal
	return &domain.SearchResult{
		Files:   files,
		Folders: folders,
		Total:   total,
		Page:    page,
	}, nil
}

func (r *SearchRepo) searchFiles(ctx context.Context, userID string, opts domain.SearchOptions, page, pageSize int) ([]domain.File, int, error) {
	conditions, args := r.buildFileConditions(userID, opts)
	where := strings.Join(conditions, " AND ")

	countQuery := fmt.Sprintf("SELECT COUNT(DISTINCT f.id) FROM files f WHERE %s", where)
	var total int
	if err := r.reader.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	offset := (page - 1) * pageSize
	query := fmt.Sprintf(`
		SELECT DISTINCT f.id, f.name, f.mime_type, f.size, f.encrypted_size, f.folder_id, f.owner_id,
		       f.blob_path, f.iv, f.version, f.is_starred, f.is_trashed, f.trashed_at,
		       f.created_at, f.updated_at, f.accessed_at
		FROM files f
		WHERE %s
		ORDER BY f.updated_at DESC
		LIMIT ? OFFSET ?`, where)

	args = append(args, pageSize, offset)
	rows, err := r.reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	return scanFiles(rows), total, nil
}

func (r *SearchRepo) searchFolders(ctx context.Context, userID string, opts domain.SearchOptions, page, pageSize int) ([]domain.Folder, int, error) {
	if opts.Location == "Shared with me" || opts.ApprovalAwaiting || opts.ApprovalRequested || opts.FollowUps == "Comments assigned to me only" {
		return nil, 0, nil
	}
	if opts.SharedTo != "" {
		return nil, 0, nil
	}
	if opts.Words != "" {
		return nil, 0, nil
	}

	conditions, args := r.buildFolderConditions(userID, opts)
	where := strings.Join(conditions, " AND ")

	countQuery := fmt.Sprintf("SELECT COUNT(*) FROM folders fo WHERE %s", where)
	var total int
	if err := r.reader.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	offset := (page - 1) * pageSize
	query := fmt.Sprintf(`
		SELECT fo.id, fo.name, fo.parent_id, fo.owner_id, fo.color, fo.is_starred, fo.is_trashed, fo.trashed_at, fo.created_at, fo.updated_at
		FROM folders fo
		WHERE %s
		ORDER BY fo.updated_at DESC
		LIMIT ? OFFSET ?`, where)

	args = append(args, pageSize, offset)
	rows, err := r.reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var folders []domain.Folder
	for rows.Next() {
		var f domain.Folder
		if err := rows.Scan(&f.ID, &f.Name, &f.ParentID, &f.OwnerID, &f.Color, &f.IsStarred, &f.IsTrashed, &f.TrashedAt, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, 0, err
		}
		folders = append(folders, f)
	}
	return folders, total, nil
}

func (r *SearchRepo) buildFileConditions(userID string, opts domain.SearchOptions) ([]string, []interface{}) {
	var conditions []string
	var args []interface{}

	scope := r.fileScopeSQL(userID, opts)
	conditions = append(conditions, scope.condition)
	args = append(args, scope.args...)

	if opts.InTrash {
		conditions = append(conditions, "f.is_trashed = 1")
	} else if opts.Location != "Anywhere" || !opts.InTrash {
		if !opts.InTrash {
			conditions = append(conditions, "f.is_trashed = 0")
		}
	}

	if opts.Starred {
		conditions = append(conditions, "f.is_starred = 1")
	}
	if opts.Encrypted {
		conditions = append(conditions, "f.iv IS NOT NULL AND f.iv != ''")
	}

	if opts.Query != "" {
		conditions = append(conditions, "f.name LIKE ? COLLATE NOCASE")
		args = append(args, "%"+opts.Query+"%")
	}
	if opts.Name != "" {
		conditions = append(conditions, "f.name LIKE ? COLLATE NOCASE")
		args = append(args, "%"+opts.Name+"%")
	}

	if opts.Words != "" {
		conditions = append(conditions, `(
			f.name LIKE ? COLLATE NOCASE OR
			EXISTS (SELECT 1 FROM comments c WHERE c.file_id = f.id AND c.content LIKE ? COLLATE NOCASE)
		)`)
		pattern := "%" + opts.Words + "%"
		args = append(args, pattern, pattern)
	}

	if cond, typeArgs := mimeTypeCondition(opts.Type); cond != "" {
		conditions = append(conditions, cond)
		args = append(args, typeArgs...)
	}

	if opts.ModifiedAfter != nil {
		conditions = append(conditions, "f.updated_at >= ?")
		args = append(args, opts.ModifiedAfter.UTC().Format(time.RFC3339))
	}
	if opts.ModifiedBefore != nil {
		conditions = append(conditions, "f.updated_at <= ?")
		args = append(args, opts.ModifiedBefore.UTC().Format(time.RFC3339))
	}

	if opts.SharedTo != "" {
		conditions = append(conditions, `EXISTS (
			SELECT 1 FROM user_shares us
			JOIN users u ON u.id = us.shared_with
			WHERE us.file_id = f.id AND us.shared_by = ?
			  AND (u.email LIKE ? COLLATE NOCASE OR u.username LIKE ? COLLATE NOCASE)
		)`)
		pattern := "%" + opts.SharedTo + "%"
		args = append(args, userID, pattern, pattern)
	}

	if opts.ApprovalAwaiting {
		conditions = append(conditions, `EXISTS (
			SELECT 1 FROM file_approvals fa
			WHERE fa.file_id = f.id AND fa.approver_id = ? AND fa.status = 'pending'
		)`)
		args = append(args, userID)
	}
	if opts.ApprovalRequested {
		conditions = append(conditions, `EXISTS (
			SELECT 1 FROM file_approvals fa
			WHERE fa.file_id = f.id AND fa.requested_by = ? AND fa.status = 'pending'
		)`)
		args = append(args, userID)
	}

	switch opts.FollowUps {
	case "Suggestions only":
		conditions = append(conditions, `EXISTS (
			SELECT 1 FROM comments c WHERE c.file_id = f.id AND c.user_id = ?
		)`)
		args = append(args, userID)
	case "Comments assigned to me only":
		conditions = append(conditions, `EXISTS (
			SELECT 1 FROM comments c WHERE c.file_id = f.id AND c.assigned_to = ?
		)`)
		args = append(args, userID)
	}

	if opts.Location == "Computers" {
		conditions = append(conditions, computerFileSQL())
		args = append(args, userID)
	}

	return conditions, args
}

func (r *SearchRepo) buildFolderConditions(userID string, opts domain.SearchOptions) ([]string, []interface{}) {
	var conditions []string
	var args []interface{}

	conditions = append(conditions, "fo.owner_id = ?")
	args = append(args, userID)

	if opts.InTrash {
		conditions = append(conditions, "fo.is_trashed = 1")
	} else {
		conditions = append(conditions, "fo.is_trashed = 0")
	}

	if opts.Starred {
		conditions = append(conditions, "fo.is_starred = 1")
	}

	nameQuery := opts.Name
	if nameQuery == "" {
		nameQuery = opts.Query
	}
	if nameQuery != "" {
		conditions = append(conditions, "fo.name LIKE ? COLLATE NOCASE")
		args = append(args, "%"+nameQuery+"%")
	}

	if opts.ModifiedAfter != nil {
		conditions = append(conditions, "fo.updated_at >= ?")
		args = append(args, opts.ModifiedAfter.UTC().Format(time.RFC3339))
	}
	if opts.ModifiedBefore != nil {
		conditions = append(conditions, "fo.updated_at <= ?")
		args = append(args, opts.ModifiedBefore.UTC().Format(time.RFC3339))
	}

	switch opts.Owner {
	case "Me":
		// already owner scoped
	case "Not me":
		conditions = append(conditions, "1 = 0")
	case "Specific person":
		if opts.OwnerEmail != "" {
			conditions = append(conditions, `EXISTS (
				SELECT 1 FROM users u WHERE u.id = fo.owner_id AND (u.email LIKE ? COLLATE NOCASE OR u.username LIKE ? COLLATE NOCASE)
			)`)
			pattern := "%" + opts.OwnerEmail + "%"
			args = append(args, pattern, pattern)
		}
	}

	if opts.Location == "My Drive" {
		conditions = append(conditions, "fo.id NOT IN (SELECT root_folder_id FROM computers WHERE owner_id = ?)")
		args = append(args, userID)
	}
	if opts.Location == "Computers" {
		conditions = append(conditions, `fo.id IN (
			WITH RECURSIVE subtree AS (
				SELECT id FROM folders WHERE id IN (SELECT root_folder_id FROM computers WHERE owner_id = ?)
				UNION ALL
				SELECT f.id FROM folders f INNER JOIN subtree s ON f.parent_id = s.id
			)
			SELECT id FROM subtree
		)`)
		args = append(args, userID)
	}

	return conditions, args
}

type scopeSQL struct {
	condition string
	args      []interface{}
}

func (r *SearchRepo) fileScopeSQL(userID string, opts domain.SearchOptions) scopeSQL {
	switch opts.Owner {
	case "Me":
		return scopeSQL{"f.owner_id = ?", []interface{}{userID}}
	case "Not me":
		return scopeSQL{`EXISTS (
			SELECT 1 FROM user_shares s WHERE s.file_id = f.id AND s.shared_with = ?
		)`, []interface{}{userID}}
	case "Specific person":
		if opts.OwnerEmail != "" {
			pattern := "%" + opts.OwnerEmail + "%"
			return scopeSQL{`EXISTS (
				SELECT 1 FROM users u WHERE u.id = f.owner_id AND (u.email LIKE ? COLLATE NOCASE OR u.username LIKE ? COLLATE NOCASE)
			)`, []interface{}{pattern, pattern}}
		}
		return scopeSQL{"f.owner_id = ?", []interface{}{userID}}
	default:
		switch opts.Location {
		case "Shared with me":
			return scopeSQL{`EXISTS (
				SELECT 1 FROM user_shares s WHERE s.file_id = f.id AND s.shared_with = ?
			)`, []interface{}{userID}}
		case "My Drive":
			return scopeSQL{"f.owner_id = ?", []interface{}{userID}}
		case "Computers":
			return scopeSQL{"f.owner_id = ?", []interface{}{userID}}
		default:
			return scopeSQL{`(
				f.owner_id = ? OR EXISTS (
					SELECT 1 FROM user_shares s WHERE s.file_id = f.id AND s.shared_with = ?
				)
			)`, []interface{}{userID, userID}}
		}
	}
}

func computerFileSQL() string {
	return `f.folder_id IN (
		WITH RECURSIVE subtree AS (
			SELECT id FROM folders WHERE id IN (SELECT root_folder_id FROM computers WHERE owner_id = ?)
			UNION ALL
			SELECT fo.id FROM folders fo INNER JOIN subtree s ON fo.parent_id = s.id
		)
		SELECT id FROM subtree
	)`
}

func mimeTypeCondition(fileType string) (string, []interface{}) {
	switch fileType {
	case "Photos":
		return "f.mime_type LIKE 'image/%'", nil
	case "PDFs":
		return "f.mime_type = 'application/pdf'", nil
	case "Documents":
		return `(
			f.mime_type LIKE 'application/msword%' OR f.mime_type LIKE 'application/vnd.openxmlformats-officedocument.wordprocessingml%' OR
			f.mime_type LIKE 'text/%' OR f.mime_type = 'application/rtf'
		)`, nil
	case "Spreadsheets":
		return `(
			f.mime_type LIKE 'application/vnd.ms-excel%' OR f.mime_type LIKE 'application/vnd.openxmlformats-officedocument.spreadsheetml%'
		)`, nil
	case "Presentations":
		return `(
			f.mime_type LIKE 'application/vnd.ms-powerpoint%' OR f.mime_type LIKE 'application/vnd.openxmlformats-officedocument.presentationml%'
		)`, nil
	case "Forms":
		return "f.mime_type LIKE '%form%'", nil
	case "Audio":
		return "f.mime_type LIKE 'audio/%'", nil
	case "Videos":
		return "f.mime_type LIKE 'video/%'", nil
	case "Archives":
		return `(
			f.mime_type LIKE 'application/zip%' OR f.mime_type LIKE 'application/x-zip%' OR
			f.mime_type LIKE 'application/x-rar%' OR f.mime_type LIKE 'application/gzip%' OR
			f.name LIKE '%.zip' OR f.name LIKE '%.rar' OR f.name LIKE '%.7z'
		)`, nil
	case "Folders":
		return "1 = 0", nil
	default:
		return "", nil
	}
}

func scanFiles(rows *sql.Rows) []domain.File {
	var files []domain.File
	for rows.Next() {
		var f domain.File
		if err := rows.Scan(&f.ID, &f.Name, &f.MimeType, &f.Size, &f.EncryptedSize,
			&f.FolderID, &f.OwnerID, &f.BlobPath, &f.IV, &f.Version,
			&f.IsStarred, &f.IsTrashed, &f.TrashedAt, &f.CreatedAt, &f.UpdatedAt, &f.AccessedAt); err != nil {
			continue
		}
		files = append(files, f)
	}
	return files
}

// ParseModifiedRange converts a preset label into a date range.
func ParseModifiedRange(label string, from, to string, now time.Time) (*time.Time, *time.Time) {
	loc := now.Location()
	startOfDay := func(t time.Time) time.Time {
		y, m, d := t.Date()
		return time.Date(y, m, d, 0, 0, 0, 0, loc)
	}
	endOfDay := func(t time.Time) time.Time {
		y, m, d := t.Date()
		return time.Date(y, m, d, 23, 59, 59, 999999999, loc)
	}

	switch label {
	case "Today":
		s := startOfDay(now)
		e := endOfDay(now)
		return &s, &e
	case "Yesterday":
		y := now.AddDate(0, 0, -1)
		s := startOfDay(y)
		e := endOfDay(y)
		return &s, &e
	case "Last 7 days":
		s := startOfDay(now.AddDate(0, 0, -7))
		e := endOfDay(now)
		return &s, &e
	case "Last 30 days":
		s := startOfDay(now.AddDate(0, 0, -30))
		e := endOfDay(now)
		return &s, &e
	case "Last 90 days":
		s := startOfDay(now.AddDate(0, 0, -90))
		e := endOfDay(now)
		return &s, &e
	case "Custom":
		var after, before *time.Time
		if from != "" {
			if t, err := time.ParseInLocation("2006-01-02", from, loc); err == nil {
				s := startOfDay(t)
				after = &s
			}
		}
		if to != "" {
			if t, err := time.ParseInLocation("2006-01-02", to, loc); err == nil {
				e := endOfDay(t)
				before = &e
			}
		}
		return after, before
	default:
		return nil, nil
	}
}
