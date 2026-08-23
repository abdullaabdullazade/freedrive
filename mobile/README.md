# FreeDrive Mobile

React Native + Expo client for [FreeDrive](https://github.com/marcinx98x/freedrive). Android-first. Sign in to your self-hosted server and browse My Drive, Computers, Starred, Shared, Recent, and Bin.

Part of the **FreeDrive monorepo** (`mobile/`). The server lives in the repo root (`cmd/freedrive`, `internal/`).

## Features

- **Sign in** — server URL, email, password, and 2FA (authenticator or email) when enabled
- **Secure session** — tokens in SecureStore, profile cache in AsyncStorage (supports large avatar data-URLs), auto-refresh on 401
- **Bottom tabs** — Home, Starred, Shared, Files (with active pill indicator) on phone portrait (and tablet portrait)
- **Landscape NavRail** — when width > height: narrow left rail (menu ≡, Create `+`, then Home / Starred / Shared / Files vertically centered like Google Drive); bottom tabs hidden; Create FAB hidden (rail `+` → Upload / Folder); hamburger on the rail, not in the search bar
- **Files stack** — Files tab hosts My Drive home + nested Folder screens (Drive-like); Shared can deep-link into a folder under Files
- **Files** — My Drive | Computers, folder navigation, list/grid, sort chip; folder listings use server pagination and load more on scroll (same contract as web/desktop)
- **Grid tiles** — square previews (`aspectRatio: 1`); column count scales with content width so landscape tiles stay phone-sized
- **Create FAB** — Camera, Folder, Upload, Spreadsheet (`.xlsx`), and Document (`.txt`) on Files / Folder; camera photos are encrypted before upload; FAB respects safe-area insets and landscape NavRail uses the same actions
- **Upload** — multi-file picker; client-side AES-GCM encrypt, write ciphertext to cache, then upload (multipart under 32 MiB; resumable 8 MiB chunks above that for Cloudflare)
- **New folder** — dialog → `POST /api/v1/folders` in the current folder (or My Drive root)
- **New Document / Spreadsheet** — encrypted empty `Document.txt` / `Spreadsheet.xlsx`; Document opens in the text editor; Spreadsheet opens in the in-app sheet grid
- **Drawer** — hamburger slides in Recent, Activity, Offline, Approvals, Bin, Settings, Help, and Storage
- **Search** — search files by name from the top bar
- **Branding** — same FreeDrive logo as desktop (`scripts/generate-assets.mjs`); SVG icons aligned with desktop `NavIcons`
- **User avatar** — photo from `avatar_url` on `GET /api/v1/me`, or initials fallback
- **Profile menu** — avatar, account settings, sign out, native storage management, privacy notice, and terms without leaving the app
- **Native account settings** — change display name/avatar, email 2FA, mobile sign-in approvals, authenticator setup/disable with backup codes, email-change confirmation, and signed-in device/session revocation
- **Native support pages** — in-app Help and feedback, Privacy policy, and Terms of service; feedback diagnostics can be copied without passwords or encryption keys
- **Devices** — appears as `Mobile (…)` and keeps a stable installation ID, so re-login updates the same entry in the account Devices list instead of creating a duplicate
- **File actions** — sharing, access management, public links, downloading, offline copies, starring, comments, version history/restore, approval requests, rename, move, information, and **Move to bin**
- **Bin management** — restore individual files/folders, permanently delete them, or empty the entire bin after confirmation
- **Approvals** — request file approval by email and approve/reject requests assigned to the signed-in user
- **Client-side decryption** — account and per-file keys sync from the server so encrypted files can be opened on Android; larger files download to disk and decrypt via native AES-GCM (avoids JS heap OOM)
- **In-app preview** — images, video, audio, PDF, spreadsheets (`.xlsx` / `.xls` / `.csv`), and text/code/config files including Markdown, JSON, YAML, Python, JavaScript, TypeScript, shell, Rust, Go, Java, C/C++, and common project files
- **Offline files** — store decrypted local copies explicitly, browse them without a connection, open them locally, and remove the offline copy without deleting the server file
- **Large media limit** — images/videos **over 100 MiB** are not opened in the in-app player (avoids crashes); tapping shows Save / Share / Cancel instead
- **Spreadsheet editor** — SheetJS grid with formula bar and sheet tabs; Edit / Save re-encrypts and uploads via `POST /api/v1/files/{id}/content` (same path as text)
- **Image gallery** — swipe left/right between photos in the same loaded list (Folder / Files / Starred / Home); counter shows position; neighbors decrypt in the background (skips files over the preview size limit); bottom counter and image pad above the Android system nav bar
- **Video gallery** — same swipe between videos in the loaded list; only the active page mounts the player; bottom controls respect Android safe-area insets
- **Text / spreadsheet / PDF** — FilePreview text editor, sheet tabs, and PDF actions also pad for the system nav bar
- **Text edit** — Edit / Save on text previews; content is re-encrypted and uploaded via the same native multipart helper (`POST /api/v1/files/{id}/content`)
- **Image rotate** — Rotate (90°) in the preview header, then Save to replace the file on the server (same content endpoint)
- **Share a copy** — opens the Android share sheet with the decrypted file
- **Download** — native HTTP stream + MediaStore save via `FreeDriveDownloads` (progress shows MB/total for large files); stream decrypt + copy from decrypted path; ongoing download notification then tappable “Download complete”; Android 13+ asks for notification permission
- **Status notifications** — no persistent “app is running” icon (not appropriate for a Drive client); status-bar presence only for downloads and while a video is playing (media session / native controls)

Server administration stays in the web admin panel. Platform-specific office-suite co-editing and PDF annotation are not implemented; FreeDrive can still decrypt, preview, download, or hand those files to an installed native app.

## Requirements

- Node.js 20+
- Expo Go on Android (same Wi-Fi as the server, or a public HTTPS URL)
- For APK builds: Android SDK + JDK 17

## Setup (Expo Go)

```bash
cd mobile
npm install
npm start
```

Scan the QR code with Expo Go.

## Sign-in

1. Enter your FreeDrive server URL (e.g. `https://drive.example.com` or `http://192.168.x.x:8080`)
2. Email + password
3. Complete 2FA if enabled (authenticator code, backup code, or email code)

## Scripts

```bash
npm start          # Expo dev server
npm run android    # open Android
npm run typecheck  # tsc --noEmit
node scripts/generate-assets.mjs   # regenerate icon/splash from desktop logo
```

## Build release APK

**Canonical procedure (Windows):** always build from `C:\fdm`, copy to `mobile\dist\FreeDrive-1.0.0.apk`. Do not build from `Desktop\Projekty\...` (CMake MAX_PATH).

### Routine rebuild (TS/UI changes, ~1–5 min)

```powershell
powershell -File mobile\scripts\build-apk.ps1
```

Manual steps (same as the script):

```powershell
robocopy "C:\Users\marci\Desktop\Projekty\freedrive-master\mobile" "C:\fdm" /E /XD node_modules android .expo dist
$env:CI = "1"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot"
cd C:\fdm\android
.\gradlew.bat assembleRelease
Copy-Item "C:\fdm\android\app\build\outputs\apk\release\app-release.apk" "C:\Users\marci\Desktop\Projekty\freedrive-master\mobile\dist\FreeDrive-1.0.0.apk" -Force
```

Do **not** run `expo prebuild` on every rebuild — only when `C:\fdm\android` is missing or **native** config changed (`app.json` plugins, new Expo native module such as `expo-image-manipulator`, or `plugins/with-freedrive-downloads/`).

### First build or native changes only

```powershell
powershell -File mobile\scripts\build-apk.ps1 -Clean
```

Or after syncing to `C:\fdm`: `npx expo prebuild --platform android`, then `gradlew assembleRelease`.

APK output for install: `mobile\dist\FreeDrive-1.0.0.apk` (debug-signed unless you configure a release keystore).
