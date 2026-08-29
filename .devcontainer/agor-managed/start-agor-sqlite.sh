#!/usr/bin/env bash
set -euo pipefail

# GitHub supplies these values inside every Codespace. Validate before using
# them to construct browser-facing URLs or an environment label.
: "${CODESPACE_NAME:?GitHub Codespaces did not set CODESPACE_NAME}"
if [[ ! "$CODESPACE_NAME" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "Invalid CODESPACE_NAME" >&2
  exit 1
fi

port_domain="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
if [[ ! "$port_domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "Invalid GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN" >&2
  exit 1
fi

daemon_url="https://${CODESPACE_NAME}-3000.${port_domain}"
ui_url="https://${CODESPACE_NAME}-5000.${port_domain}"

# The nested Compose project owns a SQLite volume inside this Codespace. Ports
# remain GitHub-private; the launcher never changes their visibility to public.
echo "[agor-codespaces] Building and starting the SQLite Compose stack..."
env \
  UID="$(id -u)" \
  GID="$(id -g)" \
  INSTANCE_LABEL="codespace-${CODESPACE_NAME}" \
  DAEMON_PORT=3000 \
  UI_PORT=5000 \
  AGOR_BASE_URL="$ui_url" \
  VITE_DAEMON_URL="$daemon_url" \
  CORS_ORIGIN="$ui_url" \
  AGOR_MIGRATION_OFFLINE_CUTOVER=true \
  SEED=true \
  docker compose -p agor-codespaces-sqlite up -d --build

echo "[agor-codespaces] Compose launch finished. Current service state:"
docker compose -p agor-codespaces-sqlite ps
echo "[agor-codespaces] Bootstrap complete; the launcher is waiting for the remote /health endpoint."
