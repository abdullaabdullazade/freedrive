# FreeDrive Desktop

Desktop sync client for [FreeDrive](https://github.com/marcinx98x/freedrive) — self-hosted cloud storage with a Drive-like web UI.

Part of the **FreeDrive monorepo** (`desktop/`). The server lives in the repo root (`cmd/freedrive`, `internal/`).

## Features

- **Sign in** to your FreeDrive server (JWT auth + 2FA support)
- **Single-instance** — a second launch focuses the existing main window
- **Onboarding wizard** — choose folders to sync (Desktop, Documents, Downloads, or custom)
- **Background sync** — uploads local changes, polls for remote changes; skips `.git`, `node_modules`, and `.svn` folders during scan; skips Office lock files (`~$…`), `desktop.ini`, `Thumbs.db`, and `*.tmp` in computer sync folders and My Drive; large encrypted uploads (>32 MiB) use resumable chunked API (Cloudflare-safe); each scan creates/restores remote folders for local subdirectories before uploading files
- **Transient errors retry** — local `error` rows are retried on the next scan (permanent `rejected` only are skipped); Home/Sync activity show a Drive-style progress ring around ↑ during upload
- **Local deletes → server trash** — removing a file from a sync folder (including Explorer Delete, which moves it out of the tree) soft-deletes the matching server file; periodic verify (~5 min) and post-upload same-name cleanup catch missed events and avoid live duplicates without deleting the only good copy before an upload succeeds
- **Authenticator 2FA** — version **0.1.8** accepts TOTP / backup codes at sign-in (setup stays in the web Security center) and can fall back to “Send code by email” when available
- **Start minimized** — version **0.1.9** can hide the main window to the system tray on cold start (Preferences → Launch); tray click / second instance still open the window
- **Duplicate event safe** — version **0.1.7** serializes uploads per local path, so browser download Create/Write/Rename bursts produce one remote file; only the current remote mapping may clean up older same-name copies
- **Server restart safe** — before a scan, Desktop checks `/health` and the authenticated session; while the server is offline/restarting it shows **Waiting for server** and does not enter scan/delete/upload reconciliation. Version **0.1.6** also preserves newer `sync_state` mappings when delayed delete journal entries recover
- **Server restores → local download** — a file restored from the Bin (or created from the web) is downloaded into the sync folder, also when the restore happened while the app was closed. Only items this computer previously synced (`sync_state` / folder mappings) can trigger a server delete, so untracked remote files are never re-trashed while waiting to download
- **Silent background verify** — on restart, verifies files in the background without a full UI rescan; if initial sync was never completed, startup resumes full sync with a “Resuming sync…” status
- **Home & Sync activity** — status dashboard inspired by Google Drive for desktop
- **Google Drive-style sidebar** — SVG icons for Home, Sync activity, and Notifications with alert badge; top bar uses matching SVG icons (pause/play, settings, help, lock)
- **Drive-like scrollbar** — transparent track, thin thumb only
- **Fixed window size** — main 1100×720 and Preferences 960×640 are not resizable
- **Help** — top bar, Settings menu, and Preferences header open [github.com/marcinx98x/freedrive](https://github.com/marcinx98x/freedrive)
- **Preferences window** — dedicated window opened from the gear icon: **My computer** (manage sync folders), **FreeDrive** (Windows Explorer / CfAPI status), **Settings** (encryption, launch on login, start minimized to tray, open sync log)
- **Notifications** — alerts for sync errors, paused sync, and storage warnings
- **Profile menu** — server avatar, storage bar from `GET /api/v1/me/storage` (`{used} of {total} used`, same as web), Manage storage, Sign out
- **Sign out** — stops CfAPI and clears contents of `%USERPROFILE%\FreeDrive\My Drive` (folder kept for next login)
- **Device identity** — reports the computer hostname and keeps a stable installation ID, so signing in again updates the same entry in the server's Devices list instead of creating a duplicate
- **Non-blocking sign-in** — crypto unlock, sync restore, and Explorer (CfAPI) start in the background so login does not block the UI
- **System tray** — minimize to tray, pause/resume sync from the menu
- **Windows Explorer integration** (Windows 10 1809+) — open `%USERPROFILE%\FreeDrive` in File Explorer while the desktop client is running; **My Drive** defaults to **Stream** (placeholders; download on open, free space on close). Optional **Mirror** keeps a full local copy. Poll removes local placeholders after remote Move to bin. After sign-in, **FreeDrive** is pinned in Explorer’s left navigation pane (CLSID NameSpace + SyncRootManager, app icon). Logout leaves that entry pinned; uninstall removes it.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) (for Tauri)
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload (Windows)
- **Windows 10 version 1809 or later** for Explorer Cloud Files (CfAPI) integration
- A running **FreeDrive server** (from repo root: `go run ./cmd/freedrive`)

Install Visual Studio Build Tools (C++ compiler + linker):

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Install Rust on Windows:

```powershell
winget install Rustlang.Rustup
```

Then restart your terminal and run `rustup default stable`.

## Development

1. Start the FreeDrive server (from **repo root**):

```bash
go run ./cmd/freedrive
```

2. Install dependencies and run the desktop app (from **`desktop/`**):

```bash
cd desktop
npm install
```

**Windows (recommended)** — uses MSVC environment automatically:

```cmd
scripts\dev.cmd
```

Or manually:

```bash
npm run tauri dev
```

> On Windows, `npm run tauri dev` requires the MSVC linker in PATH. If you see `link.exe not found`, use `scripts\dev.cmd` instead or open **Developer PowerShell for VS 2022**.

3. Sign in with `http://localhost:8080` and your account credentials.

## Build installer (Windows)

```cmd
scripts\dev.cmd build
```

Or from `desktop/`:

```bash
npm run build:exe:clean
```

Outputs (monorepo path):

- `desktop/src-tauri/target/release/freedrive-desktop.exe`
- `desktop/src-tauri/target/release/bundle/nsis/FreeDrive_<version>_x64-setup.exe`

> Only the **NSIS** target is built: it runs the uninstall hooks (CfAPI sync root, My Drive, `%APPDATA%\FreeDrive`), which MSI/WiX cannot do. A previous MSI install also forces a full uninstall on the reinstall page.

> Use **`npm run build:exe:clean`** after changing the logo — it regenerates icons and runs `cargo clean` so Windows embeds the new `.ico` in the exe. Do not run an old copy from `freedrive-app/`.

### Updating an existing install

Just run the new `FreeDrive_*_x64-setup.exe` (double-click). Same version or newer installs **in place** — no “uninstall previous version” prompt; sign-in, `%APPDATA%\FreeDrive\sync.db`, My Drive and Explorer registration are preserved.

```bash
npm run install:update
```

Same result via `/UPDATE` (useful in scripts). Files and app data are removed only when you uninstall from Windows Settings and check **Delete application data**.

| Action | Explorer/CfAPI registration | `~/FreeDrive/My Drive` + `%APPDATA%\FreeDrive` |
|--------|-----------------------------|-----------------------------------------------|
| Setup (same/newer version) | kept | kept |
| `install:update` (`/UPDATE`) | kept | kept |
| Uninstall, checkbox off | removed | kept |
| Uninstall, **Delete application data** | removed | removed |

## Releases

Desktop releases use tags **`desktop-v*`** (e.g. `desktop-v0.1.0`). Server releases use **`v*`** tags. See [`.github/workflows/release-desktop.yml`](../.github/workflows/release-desktop.yml).

## Troubleshooting

### Sync appears stuck or files do not upload

- Ensure the FreeDrive **server** is running and reachable at the URL you entered during sign-in (use a build that includes idempotent live `POST /folders` and rename-in-bin on name collision with trash — not auto-restore).
- Check **Sync activity** in the app for per-file errors; upload rows show a progress ring while transferring.
- Transient failures are retried automatically on the next scan/verify — you do **not** need to wipe `%APPDATA%\FreeDrive` after a server update.
- Check `%APPDATA%\FreeDrive\sync.log` for detailed sync steps (`ensure remote folder`, `file start`, `create_folder … failed`).
- Do not run the app as Administrator (different `%APPDATA%` profile).

### Deleted locally but still on the server

- Soft-delete on the server can take a few seconds (journal). Look for `Removed from cloud` in Sync activity or `file_delete` lines in `sync.log`.
- Explorer Delete moves the file out of the sync tree; the client treats that as a local delete. If an event was missed, the next periodic verify (~5 min) or app restart should soft-delete orphans.
- Re-uploading the same name after a missed delete used to leave two live files; the client now uploads first, stores the new remote ID, then trashes only older same-name siblings.

### New downloaded file appears multiple times in Bin

- Fixed in **0.1.7**. Browsers can emit Create, Write, and Rename events for one completed download; earlier builds could upload all events concurrently, then each upload worker trashed the other fresh copies.
- Uploads are now serialized per canonical local path. A duplicate event waits for the first upload, sees matching `sync_state`, and exits unchanged. Same-name cleanup also runs only if that upload still owns the current remote mapping.

### Restored from Bin but the file goes back to the Bin

- Fixed in **0.1.4**. Earlier builds treated “on the server but missing locally” as a local delete, so a file restored while the app was closed was soft-deleted again on the next launch (`missing locally, queued server delete` in `sync.log`).
- Now a server delete is queued only for paths this computer already tracks. Restored or web-created files have no `sync_state` row yet, so they are downloaded instead — look for `restored, downloading` and `applied remote file` in `sync.log`, plus a `Restored from cloud` row in Sync activity.
- If you are on an older build, update with the new setup (see [Updating an existing install](#updating-an-existing-install)) before retesting.

### Server restarted while Desktop was running — files appeared in Trash

- Fixed fully in **0.1.6**. Version 0.1.5 stopped network/5xx folder probes from becoming mass deletes, but a delayed same-name delete could still erase a newer local `sync_state` mapping and trigger repeated re-uploads into Trash.
- Desktop now gates every full scan on `/health` plus `/me`, serializes and backs off the delete journal during outages, deletes local state only when its remote ID still matches the journal target, and runs same-name cleanup only after a successful upload while preserving the new remote ID.
- Update Desktop to **0.1.6+** before testing another server restart.

### Encryption notes

- Desktop uploads use **AES-GCM-256** (same contract as the web UI).
- Encryption keys are stored locally in `%APPDATA%\FreeDrive\sync.db`.
- Files uploaded from the **web browser** may not decrypt on desktop unless the key was stored on this PC.

### Windows Explorer (FreeDrive sync root)

- Sign in and keep the desktop app running (system tray).
- Open File Explorer and go to `%USERPROFILE%\FreeDrive` (or use **Open Drive folder** in the app).
- Open **My Drive** inside that folder to browse cloud content.
- **Stream (default):** placeholders only — a file downloads when you open it, uploads on save/close, then frees local disk space again (like Google Drive for desktop streaming). The whole My Drive folder is **not** kept on disk.
- **Mirror (optional):** Preferences → FreeDrive → Mirror files keeps a full local copy under `~/FreeDrive/My Drive` (uses disk space; good for offline).
- **Explorer nav pane:** after a successful provider connect, Windows shows a pinned **FreeDrive** entry (branded icon) in the left sidebar via CLSID `Desktop\NameSpace` + SyncRootManager. Connect always refreshes `IconResource` / `DefaultIcon` (so NSIS updates pick up the new exe). **Sign out** disconnects the provider but **keeps** the sidebar pin; **uninstall** (NSIS) removes NameSpace + SyncRootManager keys. Prefer **Unregister Explorer integration** in settings only when recovering a broken registration.
- Requires **Windows 10 1809+**. CfAPI connects synchronously on startup / login (`connect-first` recovery if Windows already has the sync root registered).
- Integration state lives in `%APPDATA%\FreeDrive\sync.db` (`cf_sync_root_registered`, `cf_finalize_complete`, `cf_shell_registered`). Updating or reinstalling the app does not reset a working registration.
- Hydrate cache (temporary plaintext while a file is open): `%APPDATA%\FreeDrive\hydrate_cache` — cleared when Stream frees space after close.

#### CfAPI recovery (`0x80070057` / “cloud file provider is not running”)

If Explorer shows *cloud file provider is not running* or the terminal logs `CfRegisterSyncRoot failed: 0x80070057`, local DB state may be out of sync with Windows. The app now auto-recovers on startup (connect-first). For manual recovery:

```powershell
# Option A — restore DB flag (when Windows still has the sync root registered)
@'
import sqlite3
c = sqlite3.connect(r"%APPDATA%\FreeDrive\sync.db")
c.execute("INSERT OR REPLACE INTO app_config (key, value) VALUES ('cf_sync_root_registered', 'true')")
c.commit()
print("ok")
'@ | python -
```

Restart the app (`npm run tauri dev` or the installed build). Check `%APPDATA%\FreeDrive\sync.log` for `cfapi: explorer integration started`.

```text
# Option B — full reset via Tauri devtools console (app must be running)
await window.__TAURI__.core.invoke('unregister_explorer_integration')
```

Then restart the app for a clean re-registration.

### `link.exe` not found

Install MSVC Build Tools (see Prerequisites), restart the terminal, or use `scripts\dev.cmd`.

### WebView2

```powershell
winget install Microsoft.EdgeWebView2Runtime
```

## Architecture

| Layer | Stack |
|-------|-------|
| UI | React + TypeScript + Vite |
| Native | Tauri 2 (Rust) |
| Local state | SQLite (`%APPDATA%/FreeDrive/sync.db`) |
| Credentials | `%APPDATA%/FreeDrive/auth.json` |
| Sync | `notify` file watcher + REST API |

## API integration

See [`docs/desktop-api.md`](../docs/desktop-api.md) for the endpoint list used by this client.

## Data locations

App state uses **`%APPDATA%\FreeDrive`**, not `%APPDATA%\com.freedrive.desktop` (Tauri `identifier` / BUNDLEID). NSIS uninstall hooks must clean `FreeDrive` explicitly.

| Path | Purpose |
|------|---------|
| `%APPDATA%/FreeDrive/sync.db` | Sync state database |
| `%APPDATA%/FreeDrive/auth.json` | Session tokens |
| `%APPDATA%/FreeDrive/sync.log` | Sync debug log |
| `%APPDATA%/FreeDrive/hydrate_cache/` | Temporary plaintext while opening My Drive files (Stream) |
| `%USERPROFILE%/FreeDrive/` | CfAPI sync root (Windows Explorer provider) |
| `%USERPROFILE%/FreeDrive/My Drive/` | My Drive view — placeholders in Stream; full copies in Mirror |

## License

MIT — same as the FreeDrive server project.

## CI and releases

Desktop changes run frontend typechecking/builds, frontend tests, and Rust tests
in `Desktop CI`. A `vX.Y.Z` tag builds Windows NSIS, Linux AppImage/DEB, and
macOS app/DMG packages and uploads them to the same GitHub Release as the server
and mobile artifacts. Legacy `desktop-vX.Y.Z` tags remain supported.

When `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and
`TAURI_UPDATER_PUBLIC_KEY` repository secrets are configured, release builds
also publish signed updater metadata. Without them, CI still publishes unsigned
installers and clearly reports that state in the workflow log.
