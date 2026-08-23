<p align="center">
  <img src="docs/favicon.svg" width="78" alt="FreeDrive Logo" />
</p>

<h1 align="center">FreeDrive</h1>

<p align="center">
  <strong>Self-hosted cloud storage with a familiar Drive-like UX.</strong><br/>
  Single Go binary, embedded SQLite, disk-backed storage, admin panel, modern web UI, desktop sync client, and Android app.
</p>
<p align="center"><strong>Licensed under MIT</strong></p>

<p align="center">
  <a href="https://abdullaabdullazade.github.io/freedrive/"><img src="https://img.shields.io/badge/Website-freedrive-blue?style=flat-square" alt="Website"/></a>
  <a href="https://github.com/abdullaabdullazade/freedrive/releases"><img src="https://img.shields.io/github/v/release/abdullaabdullazade/freedrive?style=flat-square" alt="Release"/></a>
  <a href="https://github.com/abdullaabdullazade/freedrive/stargazers"><img src="https://img.shields.io/github/stars/abdullaabdullazade/freedrive?style=flat-square" alt="Stars"/></a>
  <a href="https://github.com/abdullaabdullazade/freedrive/blob/master/LICENSE"><img src="https://img.shields.io/github/license/abdullaabdullazade/freedrive?style=flat-square" alt="License"/></a>
  <a href="https://github.com/abdullaabdullazade/freedrive"><img src="https://img.shields.io/github/go-mod/go-version/abdullaabdullazade/freedrive?style=flat-square" alt="Go version"/></a>
  <a href="https://github.com/users/abdullaabdullazade/packages/container/freedrive"><img src="https://img.shields.io/badge/GHCR-ghcr.io%2Fabdullaabdullazade%2Ffreedrive-2496ED?style=flat-square&logo=docker&logoColor=white" alt="GHCR image"/></a>
</p>

<p align="center">
  <a href="https://github.com/abdullaabdullazade/freedrive/releases/latest"><strong>Download FreeDrive for Windows, macOS, Linux, and Android</strong></a>
</p>

---

## Table of Contents

