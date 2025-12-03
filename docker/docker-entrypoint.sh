#!/bin/sh
set -e

echo "🚀 Starting Agor development environment..."

# Dependencies are baked into the Docker image and preserved via anonymous volumes
# No pnpm install needed at runtime - this is the key to fast startups!
echo "✅ Using pre-built dependencies from Docker image"

# Fix permissions for build output directories only (not the entire /app tree!)
# The bind mount (.:/app) is read-only for most files - we only need write access to dist/
echo "🔧 Ensuring write access to build output directories..."
sudo chown -R agor:agor /app/packages/*/dist /app/apps/*/dist 2>/dev/null || true
echo "✅ Build directories writable"

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
# IMPORTANT: Wait for .d.ts files too, not just .js files (needed for TypeScript packages)
echo "⏳ Waiting for @agor/core initial build..."
while [ ! -f "/app/packages/core/dist/index.js" ] || [ ! -f "/app/packages/core/dist/utils/logger.js" ] || [ ! -f "/app/packages/core/dist/index.d.ts" ]; do
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

# Configure RBAC settings from environment (set by postgres entrypoint)
if [ "$AGOR_SET_RBAC_FLAG" = "true" ] || [ -n "$AGOR_SET_UNIX_MODE" ]; then
  echo "🔐 Configuring RBAC settings..."

  # Enable worktree RBAC if flag is set
  if [ "$AGOR_SET_RBAC_FLAG" = "true" ]; then
    if ! grep -q "worktree_rbac" /home/agor/.agor/config.yaml 2>/dev/null; then
      sed -i '/^execution:/a\  worktree_rbac: true' /home/agor/.agor/config.yaml
      echo "✅ Worktree RBAC enabled"
    else
      # Update existing value to true
      sed -i 's/worktree_rbac:.*/worktree_rbac: true/' /home/agor/.agor/config.yaml
      echo "✅ Worktree RBAC updated to enabled"
    fi
  fi

  # Set Unix user mode if provided
  if [ -n "$AGOR_SET_UNIX_MODE" ]; then
    if ! grep -q "unix_user_mode" /home/agor/.agor/config.yaml 2>/dev/null; then
      sed -i "/^execution:/a\  unix_user_mode: $AGOR_SET_UNIX_MODE" /home/agor/.agor/config.yaml
      echo "✅ Unix user mode set to: $AGOR_SET_UNIX_MODE"
    else
      # Update existing value
      sed -i "s/unix_user_mode:.*/unix_user_mode: $AGOR_SET_UNIX_MODE/" /home/agor/.agor/config.yaml
      echo "✅ Unix user mode updated to: $AGOR_SET_UNIX_MODE"
    fi
  fi
fi

# Always create/update admin user (safe: only upserts)
echo "👤 Ensuring default admin user exists..."
ADMIN_OUTPUT=$(pnpm --filter @agor/cli exec tsx bin/dev.ts user create-admin --force 2>&1)
echo "$ADMIN_OUTPUT"

# Get FULL admin user UUID from database (the CLI only shows short ID)
# Use dedicated script to query the database
echo "🔍 Querying admin user ID from database..."
# Clear tsx cache to ensure fresh module resolution
rm -rf /app/node_modules/.tsx 2>/dev/null || true
# Silence SQLite pragma logs to prevent polluting captured output
ADMIN_USER_ID=$(cd /app && AGOR_SILENT_PRAGMA_LOGS=true ./node_modules/.bin/tsx scripts/get-admin-id.ts || echo "")
if [ -z "$ADMIN_USER_ID" ]; then
  echo "⚠️  Warning: Failed to query admin user ID"
else
  echo "✅ Admin user ID: $ADMIN_USER_ID"
fi

# Run seed script if SEED=true (idempotent: only runs if no data exists)
if [ "$SEED" = "true" ]; then
  echo "🌱 Seeding development fixtures..."
  if [ -n "$ADMIN_USER_ID" ]; then
    echo "   Using admin user: ${ADMIN_USER_ID}..."
    pnpm tsx scripts/seed.ts --skip-if-exists --user-id "$ADMIN_USER_ID"
  else
    echo "⚠️  Warning: Could not find admin user, seeding with anonymous"
    pnpm tsx scripts/seed.ts --skip-if-exists
  fi
fi

# Create RBAC test users if enabled (PostgreSQL + RBAC mode)
if [ "$CREATE_RBAC_TEST_USERS" = "true" ]; then
  echo "👥 Creating RBAC test users and worktrees..."
  pnpm tsx scripts/create-rbac-test-users.ts
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
