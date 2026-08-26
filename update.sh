#!/usr/bin/env bash
set -euo pipefail

REPO="${FREEDRIVE_REPO:-abdullaabdullazade/freedrive}"
RAW_UPDATE_URL="https://raw.githubusercontent.com/${REPO}/master/scripts/update.sh"
TMP_SCRIPT="$(mktemp /tmp/freedrive-update-XXXXXX.sh)"

cleanup() {
  rm -f "$TMP_SCRIPT"
}
trap cleanup EXIT

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required."
  exit 1
fi

echo "Downloading updater from ${RAW_UPDATE_URL} ..."
curl -fsSL "$RAW_UPDATE_URL" -o "$TMP_SCRIPT"
chmod +x "$TMP_SCRIPT"
exec bash "$TMP_SCRIPT"
