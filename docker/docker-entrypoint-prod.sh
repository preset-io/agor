#!/bin/sh
set -e

echo "🚀 Starting Agor production environment..."

# Fix volume permissions (volumes may be created with wrong ownership)
# Only chown .agor directory (not .ssh which is mounted read-only)
mkdir -p /home/agor/.agor
sudo -n chown -R agor:agor /home/agor/.agor

# Initialize database and configure daemon settings
# --skip-if-exists: Idempotent, won't overwrite existing database
# --set-config: Always update daemon config (for Docker networking)
echo "📦 Initializing Agor environment..."
agor init \
  --skip-if-exists \
  --set-config \
  --daemon-port "${DAEMON_PORT:-3030}" \
  --daemon-host "${DAEMON_HOST:-0.0.0.0}"

# Create/update admin user (idempotent: safe to run multiple times)
# This will skip if admin user already exists
echo "👤 Ensuring admin user exists..."
agor user create-admin 2>/dev/null || true

# SECURITY: do not echo the default admin credentials to stdout — container
# log aggregators ingest stdout and make it searchable across the org.
# Emit a short warning to stderr only, and only once per container start.
# Operators can retrieve the bootstrap credentials via an authenticated
# `agor user ...` CLI invocation inside the container.
>&2 printf '\033[1;31m%s\033[0m\n' "⚠️  Admin user exists with the default bootstrap password."
>&2 printf '\033[1;31m%s\033[0m\n' "⚠️  ROTATE IT NOW via the UI or: docker exec <container> agor user set-password"

# Start daemon in foreground (this keeps container alive)
echo "🚀 Starting daemon on port ${DAEMON_PORT:-3030}..."
exec agor-daemon
