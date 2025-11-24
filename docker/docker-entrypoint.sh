#!/bin/sh
set -e

echo "🚀 Starting Agor development environment..."

# Fix volume permissions only if needed (defensive, but usually unnecessary with anonymous volumes)
# On most systems, Docker handles ownership correctly, but some Linux setups may need this
if [ "$(stat -c '%U' /app)" != "agor" ]; then
  echo "🔧 Fixing volume permissions..."
  sudo chown -R agor:agor /app
else
  echo "✅ Volume permissions already correct"
fi

# Smart dependency sync: check if pnpm-lock.yaml changed
# Anonymous volumes preserve Docker-built node_modules directly (no copy needed!)
# Only run pnpm install if user modified dependencies
echo "📦 Checking dependencies..."

# Create marker file on first run
if [ ! -f "/app/node_modules/.synced-lockfile.yaml" ]; then
  echo "✅ Using Docker-built dependencies (no copy needed)"
  cp /app/pnpm-lock.yaml /app/node_modules/.synced-lockfile.yaml
elif ! cmp -s /app/pnpm-lock.yaml /app/node_modules/.synced-lockfile.yaml; then
  # Only install if lockfile changed (user added/removed dependencies)
  echo "🔄 pnpm-lock.yaml changed - syncing dependencies..."
  CI=true pnpm install --frozen-lockfile < /dev/null
  cp /app/pnpm-lock.yaml /app/node_modules/.synced-lockfile.yaml
  echo "✅ Dependencies synced"
else
  echo "✅ Dependencies up-to-date"
fi

# Skip husky in Docker (git hooks run on host, not in container)
# Also avoids "fatal: not a git repository" error with worktrees where .git is a file, not a directory
# If you need hooks in the container, run `pnpm husky install` manually after startup
echo "⏭️  Skipping husky install (git hooks run on host, not in container)"

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

# Build executor package (needed for spawning executor subprocess)
echo "🔄 Building @agor/executor..."
pnpm --filter @agor/executor build
echo "✅ @agor/executor build ready"

# Fix volume permissions (volumes may be created with wrong ownership)
# Only chown .agor directory (not .ssh which is mounted read-only)
mkdir -p /home/agor/.agor
sudo chown -R agor:agor /home/agor/.agor

# Initialize database and configure daemon settings for Docker
# (idempotent: creates database on first run, preserves JWT secrets on subsequent runs)
echo "📦 Initializing Agor environment..."
pnpm agor init --skip-if-exists --set-config --daemon-port "${DAEMON_PORT:-3030}" --daemon-host localhost

# Run database migrations (idempotent: safe to run on every start)
# This ensures schema is up-to-date even when using existing database volumes
# Use --yes to skip confirmation prompt in non-interactive Docker environment
echo "🔄 Running database migrations..."
pnpm agor db migrate --yes

# Configure executor Unix user isolation if enabled
if [ "$AGOR_USE_EXECUTOR" = "true" ]; then
  echo "🔒 Enabling executor Unix user isolation..."
  echo "   Executor will run as: ${AGOR_EXECUTOR_USERNAME:-agor_executor}"

  # Add executor config to ~/.agor/config.yaml
  cat >> /home/agor/.agor/config.yaml <<EOF
execution:
  executor_unix_user: ${AGOR_EXECUTOR_USERNAME:-agor_executor}
EOF
  echo "✅ Executor Unix user configured"
fi

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
