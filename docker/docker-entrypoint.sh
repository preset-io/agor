#!/bin/sh
set -e

echo "🚀 Starting Agor development environment..."

# Fix permissions for build output directories only (not the entire /app tree!)
# The bind mount (.:/app) is read-only for most files - we only need write access to dist/
# This avoids expensive chown -R on node_modules volume (1700+ packages!)
echo "🔧 Ensuring write access to build output directories..."
sudo chown -R agor:agor /app/packages/*/dist /app/apps/*/dist 2>/dev/null || true
echo "✅ Build directories writable"

# Smart dependency sync: recreate workspace symlinks
# The named volume preserves /app/node_modules/.pnpm/ (dependency store)
# BUT the bind mount (.:/app) provides package.json files from host
# So we need to run pnpm install to recreate workspace symlinks in packages/*/node_modules/
echo "📦 Syncing workspace dependencies..."

# Check if we need to reinstall (lockfile changed)
if [ ! -f "/app/node_modules/.synced-lockfile.yaml" ]; then
  # First run or volume was cleared
  echo "🔄 Installing dependencies and creating workspace symlinks..."
  CI=true pnpm install --frozen-lockfile < /dev/null
  cp /app/pnpm-lock.yaml /app/node_modules/.synced-lockfile.yaml
  echo "✅ Dependencies installed"
elif ! cmp -s /app/pnpm-lock.yaml /app/node_modules/.synced-lockfile.yaml; then
  # Lockfile changed - full reinstall
  echo "🔄 pnpm-lock.yaml changed - reinstalling dependencies..."
  CI=true pnpm install --frozen-lockfile < /dev/null
  cp /app/pnpm-lock.yaml /app/node_modules/.synced-lockfile.yaml
  echo "✅ Dependencies synced"
else
  # Lockfile unchanged - just recreate workspace symlinks (fast ~1s)
  echo "🔗 Recreating workspace symlinks (lockfile unchanged)..."
  CI=true pnpm install --frozen-lockfile --offline < /dev/null
  echo "✅ Workspace symlinks ready"
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
# We need to wait for both .js files AND .d.ts files to avoid TypeScript race conditions
echo "⏳ Waiting for @agor/core initial build..."
while [ ! -f "/app/packages/core/dist/index.js" ] || [ ! -f "/app/packages/core/dist/utils/logger.js" ]; do
  sleep 0.1
done
echo "⏳ Waiting for @agor/core type definitions..."
while [ ! -f "/app/packages/core/dist/api/index.d.ts" ]; do
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

  # Add executor_unix_user to existing execution section (only if not already present)
  if ! grep -q "executor_unix_user" /home/agor/.agor/config.yaml 2>/dev/null; then
    # Use sed to add executor_unix_user under the existing execution: section
    sed -i '/^execution:/a\  executor_unix_user: agor_executor' /home/agor/.agor/config.yaml
    echo "✅ Executor Unix user configured"
  else
    echo "✅ Executor Unix user already configured"
  fi
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
