#!/bin/sh
set -e

echo "🚀 Starting Agor development environment..."

# Fix volume permissions FIRST (before any operations)
# Mounted volumes may be created with wrong ownership, causing EACCES errors
echo "🔧 Fixing volume permissions..."
sudo chown -R agor:agor /app

# Sync dependencies to match the mounted pnpm-lock.yaml
# This ensures each worktree gets its exact dependencies, even if the Docker image
# was built from a different worktree with different dependencies
echo "📦 Syncing dependencies with pnpm-lock.yaml..."
pnpm install

# Initialize husky git hooks (required for git commit hooks)
echo "🎣 Initializing git hooks..."
pnpm husky install

# Start @agor/core in watch mode FIRST (for hot-reload during development)
# We start this early and wait for initial build before running CLI commands
echo "🔄 Starting @agor/core watch mode..."
pnpm --filter @agor/core dev &
CORE_PID=$!

# Wait for initial watch build to complete
# tsup --watch does a full build on startup, then watches for changes
echo "⏳ Waiting for @agor/core initial build..."
while [ ! -f "/app/packages/core/dist/index.js" ] || [ ! -f "/app/packages/core/dist/utils/logger.js" ]; do
  sleep 0.1
done
echo "✅ @agor/core build ready"

# Fix volume permissions (volumes may be created with wrong ownership)
# Only chown .agor directory (not .ssh which is mounted read-only)
mkdir -p /home/agor/.agor
sudo chown -R agor:agor /home/agor/.agor

# Initialize database and configure daemon settings for Docker
# (idempotent: creates database on first run, preserves JWT secrets on subsequent runs)
echo "📦 Initializing Agor environment..."
pnpm agor init --skip-if-exists --set-config --daemon-port "${DAEMON_PORT:-3030}" --daemon-host localhost

# Always create/update admin user (safe: only upserts)
echo "👤 Ensuring default admin user exists..."
pnpm --filter @agor/cli exec tsx bin/dev.ts user create-admin --force

# Run seed script if SEED=true (idempotent: only runs if no data exists)
if [ "$SEED" = "true" ]; then
  echo "🌱 Seeding development fixtures..."
  pnpm tsx scripts/seed.ts --skip-if-exists
fi

# Start daemon in background (use dev:daemon-only to avoid duplicate core watch)
# Core watch is already running above, daemon just runs tsx watch
echo "🚀 Starting daemon on port ${DAEMON_PORT:-3030}..."
PORT="${DAEMON_PORT:-3030}" pnpm --filter @agor/daemon dev:daemon-only &
DAEMON_PID=$!

# Wait a bit for daemon to start
sleep 3

# Start UI in foreground (this keeps container alive)
echo "🎨 Starting UI on port ${UI_PORT:-5173}..."
VITE_DAEMON_PORT="${DAEMON_PORT:-3030}" pnpm --filter agor-ui dev --host 0.0.0.0 --port "${UI_PORT:-5173}"

# If UI exits, kill both daemon and core watch
kill $DAEMON_PID 2>/dev/null || true
kill $CORE_PID 2>/dev/null || true
