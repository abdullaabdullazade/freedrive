package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/google/uuid"
)

// FileRepo implements repository.FileRepository with SQLite.
type FileRepo struct {
	writer *sql.DB
	reader *sql.DB
}

// NewFileRepo creates a new file repository.
func NewFileRepo(db *DB) *FileRepo {
	return &FileRepo{writer: db.Writer, reader: db.Reader}
}

func (r *FileRepo) Create(ctx context.Context, file *domain.File) error {
	if file.ID == "" {
		file.ID = uuid.New().String()
	}
	now := time.Now()
	file.CreatedAt = now
	file.UpdatedAt = now
	file.AccessedAt = now

	_, err := r.writer.ExecContext(ctx,
		`INSERT INTO files (id, name, mime_type, size, encrypted_size, folder_id, owner_id, blob_path, iv, version, is_starred, is_trashed, created_at, updated_at, accessed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		file.ID, file.Name, file.MimeType, file.Size, file.EncryptedSize,
		file.FolderID, file.OwnerID, file.BlobPath, file.IV, file.Version,
		file.IsStarred, file.IsTrashed, file.CreatedAt, file.UpdatedAt, file.AccessedAt,
	)
	return err
}

func (r *FileRepo) GetByID(ctx context.Context, id string) (*domain.File, error) {
	f := &domain.File{}
	err := r.reader.QueryRowContext(ctx,
		`SELECT id, name, mime_type, size, encrypted_size, folder_id, owner_id, blob_path, iv, version,
		        is_starred, is_trashed, trashed_at, created_at, updated_at, accessed_at
		 FROM files WHERE id = ?`, id,
	).Scan(&f.ID, &f.Name, &f.MimeType, &f.Size, &f.EncryptedSize,
		&f.FolderID, &f.OwnerID, &f.BlobPath, &f.IV, &f.Version,
		&f.IsStarred, &f.IsTrashed, &f.TrashedAt, &f.CreatedAt, &f.UpdatedAt, &f.AccessedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return f, err
}

func (r *FileRepo) Update(ctx context.Context, file *domain.File) error {
	file.UpdatedAt = time.Now()
	_, err := r.writer.ExecContext(ctx,
		`UPDATE files SET name=?, mime_type=?, size=?, encrypted_size=?, folder_id=?, blob_path=?, iv=?,
		        version=?, is_starred=?, is_trashed=?, trashed_at=?, updated_at=?, accessed_at=?
		 WHERE id=?`,
		file.Name, file.MimeType, file.Size, file.EncryptedSize, file.FolderID,
		file.BlobPath, file.IV, file.Version, file.IsStarred, file.IsTrashed,
		file.TrashedAt, file.UpdatedAt, file.AccessedAt, file.ID,
	)
	return err
}

func (r *FileRepo) Delete(ctx context.Context, id string) error {
	_, err := r.writer.ExecContext(ctx, "DELETE FROM files WHERE id = ?", id)
	return err
}

func (r *FileRepo) List(ctx context.Context, opts domain.FileListOptions) ([]domain.File, int, error) {
	var conditions []string
	var args []interface{}

	conditions = append(conditions, "owner_id = ?")
	args = append(args, opts.OwnerID)

	if opts.FolderID != nil {
		conditions = append(conditions, "folder_id = ?")
		args = append(args, *opts.FolderID)
	}

	conditions = append(conditions, "is_trashed = ?")
	args = append(args, opts.Trashed)

	if opts.Starred {
		conditions = append(conditions, "is_starred = 1")
	}

	if opts.MimeType != "" {
		conditions = append(conditions, "mime_type LIKE ?")
		args = append(args, opts.MimeType+"%")
	}

	if opts.Search != "" {
		conditions = append(conditions, "name LIKE ?")
		args = append(args, "%"+opts.Search+"%")
	}

	where := strings.Join(conditions, " AND ")

	// Count total
	var total int
	countQuery := fmt.Sprintf("SELECT COUNT(*) FROM files WHERE %s", where)
	if err := r.reader.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	// Sort
	sortBy := "created_at"
	if opts.SortBy != "" {
		allowed := map[string]bool{"name": true, "size": true, "created_at": true, "updated_at": true, "accessed_at": true}
		if allowed[opts.SortBy] {
			sortBy = opts.SortBy
		}
	}
	sortDir := "DESC"
	if opts.SortDir == "asc" {
		sortDir = "ASC"
	}

	// Pagination
	page := opts.Page
	if page < 1 {
		page = 1
	}
	pageSize := opts.PageSize
	if pageSize < 1 || pageSize > 100 {
		pageSize = 50
	}
	offset := (page - 1) * pageSize

	query := fmt.Sprintf(
		`SELECT id, name, mime_type, size, encrypted_size, folder_id, owner_id, blob_path, iv, version,
		        is_starred, is_trashed, trashed_at, created_at, updated_at, accessed_at
		 FROM files WHERE %s ORDER BY %s %s LIMIT ? OFFSET ?`,
		where, sortBy, sortDir,
	)
	args = append(args, pageSize, offset)

	rows, err := r.reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var files []domain.File
	for rows.Next() {
		var f domain.File
		if err := rows.Scan(&f.ID, &f.Name, &f.MimeType, &f.Size, &f.EncryptedSize,
			&f.FolderID, &f.OwnerID, &f.BlobPath, &f.IV, &f.Version,
			&f.IsStarred, &f.IsTrashed, &f.TrashedAt, &f.CreatedAt, &f.UpdatedAt, &f.AccessedAt); err != nil {
			return nil, 0, err
		}
		files = append(files, f)
	}
	return files, total, nil
}

func (r *FileRepo) GetByFolderID(ctx context.Context, folderID *string, ownerID string) ([]domain.File, error) {
	files, _, err := r.GetByFolderIDPage(ctx, folderID, ownerID, 0, 0)
	return files, err
}

// GetByFolderIDPage returns non-trashed files in a folder ordered by name.
// limit <= 0 means return all remaining rows from offset.
func (r *FileRepo) GetByFolderIDPage(ctx context.Context, folderID *string, ownerID string, limit, offset int) ([]domain.File, int, error) {
	if offset < 0 {
		offset = 0
	}

	var (
		countQuery string
		countArgs  []interface{}
		listQuery  string
		listArgs   []interface{}
	)

	if folderID == nil {
		countQuery = `SELECT COUNT(*) FROM files WHERE folder_id IS NULL AND owner_id = ? AND is_trashed = 0`
		countArgs = []interface{}{ownerID}
		listQuery = `SELECT id, name, mime_type, size, encrypted_size, folder_id, owner_id, blob_path, iv, version,
			        is_starred, is_trashed, trashed_at, created_at, updated_at, accessed_at
			 FROM files WHERE folder_id IS NULL AND owner_id = ? AND is_trashed = 0 ORDER BY name COLLATE NOCASE, id`
		listArgs = []interface{}{ownerID}
	} else {
		countQuery = `SELECT COUNT(*) FROM files WHERE folder_id = ? AND owner_id = ? AND is_trashed = 0`
		countArgs = []interface{}{*folderID, ownerID}
		listQuery = `SELECT id, name, mime_type, size, encrypted_size, folder_id, owner_id, blob_path, iv, version,
			        is_starred, is_trashed, trashed_at, created_at, updated_at, accessed_at
			 FROM files WHERE folder_id = ? AND owner_id = ? AND is_trashed = 0 ORDER BY name COLLATE NOCASE, id`
		listArgs = []interface{}{*folderID, ownerID}
	}

	var total int
	if err := r.reader.QueryRowContext(ctx, countQuery, countArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}

	if limit > 0 {
		listQuery += ` LIMIT ? OFFSET ?`
		listArgs = append(listArgs, limit, offset)
	} else if offset > 0 {
		listQuery += ` LIMIT -1 OFFSET ?`
		listArgs = append(listArgs, offset)
	}

	rows, err := r.reader.QueryContext(ctx, listQuery, listArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var files []domain.File
	for rows.Next() {
		var f domain.File
		if err := rows.Scan(&f.ID, &f.Name, &f.MimeType, &f.Size, &f.EncryptedSize,
			&f.FolderID, &f.OwnerID, &f.BlobPath, &f.IV, &f.Version,
			&f.IsStarred, &f.IsTrashed, &f.TrashedAt, &f.CreatedAt, &f.UpdatedAt, &f.AccessedAt); err != nil {
			return nil, 0, err
		}
		files = append(files, f)
	}
	if files == nil {
		files = []domain.File{}
	}
	return files, total, nil
}

func (r *FileRepo) MoveToTrash(ctx context.Context, id string) error {
	now := time.Now()
	_, err := r.writer.ExecContext(ctx,
		"UPDATE files SET is_trashed = 1, trashed_at = ?, updated_at = ? WHERE id = ?", now, now, id)
	return err
}

func (r *FileRepo) RestoreFromTrash(ctx context.Context, id string) error {
	now := time.Now()
	_, err := r.writer.ExecContext(ctx,
		"UPDATE files SET is_trashed = 0, trashed_at = NULL, updated_at = ? WHERE id = ?", now, id)
	return err
}

func (r *FileRepo) GetTrashedFiles(ctx context.Context, ownerID string) ([]domain.File, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT id, name, mime_type, size, encrypted_size, folder_id, owner_id, blob_path, iv, version,
		        is_starred, is_trashed, trashed_at, created_at, updated_at, accessed_at
		 FROM files
		 WHERE owner_id = ? AND is_trashed = 1
		   AND (folder_id IS NULL OR folder_id NOT IN (SELECT id FROM folders WHERE is_trashed = 1))
		 ORDER BY trashed_at DESC`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []domain.File
	for rows.Next() {
		var f domain.File
		if err := rows.Scan(&f.ID, &f.Name, &f.MimeType, &f.Size, &f.EncryptedSize,
			&f.FolderID, &f.OwnerID, &f.BlobPath, &f.IV, &f.Version,
			&f.IsStarred, &f.IsTrashed, &f.TrashedAt, &f.CreatedAt, &f.UpdatedAt, &f.AccessedAt); err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, nil
}

// GetByFolderIDs returns all files (regardless of trash state) that live in any
// of the given folders. Used to permanently delete a folder subtree.
func (r *FileRepo) GetByFolderIDs(ctx context.Context, folderIDs []string) ([]domain.File, error) {
	if len(folderIDs) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(folderIDs))
	args := make([]interface{}, len(folderIDs))
	for i, id := range folderIDs {
		placeholders[i] = "?"
		args[i] = id
	}
	query := `SELECT id, name, mime_type, size, encrypted_size, folder_id, owner_id, blob_path, iv, version,
	        is_starred, is_trashed, trashed_at, created_at, updated_at, accessed_at
	 FROM files WHERE folder_id IN (` + strings.Join(placeholders, ",") + `)`

	rows, err := r.reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []domain.File
	for rows.Next() {
		var f domain.File
		if err := rows.Scan(&f.ID, &f.Name, &f.MimeType, &f.Size, &f.EncryptedSize,
			&f.FolderID, &f.OwnerID, &f.BlobPath, &f.IV, &f.Version,
			&f.IsStarred, &f.IsTrashed, &f.TrashedAt, &f.CreatedAt, &f.UpdatedAt, &f.AccessedAt); err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, nil
}

func (r *FileRepo) GetSharedWithMe(ctx context.Context, userID string) ([]domain.File, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT f.id, f.name, f.mime_type, f.size, f.encrypted_size, f.folder_id, f.owner_id, f.blob_path, f.iv, f.version,
		        f.is_starred, f.is_trashed, f.trashed_at, f.created_at, f.updated_at, f.accessed_at
		 FROM files f
		 INNER JOIN user_shares s ON f.id = s.file_id
		 WHERE s.shared_with = ? AND f.is_trashed = 0 ORDER BY s.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []domain.File
	for rows.Next() {
		var f domain.File
		if err := rows.Scan(&f.ID, &f.Name, &f.MimeType, &f.Size, &f.EncryptedSize,
			&f.FolderID, &f.OwnerID, &f.BlobPath, &f.IV, &f.Version,
			&f.IsStarred, &f.IsTrashed, &f.TrashedAt, &f.CreatedAt, &f.UpdatedAt, &f.AccessedAt); err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, nil
}

func (r *FileRepo) GetSharedByMe(ctx context.Context, userID string) ([]domain.File, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT DISTINCT f.id, f.name, f.mime_type, f.size, f.encrypted_size, f.folder_id, f.owner_id, f.blob_path, f.iv, f.version,
		        f.is_starred, f.is_trashed, f.trashed_at, f.created_at, f.updated_at, f.accessed_at
		 FROM files f
		 INNER JOIN user_shares s ON f.id = s.file_id
		 WHERE s.shared_by = ? AND f.is_trashed = 0 ORDER BY f.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []domain.File
	for rows.Next() {
		var f domain.File
		if err := rows.Scan(&f.ID, &f.Name, &f.MimeType, &f.Size, &f.EncryptedSize,
			&f.FolderID, &f.OwnerID, &f.BlobPath, &f.IV, &f.Version,
			&f.IsStarred, &f.IsTrashed, &f.TrashedAt, &f.CreatedAt, &f.UpdatedAt, &f.AccessedAt); err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, nil
}

func (r *FileRepo) PurgeOldTrashed(ctx context.Context, days int) ([]domain.File, error) {
	cutoff := time.Now().AddDate(0, 0, -days)
	rows, err := r.reader.QueryContext(ctx,
		`SELECT id, blob_path, owner_id, encrypted_size FROM files WHERE is_trashed = 1 AND trashed_at < ?`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []domain.File
	for rows.Next() {
		var f domain.File
		if err := rows.Scan(&f.ID, &f.BlobPath, &f.OwnerID, &f.EncryptedSize); err != nil {
			return nil, err
		}
		files = append(files, f)
	}

	if len(files) > 0 {
		_, err = r.writer.ExecContext(ctx,
			"DELETE FROM files WHERE is_trashed = 1 AND trashed_at < ?", cutoff)
		if err != nil {
			return nil, err
		}
	}
	return files, nil
}

func (r *FileRepo) PurgeAllTrashed(ctx context.Context) ([]domain.File, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT id, blob_path, owner_id, encrypted_size FROM files WHERE is_trashed = 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []domain.File
	for rows.Next() {
		var f domain.File
		if err := rows.Scan(&f.ID, &f.BlobPath, &f.OwnerID, &f.EncryptedSize); err != nil {
			return nil, err
		}
		files = append(files, f)
	}

	if len(files) > 0 {
		_, err = r.writer.ExecContext(ctx, "DELETE FROM files WHERE is_trashed = 1")
		if err != nil {
			return nil, err
		}
	}
	return files, nil
}

func (r *FileRepo) PurgeAllTrashedForOwner(ctx context.Context, ownerID string) ([]domain.File, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT id, blob_path, owner_id, encrypted_size FROM files WHERE is_trashed = 1 AND owner_id = ?`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []domain.File
	for rows.Next() {
		var f domain.File
		if err := rows.Scan(&f.ID, &f.BlobPath, &f.OwnerID, &f.EncryptedSize); err != nil {
			return nil, err
		}
		files = append(files, f)
	}

	if len(files) > 0 {
		_, err = r.writer.ExecContext(ctx,
			"DELETE FROM files WHERE is_trashed = 1 AND owner_id = ?", ownerID)
		if err != nil {
			return nil, err
		}
	}
	return files, nil
}

func (r *FileRepo) ListDuplicateGroups(ctx context.Context) ([]domain.DuplicateGroup, error) {
	rows, err := r.reader.QueryContext(ctx, `
		SELECT owner_id, name, encrypted_size, COUNT(*) AS cnt
		FROM files
		WHERE is_trashed = 0
		GROUP BY owner_id, name, encrypted_size
		HAVING cnt > 1
		ORDER BY cnt DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var groups []domain.DuplicateGroup
	for rows.Next() {
		var g domain.DuplicateGroup
		if err := rows.Scan(&g.OwnerID, &g.Name, &g.EncryptedSize, &g.Count); err != nil {
			return nil, err
		}
		groups = append(groups, g)
	}
	return groups, rows.Err()
}

func (r *FileRepo) ListDuplicateFilesToRemove(ctx context.Context) ([]domain.File, error) {
	rows, err := r.reader.QueryContext(ctx, `
		SELECT id, name, encrypted_size, owner_id, blob_path FROM (
			SELECT id, name, encrypted_size, owner_id, blob_path,
			       ROW_NUMBER() OVER (PARTITION BY owner_id, name, encrypted_size ORDER BY updated_at DESC) AS rn
			FROM files
			WHERE is_trashed = 0
		) WHERE rn > 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []domain.File
	for rows.Next() {
		var f domain.File
		if err := rows.Scan(&f.ID, &f.Name, &f.EncryptedSize, &f.OwnerID, &f.BlobPath); err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, rows.Err()
}

func (r *FileRepo) ListAllBlobPaths(ctx context.Context) ([]string, error) {
	rows, err := r.reader.QueryContext(ctx, `
		SELECT blob_path FROM files
		UNION ALL
		SELECT blob_path FROM file_versions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var paths []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		if p != "" {
			paths = append(paths, p)
		}
	}
	return paths, rows.Err()
}

// ListBlobPathsByOwner returns blob paths for a user's files and their versions
// (call before deleting the user so disk blobs can be removed).
func (r *FileRepo) ListBlobPathsByOwner(ctx context.Context, ownerID string) ([]string, error) {
	rows, err := r.reader.QueryContext(ctx, `
		SELECT blob_path FROM files WHERE owner_id = ?
		UNION ALL
		SELECT fv.blob_path FROM file_versions fv
		INNER JOIN files f ON f.id = fv.file_id
		WHERE f.owner_id = ?`, ownerID, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var paths []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		if p != "" {
			paths = append(paths, p)
		}
	}
	return paths, rows.Err()
}

func (r *FileRepo) CountByOwner(ctx context.Context, ownerID string) (int, error) {
	var count int
	err := r.reader.QueryRowContext(ctx, "SELECT COUNT(*) FROM files WHERE owner_id = ?", ownerID).Scan(&count)
	return count, err
}

// SumEncryptedSizeByOwner returns the total encrypted bytes stored by a user
// across their non-trashed files (trashed files do not count toward usage).
func (r *FileRepo) SumEncryptedSizeByOwner(ctx context.Context, ownerID string) (int64, error) {
	var total int64
	err := r.reader.QueryRowContext(ctx,
		"SELECT COALESCE(SUM(encrypted_size), 0) FROM files WHERE owner_id = ? AND is_trashed = 0", ownerID).Scan(&total)
	return total, err
}

// SumAllEncryptedSize returns total encrypted bytes for all non-trashed files.
func (r *FileRepo) SumAllEncryptedSize(ctx context.Context) (int64, error) {
	var total int64
	err := r.reader.QueryRowContext(ctx,
		"SELECT COALESCE(SUM(encrypted_size), 0) FROM files WHERE is_trashed = 0").Scan(&total)
	return total, err
}

// ListFileMetaByOwner returns lightweight metadata for a user's non-trashed
// files, used to compute the storage breakdown. The set matches
// SumEncryptedSizeByOwner so the category totals add up to used_bytes.
func (r *FileRepo) ListFileMetaByOwner(ctx context.Context, ownerID string) ([]domain.FileMeta, error) {
	rows, err := r.reader.QueryContext(ctx,
		"SELECT mime_type, name, encrypted_size FROM files WHERE owner_id = ? AND is_trashed = 0", ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanFileMetaRows(rows)
}

// ListFileMetaAll returns lightweight metadata for all non-trashed files
// (admin storage breakdown across the whole instance).
func (r *FileRepo) ListFileMetaAll(ctx context.Context) ([]domain.FileMeta, error) {
	rows, err := r.reader.QueryContext(ctx,
		"SELECT mime_type, name, encrypted_size FROM files WHERE is_trashed = 0")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanFileMetaRows(rows)
}

func scanFileMetaRows(rows *sql.Rows) ([]domain.FileMeta, error) {
	var metas []domain.FileMeta
	for rows.Next() {
		var m domain.FileMeta
		if err := rows.Scan(&m.MimeType, &m.Name, &m.EncryptedSize); err != nil {
			return nil, err
		}
		metas = append(metas, m)
	}
	return metas, rows.Err()
}

// --- Versioning ---

func (r *FileRepo) CreateVersion(ctx context.Context, version *domain.FileVersion) error {
	if version.ID == "" {
		version.ID = uuid.New().String()
	}
	version.CreatedAt = time.Now()

	_, err := r.writer.ExecContext(ctx,
		`INSERT INTO file_versions (id, file_id, version, size, blob_path, iv, created_at, created_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		version.ID, version.FileID, version.Version, version.Size,
		version.BlobPath, version.IV, version.CreatedAt, version.CreatedBy,
	)
	return err
}

func (r *FileRepo) GetVersions(ctx context.Context, fileID string) ([]domain.FileVersion, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT id, file_id, version, size, blob_path, iv, created_at, created_by
		 FROM file_versions WHERE file_id = ? ORDER BY version DESC`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var versions []domain.FileVersion
	for rows.Next() {
		var v domain.FileVersion
		if err := rows.Scan(&v.ID, &v.FileID, &v.Version, &v.Size, &v.BlobPath, &v.IV, &v.CreatedAt, &v.CreatedBy); err != nil {
			return nil, err
		}
		versions = append(versions, v)
	}
	return versions, nil
}

func (r *FileRepo) GetVersion(ctx context.Context, fileID string, version int) (*domain.FileVersion, error) {
	v := &domain.FileVersion{}
	err := r.reader.QueryRowContext(ctx,
		`SELECT id, file_id, version, size, blob_path, iv, created_at, created_by
		 FROM file_versions WHERE file_id = ? AND version = ?`, fileID, version,
	).Scan(&v.ID, &v.FileID, &v.Version, &v.Size, &v.BlobPath, &v.IV, &v.CreatedAt, &v.CreatedBy)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return v, err
}

func (r *FileRepo) DeleteOldVersions(ctx context.Context, fileID string, keepCount int) ([]domain.FileVersion, error) {
	rows, err := r.reader.QueryContext(ctx,
		`SELECT id, blob_path FROM file_versions WHERE file_id = ?
		 ORDER BY version DESC LIMIT -1 OFFSET ?`, fileID, keepCount)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var old []domain.FileVersion
	for rows.Next() {
		var v domain.FileVersion
		if err := rows.Scan(&v.ID, &v.BlobPath); err != nil {
			return nil, err
		}
		old = append(old, v)
	}

	if len(old) > 0 {
		_, err = r.writer.ExecContext(ctx,
			fmt.Sprintf(`DELETE FROM file_versions WHERE file_id = ? AND id NOT IN (
				SELECT id FROM file_versions WHERE file_id = ? ORDER BY version DESC LIMIT %d
			)`, keepCount), fileID, fileID)
		if err != nil {
			return nil, err
		}
	}
	return old, nil
}
