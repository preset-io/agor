#!/bin/sh
set -e

echo "🚀 Starting Agor production environment..."

# Fix volume permissions (volumes may be created with wrong ownership)
# Only chown .agor directory (not .ssh which is mounted read-only)
mkdir -p /home/agor/.agor
sudo chown -R agor:agor /home/agor/.agor

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

# Display admin credentials for first-time setup
echo ""
echo "=========================================="
echo "🔐 Admin Credentials"
echo "=========================================="
echo "Email:    admin@agor.live"
echo "Password: admin"
echo ""
echo "⚠️  CHANGE PASSWORD AFTER FIRST LOGIN!"
echo "=========================================="
echo ""

# Start daemon in foreground (this keeps container alive)
echo "🚀 Starting daemon on port ${DAEMON_PORT:-3030}..."
exec agor-daemon
