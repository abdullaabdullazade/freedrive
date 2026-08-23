package sqlite

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// DB wraps the SQLite database connections.
type DB struct {
	Writer *sql.DB
	Reader *sql.DB
	path   string
}

// New creates a new SQLite database connection with optimal settings.
func New(dataDir string) (*DB, error) {
	// Ensure data directory exists
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	dbPath := filepath.Join(dataDir, "freedrive.db")
	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=ON&_synchronous=NORMAL", dbPath)

	// Writer connection (single writer for SQLite)
	writer, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open writer db: %w", err)
	}
	writer.SetMaxOpenConns(1)

	// Reader connection pool
	reader, err := sql.Open("sqlite", dsn+"&mode=ro")
	if err != nil {
		writer.Close()
		return nil, fmt.Errorf("open reader db: %w", err)
	}
	reader.SetMaxOpenConns(10)

	db := &DB{
		Writer: writer,
		Reader: reader,
		path:   dbPath,
	}

	// Run pragmas
	pragmas := []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA busy_timeout = 5000",
		"PRAGMA foreign_keys = ON",
		"PRAGMA synchronous = NORMAL",
		"PRAGMA cache_size = -64000",
	}
	for _, p := range pragmas {
		if _, err := writer.Exec(p); err != nil {
			return nil, fmt.Errorf("pragma %s: %w", p, err)
		}
	}

	return db, nil
}

// Close closes both database connections.
func (db *DB) Close() error {
	if err := db.Writer.Close(); err != nil {
		return err
	}
	return db.Reader.Close()
}

// Migrate runs all database migrations.
func (db *DB) Migrate() error {
	return runMigrations(db.Writer)
}
