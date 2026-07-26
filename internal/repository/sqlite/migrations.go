package sqlite

import (
	"database/sql"
	"fmt"
)

// runMigrations creates or updates the database schema.
func runMigrations(db *sql.DB) error {
	// Create migrations tracking table
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("create migrations table: %w", err)
	}

	migrations := []struct {
		version int
		sql     string
	}{
		{1, migrationV1},
		{2, migrationV2},
		{3, migrationV3},
		{4, migrationV4},
		{5, migrationV5},
		{6, migrationV6},
		{7, migrationV7},
		{8, migrationV8},
		{9, migrationV9},
		{10, migrationV10},
		{11, migrationV11},
		{12, migrationV12},
		{13, migrationV13},
		{14, migrationV14},
		{15, migrationV15},
		{16, migrationV16},
	}

	for _, m := range migrations {
		var exists int
		err := db.QueryRow("SELECT COUNT(*) FROM schema_migrations WHERE version = ?", m.version).Scan(&exists)
		if err != nil {
			return fmt.Errorf("check migration %d: %w", m.version, err)
		}
		if exists > 0 {
			continue
		}

		if _, err := db.Exec(m.sql); err != nil {
			return fmt.Errorf("run migration %d: %w", m.version, err)
		}

		if _, err := db.Exec("INSERT INTO schema_migrations (version) VALUES (?)", m.version); err != nil {
			return fmt.Errorf("record migration %d: %w", m.version, err)
		}
	}

	return nil
}

const migrationV1 = `
-- ═══════════════════════════════════════
-- USERS & AUTH
-- ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    email         TEXT NOT NULL UNIQUE,
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user','guest')),
    quota_bytes   INTEGER NOT NULL DEFAULT 10737418240,
    used_bytes    INTEGER NOT NULL DEFAULT 0,
    avatar_url    TEXT DEFAULT '',
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invite_links (
    id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    code       TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id),
    role       TEXT NOT NULL DEFAULT 'user',
    max_uses   INTEGER DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════
-- FOLDERS
-- ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS folders (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name        TEXT NOT NULL,
    parent_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    color       TEXT DEFAULT '',
    is_starred  BOOLEAN NOT NULL DEFAULT 0,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(parent_id, name, owner_id)
);

-- ═══════════════════════════════════════
-- FILES & VERSIONING
-- ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS files (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name              TEXT NOT NULL,
    mime_type         TEXT NOT NULL DEFAULT 'application/octet-stream',
    size              INTEGER NOT NULL,
    encrypted_size    INTEGER NOT NULL,
    folder_id         TEXT REFERENCES folders(id) ON DELETE SET NULL,
    owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blob_path         TEXT NOT NULL,
    iv                TEXT NOT NULL,
    version           INTEGER NOT NULL DEFAULT 1,
    is_starred        BOOLEAN NOT NULL DEFAULT 0,
    is_trashed        BOOLEAN NOT NULL DEFAULT 0,
    trashed_at        DATETIME,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    accessed_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS file_versions (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    file_id      TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    size         INTEGER NOT NULL,
    blob_path    TEXT NOT NULL,
    iv           TEXT NOT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by   TEXT NOT NULL REFERENCES users(id),
    UNIQUE(file_id, version)
);

-- ═══════════════════════════════════════
-- SHARING
-- ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS share_links (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    file_id        TEXT REFERENCES files(id) ON DELETE CASCADE,
    folder_id      TEXT REFERENCES folders(id) ON DELETE CASCADE,
    created_by     TEXT NOT NULL REFERENCES users(id),
    token          TEXT NOT NULL UNIQUE,
    permission     TEXT NOT NULL DEFAULT 'read' CHECK(permission IN ('read','write','upload')),
    password_hash  TEXT DEFAULT '',
    expires_at     DATETIME,
    max_downloads  INTEGER,
    download_count INTEGER NOT NULL DEFAULT 0,
    is_active      BOOLEAN NOT NULL DEFAULT 1,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (file_id IS NOT NULL OR folder_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS user_shares (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    file_id     TEXT REFERENCES files(id) ON DELETE CASCADE,
    folder_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
    shared_by   TEXT NOT NULL REFERENCES users(id),
    shared_with TEXT NOT NULL REFERENCES users(id),
    permission  TEXT NOT NULL DEFAULT 'read' CHECK(permission IN ('read','write','upload')),
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (file_id IS NOT NULL OR folder_id IS NOT NULL)
);

-- ═══════════════════════════════════════
-- COLLABORATION
-- ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS comments (
    id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id),
    content    TEXT NOT NULL,
    parent_id  TEXT REFERENCES comments(id) ON DELETE CASCADE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activity_log (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id     TEXT NOT NULL REFERENCES users(id),
    action      TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    target_name TEXT DEFAULT '',
    metadata    TEXT DEFAULT '',
    ip_address  TEXT DEFAULT '',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    message     TEXT NOT NULL,
    target_id   TEXT DEFAULT '',
    target_type TEXT DEFAULT '',
    is_read     BOOLEAN NOT NULL DEFAULT 0,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_files_trashed ON files(is_trashed, trashed_at);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders(owner_id);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token);
CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
`

