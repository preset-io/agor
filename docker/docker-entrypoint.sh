#!/bin/sh
set -e

echo "🚀 Starting Agor development environment..."

# Dependencies are baked into the Docker image and preserved via anonymous volumes
# No pnpm install needed at runtime - this is the key to fast startups!
echo "✅ Using pre-built dependencies from Docker image"

# Fix permissions for build tools (tsup, tsc, vite need write access to package roots)
# The bind mount (.:/app) may have restrictive permissions from host filesystem
# Build tools write temp files (tsup.config.bundled_*.mjs, .vite/, etc.) to package roots
#
# IMPORTANT: This is a workaround for UID/GID mismatch between host and container
# For best performance, rebuild the image with matching UID/GID:
#   UID=$(id -u) GID=$(id -g) docker compose build
echo "🔧 Ensuring write access for build tools..."
if sudo -n true 2>/dev/null; then
  # Clean and recreate dist directories with correct ownership
  # This prevents EACCES errors when tsup tries to unlink old files
  sudo -n rm -rf /app/packages/*/dist /app/apps/*/dist 2>/dev/null || true
  sudo -n mkdir -p /app/packages/core/dist /app/packages/executor/dist /app/apps/agor-daemon/dist /app/apps/agor-cli/dist /app/apps/agor-ui/dist

  # Chown all package/app directories (non-recursive for speed)
  sudo -n chown agor:agor /app/packages/* /app/apps/* 2>/dev/null || true

  # Chown dist directories recursively (in case they have nested files)
  sudo -n chown -R agor:agor /app/packages/*/dist /app/apps/*/dist

  echo "✅ Build directories ready"
else
  # Fallback: try without sudo (might work depending on host permissions)
  rm -rf /app/packages/*/dist /app/apps/*/dist 2>/dev/null || true
  mkdir -p /app/packages/*/dist /app/apps/*/dist 2>/dev/null || true
  echo "⚠️  Build directories created (sudo not available, may have permission issues)"
fi

# Skip husky in Docker (git hooks run on host, not in container)
# Also avoids "fatal: not a git repository" error with worktrees where .git is a file, not a directory
# If you need hooks in the container, run `pnpm husky install` manually after startup
echo "⏭️  Skipping husky install (git hooks run on host, not in container)"

# Build packages sequentially to avoid race conditions
# Strategy: Do blocking builds first, THEN start watch modes
# This ensures all type definitions are ready before dependent packages compile

# Step 1: Build @agor/core (blocking, no watch)
echo "🔨 Building @agor/core (initial build)..."
pnpm --filter @agor/core build

# CRITICAL: Wait for DTS files to actually exist
# tsup with dts:true uses rollup-plugin-dts which runs async after main build
# The build command can exit before .d.ts files are fully written
echo "⏳ Waiting for @agor/core type definitions to be written..."
MAX_WAIT=30
WAITED=0
while [ ! -f "/app/packages/core/dist/api/index.d.ts" ] || [ ! -f "/app/packages/core/dist/types/index.d.ts" ]; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "❌ Timeout waiting for type definitions!"
    exit 1
  fi
  sleep 0.5
  WAITED=$((WAITED + 1))
done
echo "✅ @agor/core initial build complete (including type definitions)"

# Step 2: Build @agor/executor (blocking, no watch)
# Now safe because @agor/core types are fully available
echo "🔨 Building @agor/executor (initial build)..."
pnpm --filter @agor/executor build

# Wait for executor DTS files too
echo "⏳ Waiting for @agor/executor type definitions to be written..."
MAX_WAIT=30
WAITED=0
while [ ! -f "/app/packages/executor/dist/index.d.ts" ]; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "❌ Timeout waiting for executor type definitions!"
    exit 1
  fi
  sleep 0.5
  WAITED=$((WAITED + 1))
done
echo "✅ @agor/executor initial build complete (including type definitions)"

# Step 3: Start watch modes in background (for hot-reload during development)
# Now both packages are fully built, watch mode just handles incremental changes
echo "🔄 Starting watch modes for hot-reload..."
pnpm --filter @agor/core dev &
CORE_PID=$!

pnpm --filter @agor/executor dev &
EXECUTOR_PID=$!

echo "✅ Watch modes started (core and executor will rebuild on file changes)"

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

  # Set daemon.unix_user when RBAC is enabled (required for sudo impersonation)
  # The daemon runs as 'agor' user in Docker, so git operations via sudo su need to know this
  # Check specifically for 'unix_user:' under the daemon section (not elsewhere in the file)
  if ! grep -A10 "^daemon:" /home/agor/.agor/config.yaml 2>/dev/null | grep -q "unix_user:"; then
    # Add unix_user under daemon section
    sed -i '/^daemon:/a\  unix_user: agor' /home/agor/.agor/config.yaml
    echo "✅ Daemon Unix user set to: agor"
  else
    echo "✅ Daemon Unix user already configured"
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

# If UI exits, kill daemon, executor watch, and core watch
kill $DAEMON_PID 2>/dev/null || true
kill $EXECUTOR_PID 2>/dev/null || true
kill $CORE_PID 2>/dev/null || true
