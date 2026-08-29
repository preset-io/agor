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

# This preview can deliberately publish both forwarded ports. Never expose the
# repository-wide development default (admin/admin): create a per-Codespace,
# mode-0600 bootstrap secret outside the Git workspace and reuse it across
# stop/start cycles. The value is passed only through the nested Compose
# process environment and is never printed.
credentials_dir="${HOME:?}/.agor-managed"
admin_password_file="${credentials_dir}/bootstrap-admin-password"
mkdir -p "$credentials_dir"
chmod 700 "$credentials_dir"
if [[ ! -s "$admin_password_file" ]]; then
  generated_password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  if [[ ! "$generated_password" =~ ^[a-f0-9]{48}$ ]]; then
    echo "Could not generate the Codespaces bootstrap admin password" >&2
    exit 1
  fi
  if (set -o noclobber; printf '%s\n' "$generated_password" >"$admin_password_file") 2>/dev/null; then
    chmod 600 "$admin_password_file"
  fi
  unset generated_password
fi
admin_password="$(tr -d '\r\n' <"$admin_password_file")"
if [[ ! "$admin_password" =~ ^[a-f0-9]{48}$ ]]; then
  echo "Invalid Codespaces bootstrap admin password file" >&2
  exit 1
fi

# The nested Compose project owns a SQLite volume inside this Codespace. Ports
# begin GitHub-private. The launcher may publish them only after its SSH health
# probe succeeds, and repeats that reconciliation after every provider restart.
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
  AGOR_ADMIN_PASSWORD="$admin_password" \
  AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN=false \
  AGOR_MIGRATION_OFFLINE_CUTOVER=true \
  SEED=true \
  docker compose -p agor-codespaces-sqlite up -d --build
unset admin_password

echo "[agor-codespaces] Compose launch finished. Current service state:"
docker compose -p agor-codespaces-sqlite ps
echo "[agor-codespaces] Bootstrap admin credential: $admin_password_file (mode 600; change it after first login)."
echo "[agor-codespaces] Bootstrap complete; the launcher is waiting for the remote /health endpoint."