- [Overview](#overview)
- [Screenshots](#screenshots)
- [Core Features](#core-features)
- [Admin Capabilities](#admin-capabilities)
- [Architecture](#architecture)
- [Security Model](#security-model)
- [Quick Start](#quick-start)
- [Production Install (systemd)](#production-install-systemd)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Desktop Client](#desktop-client)
- [Mobile Client](#mobile-client)
- [Project Structure](#project-structure)
- [Deployment Options](#deployment-options)
- [Operations](#operations)
- [Star History](#star-history)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Maintainer](#maintainer)
- [License](#license)

---

## Overview

FreeDrive is an open-source, self-hosted storage platform designed to feel instantly familiar for users coming from mainstream cloud drives.

What makes it practical:

- Single binary backend (`Go`) with embedded web assets
- Embedded SQLite database (no external DB required)
- Local disk storage backend
- Session-backed JWT access + rotating refresh-token authentication
- Optional email-based two-factor authentication (2FA)
- Optional authenticator-app (TOTP) 2FA with email fallback
- User profile settings and secure email change flow
- User and admin workspaces in one application
- Simple deployment with direct binary run or `systemd`

FreeDrive is ideal for:

- Developers wanting full ownership of files and auth
- Small teams needing private internal storage
- Self-hosting enthusiasts who want low operational overhead

---

## Screenshots

### User Workspace

![User Workspace](docs/screenshots/user.png)

### Admin Workspace

![Admin Workspace](docs/screenshots/admin.png)

---

## Core Features

### 1. Drive-like File Management UX

- Folder-based navigation and root view
- Unified page headers across Home, My Drive, Recent, Starred, Shared with me, Trash, and other tabs
- Home Suggested files: list view with Name / Reason suggested / Owner / Location (parent folder name), or grid tiles
- List/grid view switching with Recent and Starred collections
- Owner column shows avatar + `me` for your own items, or avatar + owner name for others
- Global live search in the top bar on every page
- Advanced search panel (Drive-style filters: type, owner, location, modified, trash, starred, approvals, and more)
- Context menus and keyboard shortcuts

### 2. Sidebar: My Drive & Computers

- **My Drive** — primary file space with an expandable sidebar folder tree (lazy-loaded folders, expand/collapse chevrons, path sync on navigation)
- **Computers** — separate sidebar section for desktop backup/sync (isolated from My Drive root folders); the [`desktop/`](desktop/) Tauri client registers here and syncs local folders; stable toolbar height when selecting items (no layout jump)
- Drive-style pill highlights on nav rows, with chevrons inside the active/hover area

### 3. File Lifecycle

- Upload files via web UI
- **New** menu — folder, file/folder upload, Document (`.txt`), Spreadsheet (`.csv`), Presentation (`.md` stub); Document/Spreadsheet/Presentation open in Docs or Sheets after create
- Download encrypted blob payloads with metadata headers
- Rename and move files between folders
- Soft delete to Trash (files and folders, including folder subtrees); Move to bin from mobile/web removes the item from My Drive listings — desktop Explorer catches up on the next My Drive poll (~20s)
- Restore from Trash (files and folders)
- Permanent delete (files and folders)
- Scheduled and admin trash purge removes old trashed **files** (blobs + rows) and **folders** (metadata rows)

### 4. In-browser editors & Open with

- **Docs** — Google Docs-style rich-text editor for `.txt`, `.md`, and `.html` (toolbar, page canvas, autosave)
- **Photos** — Google Photos-style image editor (top icon toolbar, crop/draw/rotate, Adjustments and Filters panels)
- **Sheets** — Google Sheets-style grid for `.xlsx`, `.xls`, and `.csv` (formula bar, sheet tabs, search); saves only changed cells so untouched formulas and formatting stay intact
- **PDF / video / audio / JSON** — dedicated viewers and players
- **Open with…** — context menu lists FreeDrive apps for the file type (recommended app highlighted); unsupported types offer download

### 5. Versioning Support

- File version records are kept when content is updated (can be disabled in admin settings)
- Configurable `keep_versions` retention per file
- List versions per file
- Restore an earlier version

### 6. User Profile & Security

- Profile settings modal (name, avatar photo)
- Forgot-password flow with SQLite-persisted reset tokens (survives server restart; single-use)
- **Cross-device encryption** — account key (UEK) and per-file keys sync via server; unlocks automatically when you sign in with your password
- **Device unlock cache** — web UI wraps the UEK with a per-browser device key (IndexedDB) so encryption stays active across page refreshes; cleared on logout
- **Recovery code** — emergency restore when the server loses account crypto metadata but file keys remain (e.g. after a data reset); also used when password is forgotten
- **Key rotation** — re-wrap account and file keys with a new password-derived key under Advanced (web: Security center → Encryption; desktop: Settings)
- Password reset can re-wrap the account key when crypto metadata is supplied
- Secure email change with confirmation link sent to the new address
- **Security center** (web profile menu) is the place to enroll an authenticator app: scan the QR (or enter the secret), confirm a code, then save the one-time backup codes. Email 2FA remains a separate toggle for codes sent by SMTP. The Settings modal keeps only profile fields (name, avatar, email)
- When admin enables global `require_2fa`, all users must complete a second factor at sign-in (authenticator app **or** email). If both are enabled, authenticator is preferred with **Send code by email** as fallback
- Desktop **0.1.8+** and current mobile builds verify TOTP / backup codes at login; authenticator enrollment stays web-only in v1
- **Logged-in devices** — the web Security center and desktop app list active web and desktop sessions with device name, IP address, and last activity; re-login from the same browser/app overwrites that device's session instead of creating a duplicate
- **Instant remote logout** — revoke one device or every other device; server middleware rejects the revoked session immediately

### 7. Sharing Model

- User-to-user sharing data model (`user_shares`) with role-based access control enforced on read/write mutations
- Share-link data model (`share_links`) with optional password, expiry, and download limits
- **Shared with me** sidebar view for inbound shares (Google Drive-style — no separate “Shared by me” tab)
- Outbound shares stay in **My Drive**; manage recipients in the Share dialog; shared items show a people icon in the file list
- Find items you shared via advanced search: **Owner: Me** + **Shared to** (email)
- `GET /shares/by-me` API supports Share dialog, details panel, and search (not a separate nav view)
- Update share permission (`PATCH /shares/users/{id}`) and folder shares in shared listings

### 8. Comments & Approvals

- File comments with optional assignee (`assigned_to_email`) — visible in the details Activity tab
- Advanced search follow-ups: “Comments assigned to me only”, approval awaiting / requested filters
- Request approval from context menu or file details; approver can approve/reject in Activity tab
- `GET /approvals`, `POST /files/{id}/approvals`, `PATCH /approvals/{id}` workflow

### 9. Storage & Quota Awareness

- Per-user quota enforcement during uploads/content updates
- Server-wide capacity limit (`total_capacity_gb`) enforced from admin settings
- Used-bytes accounting on delete/restore/permanent-delete paths
- Disk usage endpoint for runtime visibility

### 10. Activity Logging

- File/folder actions are recorded in activity logs (visible in each user's Activity page)
- Login and failed-login events with client IP
- User endpoint: `GET /activity` (current user's full activity, including file names)
- Admin endpoint: `GET /admin/activity` returns **authentication events only** (`login` / `failed_login`) — not file uploads, deletes, or filenames

### 11. Embedded App Delivery

- Frontend is embedded with `go:embed`
- Single process serves API + SPA + static assets

---

## Admin Capabilities

Admin routes are role-protected and available under `/api/v1/admin/*`.

In the Drive UI, users with the `admin` role see a Security-style shield icon in the top bar (next to Security) on every tab; it opens the admin panel at `/admin/dashboard`. The icon is hidden in admin-panel mode and for non-admin accounts.

Admin chrome:

- Top bar title **Admin Panel**; the in-page header shows the active section name (Dashboard, Manage Users, Storage, …)
- Sidebar matches Drive nav styling; **Back to Drive** at the bottom returns to `/#/files`
- Security nav icon matches the top-bar Security icon

### User Management

- List users
- Create users
- Update role, quota, username, email, suspension, and per-user 2FA
- Delete users (with self-delete protection)
- Trigger password reset email flow
- Revoke user sessions / revoke all sessions
- Send 2FA reminder emails to users without 2FA enabled

### Invite System

- Create invite links with:
  - role
  - max uses
  - quota bytes
- List invites
- Invite usage tracking and expiration checks

### Operational Controls

- View aggregate stats (`total_users`, `total_used`, `total_quota`)
- View authentication activity (`login` / `failed_login` only — no per-file operations)
- Save/retrieve admin settings (persisted to `data/settings.json`)
- Run backup snapshot for admin settings
- Scheduled settings backup (daily / weekly / monthly)
- Storage tools: purge trash (files + folders), list/purge duplicate blobs, wipe all data (danger zone)
- Storage type breakdown across the instance (`images` / `videos` / `documents` / `audio` / `archives` / `other` by encrypted size); optional `?user_id=` for a single user
- Trash auto-empty scheduler (`storage.trash_auto_empty`: 7 / 30 / 90 days or never)

### Security & Access Policy

Admin settings are enforced at runtime (not UI-only):

- **IP blocklist / allowlist** — applied on login, register, refresh, reset-password, and 2FA verification
- **Require 2FA for all users** — forces authenticator or email verification at sign-in (no admin exemption)
- **Versioning** — enable/disable file versioning and set `keep_versions`
- **Total capacity** — server-wide storage cap blocks uploads and content updates when exceeded
- **Allowed file types** — extension whitelist in General settings; enable **Without limits** to accept any file type

Security panel also surfaces suspicious logins, active sessions, and session revocation.

### Email / SMTP

- SMTP test endpoint
- Password reset email dispatch
- Email change confirmation links
- Email 2FA sign-in codes
- Authenticator (TOTP) sign-in codes and backup codes
- 2FA reminder batch emails
- Configurable sender and TLS behavior

---

## Architecture

FreeDrive follows a clean layered structure:

- `api` layer: HTTP routes, handlers, middleware
- `service` layer: business logic (auth, file, folder)
- `repository` layer: persistence interfaces + SQLite implementations
- `storage` layer: disk blob IO

Runtime flow summary:

1. Request hits `chi` router
2. Global middleware stack executes (CORS, rate-limit, recover, logger)
3. Auth middleware validates the JWT and verifies its `sid` session against SQLite when required
4. Handler validates input and calls service/repo
5. Service applies policy (quota, ownership, versioning, capacity, activity, IP rules)
6. Response serialized as JSON

Admin settings are read from `data/settings.json` via the `adminsettings` package and applied consistently across handlers and services.

---

## Security Model

### Authentication

- Access token: JWT with a server-side session identifier (`sid`)
- Refresh token: random token, stored hashed with device metadata in the `sessions` table
- Refresh-token rotation keeps the same session and `sid`
- Every protected request verifies that the session still exists and has not been revoked
- Logout and remote device removal revoke the session immediately
- Active sessions record device type/name, user agent, IP address, creation time, and last activity
- Optional **email 2FA**: 6-digit code sent via SMTP after password verification
- Optional **authenticator (TOTP) 2FA**: Google Authenticator / Authy / 1Password; preferred when both methods are enabled, with email as fallback; one-time backup codes issued at enroll
- Global `require_2fa` admin setting forces 2FA for every account (satisfied by TOTP or email)

### Authorization

- Protected API group requires valid access token
- Admin routes use explicit admin-role middleware
- User-scoped operations enforce ownership checks in services

### Network Access Control

- IP blocklist and allowlist from admin settings
- Enforced on all public auth endpoints (login, register, refresh, reset-password, verify-2fa)
- Loopback addresses (`127.0.0.1`, `::1`) are always allowed

### Secrets

- `FREEDRIVE_JWT_SECRET` can be provided via env
- If omitted, it is generated and stored in `data/jwt_secret.key`

### Rate Limiting

Global limiter enabled in router:

- `100 req/sec`
- `burst 400`

### Storage Note

File payloads are encrypted client-side (AES-GCM) before upload. The server stores ciphertext blobs and **wrapped** encryption keys only — it never receives the user's raw account key (UEK) or per-file keys.

- **Web UI** — WebCrypto encrypts/decrypts in the browser; keys are wrapped with a password-derived key and synced via `/api/v1/crypto/*`
- **Desktop client** — same UEK + file-key model; auto-unlock on sign-in, UEK cached in OS keyring, pending file keys flushed when back online
- **Auto-unlock** — password at sign-in unlocks encryption; no separate unlock step in normal use
- **Recovery** — if account crypto metadata is missing on the server but wrapped file keys exist, the web Security center (Encryption) and desktop Settings prompt for a recovery code to restore access
- **Logout** — clears device-local encryption state (web IndexedDB + desktop keyring session)
- On plain HTTP (non-localhost), the web UI warns and may upload without browser-side encryption

If your threat model requires strict end-to-end guarantees, review key handling and server-side wrapped-key storage before production rollout.

---

## Quick Start

### Prerequisites

- Go (matching `go.mod` requirements)
- Linux/macOS/WSL recommended for local development

### Run Locally

```bash
go mod download
FREEDRIVE_ADMIN_PASSWORD='replace-with-a-strong-password' go run ./cmd/freedrive
```

Open:

- `http://localhost:8080`

Bootstrap admin email (when the database has no users):

- Email: `admin@freedrive.local`
- Password: no default; set `FREEDRIVE_ADMIN_PASSWORD` to at least 12 characters

FreeDrive refuses the first startup when the bootstrap password is missing or shorter than 12 characters.

### Run Published Docker Image

Multi-architecture images are built by [GitHub Actions](.github/workflows/docker-publish.yml) on push to `master` and published to:

- **GHCR:** [`ghcr.io/abdullaabdullazade/freedrive`](https://github.com/users/abdullaabdullazade/packages/container/freedrive) — public, no login required

Tags: `latest`, `master`, `sha-<commit>`. Multi-arch: `linux/amd64`, `linux/arm64`.

```bash
docker pull ghcr.io/abdullaabdullazade/freedrive:latest
docker run -d \
  --name freedrive \
  -p 8080:8080 \
  -e FREEDRIVE_ADMIN_EMAIL=admin@freedrive.local \
  -e FREEDRIVE_ADMIN_PASSWORD=replace-with-a-strong-password \
  -v freedrive-data:/app/data \
  ghcr.io/abdullaabdullazade/freedrive:latest
```

The workflow can additionally publish to Docker Hub when repository secrets provide Docker Hub credentials, but GHCR is the canonical public image for this repository.

### Run With Docker Compose

`docker-compose.yml` pulls `ghcr.io/abdullaabdullazade/freedrive:latest`, runs a single `freedrive` service, and maps a host folder to `/app/data` through a bind mount.

Before the first start, copy `.env.example` to `.env`, set a strong `FREEDRIVE_ADMIN_PASSWORD` (and optionally `FREEDRIVE_ADMIN_EMAIL`), adjust the published port if needed, and set `FREEDRIVE_DATA_PATH` when data should live outside the default `./data` directory.

```bash
docker compose pull
docker compose up -d
```

Open:

- `http://localhost:8080`

Runtime data (the `freedrive.db` database, encrypted `blobs/`, and `jwt_secret.key`) lives in the host folder you mapped to `/app/data`, so it survives container recreation and image updates.

### Automatic Updates (Watchtower, optional)

The default `docker-compose.yml` does not include Watchtower. If you want automatic updates, add a [Watchtower](https://containrrr.dev/watchtower/) container that periodically checks GHCR for a newer `latest` image and recreates the FreeDrive container:

- Run Watchtower with `--cleanup --label-enable --interval 3600` (hourly; `--cleanup` removes the old image after each update).
- Add the label `com.centurylinklabs.watchtower.enable=true` to the `freedrive` service so Watchtower only updates FreeDrive and leaves your other containers untouched.

### Synology: Update Without Losing Data

Important: your data is NOT deleted on update. The database (`freedrive.db`), the encrypted blobs (`blobs/`) and the `jwt_secret.key` all live in the folder you mapped to `/app/data`. They stay on the NAS.

What actually goes wrong: when you press "Update" or delete and recreate a single container in Container Manager, the GUI can drop the `/app/data` mapping (or you recreate it without re-selecting the exact same folder). The new container then starts on an empty `/app/data` inside its own writable layer, so the app shows no users and cannot read files — even though the real data is untouched in your folder. Do NOT rely on manual delete + recreate for updates.

**Step 0 — confirm your data is safe (SSH):**

```bash
ls -la /volume1/<your-path>/freedrive/data
# expected: freedrive.db, blobs/, jwt_secret.key
```

**Method A (recommended): run FreeDrive as a Project (compose) with a bind mount to your folder.**

The shipped `docker-compose.yml` already uses a host bind mount, so the mapping lives in the file and can never be dropped. Point it at a folder on your NAS:

```yaml
    volumes:
      - /volume1/<your-path>/freedrive/data:/app/data
```

Update from the Project view via pull + up (`docker compose pull && docker compose up -d`). Because the mapping lives in the file, every recreation reuses the exact same data folder.

**Method B (optional): add Watchtower for automatic updates — the mapping can never be lost.**

Watchtower clones the running container's full configuration (including your `/app/data` bind mount) before pulling the new image and recreating it, so the folder mapping is always preserved.

1. Add the label `com.centurylinklabs.watchtower.enable=true` to your `freedrive` container.
2. Run a Watchtower container (via Container Manager or a separate compose service) with `--cleanup --label-enable --interval 3600`.
3. Stop pressing "Update" in the GUI — Watchtower now updates FreeDrive on its own without touching your data.

**If you must recreate manually:** your data is safe in the folder; you only have to map that exact same folder back to `/app/data` when creating the new container. Then verify the container is reading it:

```bash
docker inspect --format '{{json .Mounts}}' freedrive
# the mount source must point to your /volume1/<your-path>/freedrive/data folder
```

**Verify you are actually running the new build (SSH):**

```bash
# digest the container is currently running
docker inspect --format '{{.Image}}' freedrive
# digest of the local latest image
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/abdullaabdullazade/freedrive:latest
```

After the app is updated, the browser fetches fresh frontend assets automatically (the server sends `ETag` + `Cache-Control: no-cache`); a hard refresh (Ctrl+F5) is only needed if you loaded a version built before this behavior existed.

---

## Production Install (systemd)

The repository includes `scripts/install.sh` for Linux host installation.

```bash
chmod +x scripts/install.sh
./scripts/install.sh
```

What it does:

- Prompts for admin credentials
- Downloads the latest release binary
- Installs binary to `/opt/freedrive/freedrive`
- Writes env file at `/etc/freedrive/freedrive.env`
- Creates/starts `freedrive.service`

To update an existing systemd installation to the latest release:

```bash
curl -fsSL https://abdullaabdullazade.github.io/freedrive/update.sh -o update.sh
chmod +x update.sh
./update.sh
```

The updater verifies the release checksum, keeps your existing data and `/etc/freedrive/freedrive.env`, backs up the current binary to `/opt/freedrive/freedrive.bak`, installs the new binary, and restarts `freedrive.service`.

Operational commands:

```bash
sudo systemctl status freedrive
sudo systemctl restart freedrive
sudo journalctl -u freedrive -f
```

Browser encryption note: uploads use WebCrypto when the browser allows it. Use `http://localhost:8080` or HTTPS for encrypted uploads; on plain HTTP server addresses, FreeDrive warns first and uploads without browser-side encryption.

Note: current systemd template runs service as `root`. For hardened production setups, consider a dedicated system user and tighter filesystem permissions.

---

## Configuration

Environment variables loaded by `internal/config/config.go`:

| Variable | Description | Default |
|---|---|---|
| `FREEDRIVE_PORT` | HTTP port | `8080` |
| `FREEDRIVE_DATA_DIR` | Data directory (DB, blobs, keys) | `./data` |
| `FREEDRIVE_JWT_SECRET` | JWT signing secret | auto-generated if empty |
| `FREEDRIVE_MAX_UPLOAD_MB` | Max upload size (MB) | `5120` |
| `FREEDRIVE_ADMIN_EMAIL` | Initial admin email | `admin@freedrive.local` |
| `FREEDRIVE_ADMIN_PASSWORD` | Initial admin password; required on an empty database and must be at least 12 characters | none |

---

## API Reference

Base path: `/api/v1`

### Public Auth

- `POST /auth/register`
- `POST /auth/login` — returns tokens, or `{ requires_2fa, challenge_id, method, methods_available, email_masked }` when 2FA is required (`method` is `totp` or `email`)
- `POST /auth/verify-2fa` — complete login with `{ challenge_id, code }` (TOTP, backup code, or email code)
- `POST /auth/2fa/send-email` — switch a TOTP challenge to email and send a code (`{ challenge_id }`)
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/forgot-password` — `{ email }` — sends reset link if account exists (requires SMTP); generic response either way
- `POST /auth/reset-password` — `{ token, email, new_password, crypto_update? }` — consumes SQLite-stored token (survives server restart); optional `crypto_update` re-wraps the account encryption key after password change
- `POST /auth/reset-password/crypto-info` — `{ token, email }` — returns wrapped account key metadata for password-reset flows that preserve file access
- `POST /auth/confirm-email` — confirm pending email change from link

### Protected (Authenticated)

- `GET /me` — current user profile (includes `email_2fa_enabled`, `totp_enabled`)
- `PATCH /me` — update username, avatar, or `email_2fa_enabled`
- `POST /me/totp/setup` — start authenticator enrollment (`secret`, `otpauth_url`, `qr`)
- `POST /me/totp/confirm` — `{ code }` — enable TOTP and return one-time `backup_codes`
- `POST /me/totp/disable` — `{ code }` or `{ password }` — disable authenticator
- `POST /me/email-change/request` — start secure email change (confirmation link to new address)
- `GET /me/email-change/status` — pending email change status
- `GET /me/storage`
- `GET /activity`
- `GET /disk-stats`
- `GET /auth/sessions` — list the current user's active devices; marks the current session
- `DELETE /auth/sessions/{id}` — remotely sign out one of the current user's devices
- `POST /auth/sessions/revoke-others` — sign out every device except the current session
- `GET /search` — advanced search (query + filters: type, owner, location, trash, starred, modified, approvals, follow-ups, …)
- `GET /approvals` — list approvals for current user (`?status=pending` optional)
- `PATCH /approvals/{id}` — `{ status: "approved" | "rejected" }` (approver only)

#### Encryption key sync

Password-wrapped account keys and per-file keys for cross-device decrypt. The server stores wrapped keys only; clients derive the UEK locally from the user's password.

- `GET /crypto/account` — account crypto metadata (`has_crypto`, `key_salt`, `wrapped_uek`, optional recovery wrap)
- `POST /crypto/account` — first-time setup (`key_salt`, `wrapped_uek`, optional `wrapped_uek_recovery`)
- `PUT /crypto/account` — update wraps after password change
- `GET /encryption-keys` — list file keys for current user (`?since=` for incremental sync)
- `POST /encryption-keys/bulk` — bulk import wrapped file keys after upload batches
- `GET /files/{id}/encryption-key` — wrapped key for one file
- `PUT /files/{id}/encryption-key` — store wrapped key for one file

#### Shares

User-to-user sharing and public links. Permissions: `viewer`/`commenter` → read; `editor` → write. Access is enforced on file/folder get, download, breadcrumb, and mutations.

- `GET /shares/with-me` — items shared with the current user (sidebar **Shared with me**)
- `GET /shares/by-me` — items the current user has shared (used by Share dialog and advanced search; no separate nav view)
- `POST /shares/users` — `{ file_id?, folder_id?, shared_with?, shared_email?, permission }`
- `PATCH /shares/users/{id}` — `{ permission }`
- `DELETE /shares/users/{id}`
- `GET /shares/links` — list share links created by the user
- `POST /shares/links` — `{ file_id?, folder_id?, permission, password?, expires_at?, max_downloads? }`
- `DELETE /shares/links/{id}`

#### Files

- `POST /files/upload`
- `GET /files`
- `GET /files/trash`
- `GET /files/{id}`
- `GET /files/{id}/comments`
- `POST /files/{id}/comments` — `{ content, parent_id?, assigned_to_email? }`
- `DELETE /files/{id}/comments/{commentId}`
- `POST /files/{id}/approvals` — `{ approver_id?, approver_email? }` (requires write access)
- `GET /files/{id}/download`
- `PATCH /files/{id}`
- `POST /files/{id}/content` — multipart replace encrypted blob (`file`, `name`, `mime_type`, `iv`, `original_size`); used by desktop sync and mobile text/image save
- `DELETE /files/{id}`
- `POST /files/{id}/restore`
- `DELETE /files/{id}/permanent`
- `GET /files/{id}/versions`
- `POST /files/{id}/versions/{version}/restore`

#### Resumable uploads (Cloudflare-safe)

For encrypted payloads **> 32 MiB**, clients open a session and send **8 MiB** chunks (avoids ~100 MB Cloudflare request limits). Smaller files still use multipart `/files/upload` or `/files/{id}/content`.

- `POST /uploads/sessions` — JSON `{ name, mime_type, iv, original_size, encrypted_size, folder_id?, file_id? }` → `{ id, received_bytes, encrypted_size, chunk_size_hint, expires_at }`
- `PUT /uploads/sessions/{id}` — raw body + `Content-Range: bytes start-end/total`; last chunk returns the `File` object
- `GET /uploads/sessions/{id}` — resume status (`received_bytes`)
- `DELETE /uploads/sessions/{id}` — abort and delete temp data

#### Folders

- `POST /folders` — create under `parent_id`; **idempotent** for the same live `(parent, name, owner)` (returns the existing folder). If a **trashed** folder already uses that name, it is renamed in the bin to free UNIQUE and a **new** live folder is created — never auto-restored into My Drive (so mobile/web Move to bin is not undone by desktop `create_or_resolve`)
- `GET /folders/root` — child folders + paginated files (`page_size`, `page_token`; response: `next_page_token`, `total_files`)
- `GET /folders/all`
- `GET /folders/trash`
- `GET /folders/{id}` — same pagination as root
- `PATCH /folders/{id}`
- `DELETE /folders/{id}`
- `POST /folders/{id}/restore`
- `DELETE /folders/{id}/permanent`
- `GET /folders/{id}/breadcrumb`

#### Computers

- `GET /computers`
- `GET /computers/{id}`
- `POST /computers/register`
- `POST /computers/{id}/heartbeat`

### Public (no auth)

- `GET /public/share/{token}` — share link metadata (`X-Share-Password` header if protected)
- `GET /public/share/{token}/download` — download file via share link (`X-Share-Password` header if protected)

### Admin (Requires `admin` role)

- `GET /admin/users`
- `POST /admin/users`
- `PATCH /admin/users/{id}`
- `DELETE /admin/users/{id}`
- `POST /admin/users/{id}/reset-password`
- `POST /admin/users/{id}/revoke-sessions`
- `POST /admin/users/send-2fa-reminder`
- `POST /admin/sessions/revoke-all`
- `GET /admin/stats`
- `POST /admin/invites`
- `POST /admin/invites/resend`
- `GET /admin/invites`
- `DELETE /admin/invites/{id}`
- `GET /admin/activity` — authentication events only (`login` / `failed_login`)
- `GET /admin/settings`
- `POST /admin/settings`
- `POST /admin/test-email`
- `POST /admin/backup/run`
- `GET /admin/backup/list`
- `GET /admin/backup/download/{filename}`
- `POST /admin/backup/restore`
- `DELETE /admin/backup/{filename}`
- `GET /admin/storage/breakdown` — instance-wide (or `?user_id=`) file-type size breakdown
- `POST /admin/storage/purge-trash?days=30` — permanently delete trashed files (blobs + rows) and folder rows older than N days; `days=0` purges all trash. Response: `{ removed_files, removed_folders, freed_bytes }`. Background auto-empty uses the `storage.trash_auto_empty` setting (7 / 30 / 90 / never).
- `GET /admin/storage/duplicates`
- `POST /admin/storage/duplicates/purge`
- `POST /admin/danger/wipe`

### Health

- `GET /health`

---

## Desktop Client

The [`desktop/`](desktop/) directory contains the **FreeDrive Desktop** sync app (Tauri 2 + React + Rust). It talks to the server over the same REST API as the web UI.

![FreeDrive Desktop](docs/screenshots/FreeDrive%20Desktop.png)

- Sign in, onboarding, folder sync, system tray, pause/resume (skips `.git`, `node_modules`, `.svn` during folder scan)
- **Single-instance** — launching a second copy focuses the existing window instead of starting another process
- **Computer sync folders** — folders you add (Documents, Downloads, etc.) upload copies to the cloud only; they are not shown inside FreeDrive My Drive root; deleting a local file soft-deletes it on the server (Explorer Delete / move out of the sync folder included); each scan **ensures remote subfolders** for local directories before uploads
- **Transient sync errors retry** — failed uploads (`error` in local state) are retried on the next scan; only permanent `rejected` items (e.g. disallowed type) stay skipped
- **Upload progress ring** — Home / Sync activity show a Drive-style circular progress around the ↑ icon while a file uploads (byte progress from chunked / multipart upload)
- **Delete catch-up** — periodic background verify (~5 min) and same-name cleanup before fresh uploads reduce orphaned or duplicate server files after missed watcher events
- **Cross-device decryption** — syncs password-wrapped account and file keys from the server; Explorer hydration decrypts files with the same keys as the web UI
- **Encryption status** — lock icon in top bar (unlocked/locked); Settings shows recovery restore when server account crypto is missing
- **Google Drive-style UI** — sidebar with SVG icons (Home, Sync activity, Notifications) and alert badge
- **Drive-like scrollbar** — transparent track, thin thumb only
- **Settings menu** — the main-window gear opens **Preferences**, **Error list**, **About**, **Help** (opens the GitHub repo), and **Quit**
- **Resizable and fullscreen windows** — main and Preferences windows can be resized, maximized, or used fullscreen
- **Preferences window** — separate window with **My computer** (sync folders, add/remove), **FreeDrive** (My Drive stream/mirror mode), and a single scrollable Settings page
- **Unified Settings page** — launch on login, start minimized (tray), diagnostics, encryption and keys, File Explorer integration, and server information are expanded in one view
- **Error list** — opens Sync activity filtered to failed items, with an All / Errors toggle
- **About dialog** — displays the desktop app version and connected server
- **Notifications** — alerts for sync errors, paused sync, and low storage (≥80% / ≥90%)
- **Profile menu** — server avatar from `GET /api/v1/me`, storage bar from `GET /api/v1/me/storage` (`{used} of {total} used`), Sign out
- **Sign out** — disconnects CfAPI and clears the contents of `%USERPROFILE%\FreeDrive\My Drive` (the folder itself remains for the next login)
- **Device identification** — login, 2FA verification, and refresh requests report the desktop hostname so the app appears clearly in the account's logged-in-device list
- **Authenticator 2FA (0.1.8+)** — sign-in accepts a TOTP code or backup code; when email 2FA is also available, **Send code by email** switches the challenge (enroll the app in web Security first)
- **Start minimized (0.1.9+)** — Preferences → Launch can hide the main window to the system tray on cold start (same as Close); tray / second instance still open the window
- **Non-blocking sign-in** — encryption unlock, sync restore, and Explorer (CfAPI) integration run in the background so the UI returns immediately after login
- **Silent background sync** — on restart, background verification shows progress on Home (`Syncing…` / `Processing N/M`) without flooding Sync activity; if initial sync was interrupted, startup resumes the full sync instead of verify-only
- **Queued changes during sync** — uploads and deletes that happen while initial sync or verify is running are queued and applied when that pass finishes
- **Duplicate download event safe (0.1.7+)** — Create/Write/Rename bursts for one browser download are serialized by canonical local path; only the current remote mapping may remove older same-name copies, preventing fresh uploads from trashing each other
- **Restore from Bin comes back to the PC** — restoring a file on the server (or uploading it from the web) downloads it into the sync folder, including when the restore happened while the desktop app was closed. Server deletes are only propagated for items this computer previously synced, so a restored file is never sent back to the Bin
- **Server restart safe (0.1.6+)** — full scans start only after `/health` and `/me` succeed; offline/5xx/session failures pause scanning, delayed delete journal entries cannot erase a newer remote mapping, and same-name cleanup runs only after a successful upload while preserving the new file
- **Parallel sync** — up to 6 concurrent uploads and 6 concurrent downloads (initial folder scan, pending queue, My Drive mirror polling)
- **Windows Explorer (CfAPI)** — after sign-in, with the app running in the tray, open `%USERPROFILE%\FreeDrive\My Drive` in File Explorer (Windows 10 1809+); **FreeDrive** is pinned in Explorer’s left nav with the app icon (CLSID NameSpace + SyncRootManager; stays on logout, removed on uninstall); provider connects in the background and reconnects automatically before opening the folder
- **Explorer status** — desktop app exposes integration state (connected / registered / finalized) for diagnostics
- **My Drive in Explorer** — `My Drive` subfolder with server folders/files; **Stream (default)** keeps cloud placeholders (download on open, upload on close, then free local space); **Mirror** keeps a full local copy; local edits upload on save, deletes sync to the server; remote changes polled every 20s (mirror downloads new/changed files); poll **removes** local placeholders after remote Move to bin so Explorer matches My Drive
- **Uninstall (NSIS)** — setup uninstaller stops the app, unregisters the CfAPI sync root, removes Explorer NameSpace/SyncRootManager pins, removes `%USERPROFILE%\FreeDrive\My Drive`, and deletes app data under `%APPDATA%\FreeDrive` (sync.db, auth — not the Tauri BUNDLEID folder); prefer NSIS over MSI for this cleanup
- Unified releases: a `vX.Y.Z` tag publishes server binaries, the Android APK,
  and Windows/Linux/macOS desktop packages to one GitHub Release. Legacy
  desktop-only `desktop-vX.Y.Z` tags remain supported.
- Release checklist and signing requirements: [`docs/releasing.md`](docs/releasing.md)
- See [`desktop/README.md`](desktop/README.md) for dev setup, Explorer troubleshooting, and [`docs/desktop-api.md`](docs/desktop-api.md) for API endpoints used by the client

Quick start (from repo root):

```bash
go run ./cmd/freedrive          # terminal 1 — server
cd desktop && npm install && npm run tauri dev   # terminal 2 — desktop
```

Build Windows installers (from `desktop/`, with MSVC env):

```cmd
scripts\dev.cmd build
```

Or:

```bash
cd desktop
npm install
npm run build:exe:clean
```

Build outputs:

- `desktop/src-tauri/target/release/freedrive-desktop.exe`
- `desktop/src-tauri/target/release/bundle/nsis/FreeDrive_<version>_x64-setup.exe` (only target — NSIS runs the My Drive / CfAPI + `%APPDATA%\FreeDrive` uninstall hooks)

To update an existing install, run the new `FreeDrive_*_x64-setup.exe` (in-place; no uninstall prompt). Or from `desktop/`: `npm run install:update`.

---

## Mobile Client

The [`mobile/`](mobile/) directory contains the **FreeDrive Mobile** Android app (Expo / React Native). It connects to the same REST API as the web UI and desktop client.

- **Sign in** with server URL, email, password, and 2FA when enabled (authenticator / backup code, or email code; **Send code by email** when TOTP is preferred and email is available)
- **Drive-like dark UI** — bottom tabs (Home, Starred, Shared, Files) on portrait; pill search bar, list/grid toggle, sort chip
- **Landscape NavRail** — when width > height (phone rotate / tablet landscape): narrow left rail with menu ≡, Create, and vertically centered primary tabs; portrait (including tablet) keeps phone chrome; Create uses rail `+` in landscape and FAB in portrait
- **Navigation drawer** — hamburger opens a slide-in drawer (Recent, Bin, Settings, Help) with storage usage from `GET /api/v1/me/storage` (portrait and landscape)
- **Files stack** — Files tab nests My Drive home and Folder screens; Shared can open a folder under that stack
- **Files** — My Drive and Computers tabs, folder navigation, search by name, pull-to-refresh; large folders load in pages (`page_size` / `page_token`) with infinite scroll (`onEndReached`) so the first screen stays fast; grid view uses square tiles and more columns on wide screens
- **Create FAB** — on Files / Folder screens, actions nearest the `+` are Folder, then Upload, Spreadsheet, Document (camera stub reserved)
- **Encrypted upload** — multi-file picker → AES-GCM → cache file → upload; payloads **> 32 MiB** use resumable chunked `PUT /uploads/sessions/{id}` (8 MiB chunks, Cloudflare-safe); smaller files use native multipart `POST /files/upload` / content replace
- **New folder** — `POST /api/v1/folders` from the FAB dialog
- **New Document / Spreadsheet** — creates encrypted `Document.txt` / `Spreadsheet.xlsx`; Document opens in the text editor; Spreadsheet opens the in-app sheet grid
- **Branding** — app icon, splash, and SVG icons match the desktop FreeDrive logo and Material-style glyphs
- **User avatar** — circular profile photo from `GET /api/v1/me` (`avatar_url` data-URL), with initials fallback
- **Profile menu** — storage bar (`{used} of {total} used`) from `/me/storage`, native Manage storage, admin-panel access for administrators, and Sign out
- **Device identification** — sessions appear as `Mobile (…)` on the account Devices list
- **File actions** — open, share a decrypted copy, download, star/unstar, and **Move to bin** (soft-delete on the server; item appears in Bin / Trash; permanent delete from Bin). Desktop My Drive poll drops matching Explorer placeholders within ~20s; creating the same name again does not revive the trashed folder into My Drive
- **Cross-device decryption** — syncs password-wrapped account and file keys so encrypted files can be opened on Android
- **File preview** — images, video (`expo-video`), audio (`expo-audio`), plain text and source files, Markdown/JSON/YAML, spreadsheets (`.xlsx` / `.xls` / `.csv`), and PDFs through installed device viewers
- **Large media** — images/videos over **100 MiB** are not opened in-app (Save / Share / Cancel instead) to avoid OOM crashes; smaller files may decrypt via native AES-GCM on disk
- **Spreadsheet editor** — SheetJS grid with formula bar and sheet tabs; Edit / Save uploads via `POST /api/v1/files/{id}/content`
- **Image gallery** — swipe between photos in the same loaded list; background decrypt for neighbors; counter and image content pad above the Android system nav bar (same pattern as video)
- **Video gallery** — swipe between videos in the same loaded list (active player only; safe-area padding above the system nav bar)
- **Text / spreadsheet / PDF preview** — FilePreview editors also reserve bottom safe-area so controls and last lines are not covered by the system nav bar
- **Edit & save** — text Edit/Save, sheet Edit/Save, and image Rotate/Save re-encrypt and upload via the same native multipart path to `POST /api/v1/files/{id}/content`
- **Android downloads** — native `FreeDriveDownloads` module (Expo config plugin under `mobile/plugins/with-freedrive-downloads/`) writes into the shared Downloads collection via MediaStore; shows an ongoing “Downloading…” status notification, then a tappable “Download complete” notification that opens the file (Android 13+ may ask for notification permission)
- **Status notifications** — no persistent “app running” foreground notification; status-bar icons only for downloads and while video is playing
- **Offline files** — save encrypted files for offline access, browse them from the Offline screen, and remove local copies independently of cloud files
- See [`mobile/README.md`](mobile/README.md) for Expo Go setup and local APK build notes

Quick start:

```bash
go run ./cmd/freedrive          # terminal 1 — server
cd mobile && npm install && npm start   # terminal 2 — Expo
```

Build a release APK on Windows (canonical: `mobile\scripts\build-apk.ps1` → `mobile\dist\FreeDrive-1.0.0.apk`; do not build from long `Desktop\…` paths):

```bash
cd mobile && powershell -File scripts\build-apk.ps1
```

Requires a server that supports paginated `GET /folders/root` and `GET /folders/{id}` (see [API Reference](#api-reference)).
---

## Project Structure

```text
cmd/freedrive/
  main.go                 # app bootstrap
  web/                    # embedded frontend (HTML/CSS/JS)

internal/
  adminsettings/          # persisted admin policy (IP, 2FA, capacity, backup)
  api/
    router.go             # route graph + middleware wiring
    handlers/             # HTTP handlers
    middleware/           # auth, CORS, rate limit, client IP
  config/                 # env config + secret generation
  domain/                 # core entities
  email/                  # shared SMTP sender
  repository/             # interfaces
  repository/sqlite/      # sqlite repos + migrations
  service/                # business logic
  storage/                # local disk blob storage

scripts/
  install.sh              # systemd installation helper

docs/
  index.html              # project landing page
  screenshots/            # marketing screenshots
  desktop-api.md          # REST endpoints used by the desktop client

desktop/                  # Tauri desktop sync client (React + Rust)
  src/                    # frontend UI
  src-tauri/              # native shell, sync engine, API client
  package.json
  README.md               # build & dev instructions

mobile/                   # Expo React Native Android client
  src/                    # screens, navigation, API client, auth, crypto
  plugins/                # Expo config plugins (e.g. FreeDriveDownloads / MediaStore)
  assets/                 # app icon / splash (from FreeDrive logo)
  scripts/                # generate-assets.mjs, build-apk.ps1
  package.json
  README.md               # Expo Go + APK build instructions
```

---

## Deployment Options

Typical demo/production options:

- VPS (`Hetzner`, `DigitalOcean`, `AWS EC2`) with systemd
- Containerized self-managed deployment (custom Dockerfile)
- PaaS for demo environments (`Railway`, `Render`, `Fly.io`)

Recommended production baseline:

- Reverse proxy (`Caddy` or `Nginx`) with HTTPS
- Periodic backup for `FREEDRIVE_DATA_DIR`
- Strong admin password and rotated JWT secret policy
- Non-root runtime user when possible

---

## Operations

### Data You Should Back Up

At minimum:

- SQLite DB (`$FREEDRIVE_DATA_DIR/*.db`)
- Blob storage (`$FREEDRIVE_DATA_DIR` file hierarchy)
- JWT secret (`$FREEDRIVE_DATA_DIR/jwt_secret.key` if auto-generated)
- Admin settings snapshot (`data/settings.json` and optional backup output)

### Upgrading

1. Stop service
2. Replace binary
3. Start service
4. Check logs and health endpoint

```bash
sudo systemctl stop freedrive
# replace binary
sudo systemctl start freedrive
curl -s http://localhost:8080/api/v1/health
```

---

## Star History

[![Star History Chart](docs/star-history.svg)](https://www.star-history.com/?repos=abdullaabdullazade%2Ffreedrive&type=date&legend=top-left)

---

## Troubleshooting

### Service starts but UI fails

- Confirm process is running: `systemctl status freedrive`
- Check logs: `journalctl -u freedrive -f`
- Validate port mapping / firewall

### Login fails unexpectedly

- Verify JWT secret consistency across restarts
- Ensure system clock is correct
- Confirm refresh token table integrity
- Check whether your IP is blocked or not on the allowlist (Admin → Security)
- If **email** 2FA is required, confirm SMTP is configured and the code has not expired (10 minutes)
- If **authenticator** 2FA is required, enter the 6-digit app code or a one-time backup code from Security setup; use **Send code by email** only when that method is available

### Upload returns size/form errors

- Check `FREEDRIVE_MAX_UPLOAD_MB`
- Ensure reverse proxy request body limits are aligned
- Check admin `total_capacity_gb` if uploads fail with a capacity error

### Email / authenticator 2FA unavailable at sign-in

- Enroll an authenticator in web **Security** (QR + confirm), or enable email 2FA there
- Admin must configure SMTP under Admin → Settings → Email when email 2FA (or email fallback) is used
- Global `require_2fa` with neither TOTP nor SMTP configured returns an error asking users to enable 2FA in Security
- Backup codes are shown once at TOTP confirm — store them offline in case the phone is lost

### SMTP test/reset mail fails

- Re-check server/port/auth/TLS settings
- Verify sender domain policy (SPF/DKIM/relay restrictions)

---

## Contributing

Contributions are welcome.

Suggested workflow:

1. Fork repository
2. Create feature branch
3. Add/adjust tests where applicable
4. Submit focused PR with clear change summary

If you are proposing architecture-level changes, open an issue first for design alignment.

---

## Maintainer

FreeDrive is maintained by [Abdulla Abdullazade](https://github.com/abdullaabdullazade). Issues, releases, packages, and project documentation are managed through [`abdullaabdullazade/freedrive`](https://github.com/abdullaabdullazade/freedrive). Individual contributions remain attributed to their authors in the Git history.

---

## License

MIT License. See [LICENSE](LICENSE).