const migrationV2 = `
ALTER TABLE invite_links ADD COLUMN quota_bytes INTEGER NOT NULL DEFAULT 10737418240;
`

const migrationV3 = `
CREATE TABLE IF NOT EXISTS computers (
    id             TEXT PRIMARY KEY,
    owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    hostname       TEXT NOT NULL DEFAULT '',
    root_folder_id TEXT NOT NULL UNIQUE REFERENCES folders(id) ON DELETE CASCADE,
    last_seen_at   DATETIME,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_computers_owner ON computers(owner_id);
`

const migrationV4 = `
ALTER TABLE folders ADD COLUMN is_trashed BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN trashed_at DATETIME;
CREATE INDEX IF NOT EXISTS idx_folders_trashed ON folders(is_trashed, trashed_at);
`

const migrationV5 = `
CREATE TABLE IF NOT EXISTS file_approvals (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    file_id      TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    requested_by TEXT NOT NULL REFERENCES users(id),
    approver_id  TEXT NOT NULL REFERENCES users(id),
    status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_file_approvals_approver ON file_approvals(approver_id, status);
CREATE INDEX IF NOT EXISTS idx_file_approvals_requester ON file_approvals(requested_by, status);
ALTER TABLE comments ADD COLUMN assigned_to TEXT REFERENCES users(id);
`

const migrationV6 = `
ALTER TABLE invite_links ADD COLUMN email TEXT NOT NULL DEFAULT '';
`

const migrationV7 = `
ALTER TABLE users ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
`

const migrationV8 = `
CREATE TABLE IF NOT EXISTS email_change_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    new_email   TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  DATETIME NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_change_user ON email_change_tokens(user_id);
`

const migrationV9 = `
ALTER TABLE users ADD COLUMN email_2fa_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS email_2fa_challenges (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash   TEXT NOT NULL,
    expires_at  DATETIME NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_2fa_user ON email_2fa_challenges(user_id);
`

const migrationV10 = `
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  DATETIME NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);
`

const migrationV11 = `
CREATE TABLE IF NOT EXISTS user_crypto (
    user_id              TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    key_salt             BLOB NOT NULL,
    wrapped_uek          TEXT NOT NULL,
    wrapped_uek_recovery TEXT,
    version              INTEGER NOT NULL DEFAULT 1,
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS file_encryption_keys (
    file_id          TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    owner_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wrapped_file_key TEXT NOT NULL,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_file_enc_keys_owner_updated ON file_encryption_keys(owner_id, updated_at);
`

const migrationV12 = `
CREATE TABLE IF NOT EXISTS sync_changes (
    seq               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    computer_root_id  TEXT NOT NULL,
    entity_type       TEXT NOT NULL CHECK(entity_type IN ('file','folder')),
    entity_id         TEXT NOT NULL,
    parent_id         TEXT,
    operation         TEXT NOT NULL,
    name              TEXT NOT NULL DEFAULT '',
    version           INTEGER NOT NULL DEFAULT 0,
    occurred_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    payload           TEXT NOT NULL DEFAULT '{}',
    is_tombstone      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sync_changes_feed ON sync_changes(user_id, computer_root_id, seq);

CREATE TABLE IF NOT EXISTS client_mutations (
    client_mutation_id TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_client_mutations_user ON client_mutations(user_id);
`

const migrationV13 = `
CREATE TABLE IF NOT EXISTS sessions (
    id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash  TEXT NOT NULL UNIQUE,
    device_name         TEXT NOT NULL DEFAULT '',
    device_type         TEXT NOT NULL DEFAULT 'web' CHECK(device_type IN ('web','desktop')),
    user_agent          TEXT NOT NULL DEFAULT '',
    ip_address          TEXT NOT NULL DEFAULT '',
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at          DATETIME NOT NULL,
    revoked_at          DATETIME
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`

const migrationV14 = `
ALTER TABLE sessions ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(user_id, device_id);
`

const migrationV15 = `
CREATE TABLE IF NOT EXISTS upload_sessions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    file_id         TEXT,
    name            TEXT NOT NULL,
    mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
    iv              TEXT NOT NULL DEFAULT '',
    original_size   INTEGER NOT NULL DEFAULT 0,
    encrypted_size  INTEGER NOT NULL DEFAULT 0,
    folder_id       TEXT,
    temp_path       TEXT NOT NULL,
    received_bytes  INTEGER NOT NULL DEFAULT 0,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at      DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_user ON upload_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_expires ON upload_sessions(expires_at);
`

const migrationV16 = `
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_enrolled_at DATETIME;

ALTER TABLE email_2fa_challenges ADD COLUMN method TEXT NOT NULL DEFAULT 'email';

CREATE TABLE IF NOT EXISTS totp_backup_codes (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash   TEXT NOT NULL,
    used_at     DATETIME,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_totp_backup_user ON totp_backup_codes(user_id);
`
