#!/usr/bin/env bash
set -euo pipefail



REPO="${FREEDRIVE_REPO:-abdullaabdullazade/freedrive}"
RELEASE_BASE_URL="https://github.com/${REPO}/releases/latest/download"
APP_DIR="/opt/freedrive"
BIN_PATH="$APP_DIR/freedrive"
DATA_DIR="/var/lib/freedrive"
ENV_FILE="/etc/freedrive/freedrive.env"
SERVICE_FILE="/etc/systemd/system/freedrive.service"
TMP_DIR="$(mktemp -d)"
TMP_BIN="${TMP_DIR}/freedrive-linux-amd64"
TMP_SUMS="${TMP_DIR}/checksums.txt"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer supports Linux only."
  exit 1
fi

if [[ "$(uname -m)" != "x86_64" && "$(uname -m)" != "amd64" ]]; then
  echo "This installer currently supports amd64 only."
  exit 1
fi

ADMIN_EMAIL=""
while [[ -z "${ADMIN_EMAIL}" ]]; do
  read -rp "Admin email: " ADMIN_EMAIL || exit 1
  if [[ -z "${ADMIN_EMAIL}" ]]; then
    echo "Admin email is required. Please enter a valid email."
  fi
done

ADMIN_PASSWORD=""
while [[ -z "${ADMIN_PASSWORD}" ]]; do
  read -rsp "Admin password: " ADMIN_PASSWORD || exit 1
  echo
  if [[ -z "${ADMIN_PASSWORD}" ]]; then
    echo "Admin password is required. Please enter a valid password."
  fi
done

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required."
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required."
  exit 1
fi

echo "Downloading FreeDrive release binary..."
curl -fsSL "${RELEASE_BASE_URL}/freedrive-linux-amd64" -o "$TMP_BIN"
curl -fsSL "${RELEASE_BASE_URL}/checksums.txt" -o "$TMP_SUMS"

EXPECTED_SHA="$(awk '/freedrive-linux-amd64$/ {print $1; exit}' "$TMP_SUMS" | sed 's/^sha256://')"
if [[ -z "${EXPECTED_SHA}" ]]; then
  echo "Could not find checksum for freedrive-linux-amd64 in checksums.txt"
  exit 1
fi

ACTUAL_SHA="$(sha256sum "$TMP_BIN" | awk '{print $1}')"
if [[ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]]; then
  echo "Checksum verification failed."
  echo "Expected: ${EXPECTED_SHA}"
  echo "Actual:   ${ACTUAL_SHA}"
  exit 1
fi
echo "Checksum verified."

echo "Installing files..."
sudo mkdir -p "$APP_DIR" "$DATA_DIR" /etc/freedrive
sudo install -m 0755 "$TMP_BIN" "$BIN_PATH"

JWT_SECRET="$(openssl rand -hex 32)"

sudo tee "$ENV_FILE" >/dev/null <<ENV
FREEDRIVE_PORT=8080
FREEDRIVE_DATA_DIR=$DATA_DIR
FREEDRIVE_JWT_SECRET=$JWT_SECRET
FREEDRIVE_MAX_UPLOAD_MB=5120
FREEDRIVE_ADMIN_EMAIL=$ADMIN_EMAIL
FREEDRIVE_ADMIN_PASSWORD=$ADMIN_PASSWORD
ENV
sudo chmod 600 "$ENV_FILE"

sudo tee "$SERVICE_FILE" >/dev/null <<SERVICE
[Unit]
Description=FreeDrive Service
After=network.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=$BIN_PATH
Restart=always
RestartSec=3
User=root
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
SERVICE

echo "Enabling and starting systemd service..."
sudo systemctl daemon-reload
sudo systemctl enable freedrive.service
sudo systemctl restart freedrive.service

sudo systemctl --no-pager --full status freedrive.service || true

echo
echo "FreeDrive is installed and running in background via systemd."
echo "Open: http://localhost:8080"
echo "Logs: sudo journalctl -u freedrive -f"
