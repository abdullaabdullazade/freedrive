# Releasing FreeDrive

FreeDrive uses one semantic-version tag for the server, mobile app, and desktop
clients. Create the tag only after the target commit has passed the pull request
checks on the default branch.

## Publish a release

```bash
git switch master
git pull --ff-only
git tag -a v1.1.0 -m "FreeDrive v1.1.0"
git push origin v1.1.0
```

The `vX.Y.Z` tag starts these workflows:

- `Build And Release Binaries` — Linux and Windows server binaries + checksums
- `Mobile Release` — Android APK + SHA-256 checksum
- `Desktop Release` — Windows NSIS, Linux AppImage/DEB, macOS app/DMG, and
  updater metadata when signing is configured
- `Build And Publish Docker Image` — tagged GHCR image and optional Docker Hub
  image

All downloadable assets are attached to the same `FreeDrive vX.Y.Z` GitHub
Release. Do not create or move the tag until all required CI checks pass.

## Signing secrets

Desktop updater signing is enabled when these GitHub Actions repository secrets
exist:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `TAURI_UPDATER_PUBLIC_KEY`

Without them, desktop installers are still built and uploaded, but updater
metadata is omitted and the workflow prints a warning.

The mobile workflow currently creates a sideloadable APK using Expo's generated
debug keystore. Before Play Store distribution, configure a persistent Android
release keystore and preserve an offline backup; changing that key prevents
users from installing upgrades over an existing app.

## Manual retry

Each release workflow supports `workflow_dispatch` with the same existing
`vX.Y.Z` tag. Use that only to retry a failed workflow; do not use a different
commit under an already published tag.
