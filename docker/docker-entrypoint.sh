#!/bin/sh
set -e

echo "🚀 Starting Agor development environment..."

# Dependencies are baked into the Docker image and preserved via anonymous volumes
# No pnpm install needed at runtime - this is the key to fast startups!
echo "✅ Using pre-built dependencies from Docker image"

# Mark /app as a safe git directory for non-branch clones (where the
# bind-mounted source tree is owned by the host UID and trips git's
# "dubious ownership" guard inside the container). Harmless in Agor's
# branch-managed setup, where /app/.git is a FILE pointing to a host-only
# gitdir that can't be resolved from inside the container at all — those
# setups feed AGOR_BUILD_SHA via env from .agor.yml's start command instead.
git config --global --add safe.directory /app 2>/dev/null || true

# Fix home directory permissions (volumes may have wrong UID/GID from previous builds)
echo "🔧 Fixing home directory permissions..."
mkdir -p /home/agor/.agor /home/agor/.cache
sudo -n chown -R agor:agor /home/agor 2>/dev/null || true

# Setup agor_executor home (for Unix isolation when executor_unix_user is configured)
sudo -n mkdir -p /home/agor_executor/.cache /home/agor_executor/.agor
sudo -n chown -R agor_executor:agor_executor /home/agor_executor 2>/dev/null || true
echo "✅ Home directory permissions fixed"

# Fix build directory permissions (clean stale dist files with wrong ownership)
echo "🔧 Ensuring write access for build tools..."
DIST_DIRS="/app/packages/git/dist /app/packages/core/dist /app/packages/executor/dist /app/packages/client/dist /app/apps/agor-daemon/dist /app/apps/agor-cli/dist /app/apps/agor-ui/dist"
if sudo -n true 2>/dev/null; then
  # Clean and recreate dist directories with correct ownership.
  # Use the explicit workspace list instead of /app/packages/*/dist globs:
  # under `set -e`, an unmatched glob is passed literally to chown and aborts
  # startup before the initial builds have a chance to create dist outputs.
  sudo -n rm -rf $DIST_DIRS 2>/dev/null || true
  # TypeScript incremental state can otherwise claim executor/client outputs are
  # up-to-date after dist/ was removed, producing an empty dist and a startup
  # timeout while waiting for .d.ts files.
  sudo -n rm -rf \
    /app/packages/executor/node_modules/.tmp/tsconfig.tsbuildinfo \
    /app/packages/client/node_modules/.tmp/tsconfig.tsbuildinfo \
    /app/packages/core/node_modules/.tmp/tsconfig.tsbuildinfo \
    2>/dev/null || true
  sudo -n mkdir -p $DIST_DIRS

  # Chown all package/app directories (non-recursive for speed)
  sudo -n chown agor:agor /app/packages/* /app/apps/* 2>/dev/null || true

  # Chown dist directories recursively (in case they have nested files)
  sudo -n chown -R agor:agor $DIST_DIRS

  # The initial builds below run after dist cleanup. If TypeScript's
  # incremental cache survives from an earlier container, `tsc` can incorrectly
  # decide there is nothing to emit, leaving dist empty and making the startup
  # wait loop time out. Remove stale build info alongside dist.
  BUILD_INFO_DIRS="/app/packages/core/node_modules/.tmp /app/packages/executor/node_modules/.tmp /app/packages/client/node_modules/.tmp"
  sudo -n rm -rf $BUILD_INFO_DIRS 2>/dev/null || true
  sudo -n mkdir -p $BUILD_INFO_DIRS
  sudo -n chown -R agor:agor $BUILD_INFO_DIRS

  echo "✅ Build directories ready"
else
  # Fallback: try without sudo (might work depending on host permissions)
  rm -rf $DIST_DIRS 2>/dev/null || true
  rm -rf /app/packages/core/node_modules/.tmp /app/packages/executor/node_modules/.tmp /app/packages/client/node_modules/.tmp 2>/dev/null || true
  mkdir -p /app/packages/core/node_modules/.tmp /app/packages/executor/node_modules/.tmp /app/packages/client/node_modules/.tmp 2>/dev/null || true
  mkdir -p $DIST_DIRS 2>/dev/null || true
  echo "⚠️  Build directories created (sudo not available, may have permission issues)"
fi

# Skip husky (git hooks run on host, not in container)
echo "⏭️  Skipping husky install"

# Build packages sequentially with blocking builds to avoid race conditions
echo "🔨 Building @agor/git (initial build)..."
pnpm --filter @agor/git build

echo "⏳ Waiting for @agor/git type definitions..."
MAX_WAIT=30
WAITED=0
while [ ! -f "/app/packages/git/dist/index.d.ts" ] || [ ! -f "/app/packages/git/dist/pure.d.ts" ]; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "❌ Timeout waiting for git type definitions!"
    exit 1
  fi
  sleep 0.5
  WAITED=$((WAITED + 1))
done
echo "✅ @agor/git initial build complete (including type definitions)"

echo "🔨 Building @agor/core (initial build)..."
pnpm --filter @agor/core build

# Wait for DTS files (tsup's rollup-plugin-dts runs async after main build)
echo "⏳ Waiting for @agor/core type definitions..."
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

echo "🔨 Building @agor/executor (initial build)..."
pnpm --filter @agor/executor build

echo "⏳ Waiting for @agor/executor type definitions..."
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

# In strict/insulated Unix modes, executors are launched as non-daemon Unix
# users. The bind-mounted /app tree can be group-private in Agor-managed
# worktrees, so those users may not be able to read /app/packages/executor even
# though they can read their assigned branch checkout. Build a standalone,
# world-readable executor runtime outside /app and point the daemon at it.
if [ "${AGOR_UNIX_USER_MODE:-simple}" != "simple" ] || [ "${AGOR_USE_EXECUTOR:-false}" = "true" ]; then
  echo "📦 Preparing shared executor runtime for Unix impersonation..."
  rm -rf /tmp/agor-executor-runtime
  pnpm --filter @agor/executor deploy --prod /tmp/agor-executor-runtime
  chmod -R a+rX /tmp/agor-executor-runtime
  export AGOR_EXECUTOR_PATH=/tmp/agor-executor-runtime/bin/agor-executor
  echo "✅ Shared executor runtime ready: $AGOR_EXECUTOR_PATH"
fi

echo "🔨 Building @agor-live/client (initial build)..."
pnpm --filter @agor-live/client build

echo "⏳ Waiting for @agor-live/client type definitions..."
MAX_WAIT=30
WAITED=0
while [ ! -f "/app/packages/client/dist/index.d.ts" ]; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "❌ Timeout waiting for client type definitions!"
    exit 1
  fi
  sleep 0.5
  WAITED=$((WAITED + 1))
done
echo "✅ @agor-live/client initial build complete (including type definitions)"

# Start watch modes for hot-reload
echo "🔄 Starting watch modes..."
pnpm --filter @agor/git dev &
GIT_PID=$!

pnpm --filter @agor/core dev &
CORE_PID=$!

pnpm --filter @agor/executor dev &
EXECUTOR_PID=$!

pnpm --filter @agor-live/client dev &
CLIENT_PID=$!

echo "✅ Watch modes started (git, core, executor, and client will rebuild on file changes)"

# Initialize database and configure daemon settings for Docker
# (idempotent: creates database on first run, preserves JWT secrets on subsequent runs)
echo "📦 Initializing Agor environment..."
pnpm agor init --skip-if-exists --set-config --daemon-port "${DAEMON_PORT:-3030}" --daemon-host "${DAEMON_HOST:-0.0.0.0}"

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

# Translate public-facing RBAC env vars to the internal AGOR_SET_* contract the
# sed logic below reads. The postgres entrypoint also performs this translation
# before exec'ing us — doing it again here is idempotent (same export values)
# and lets plain `docker-compose.yml` consumers set AGOR_RBAC_ENABLED /
# AGOR_UNIX_USER_MODE directly, matching the names documented in the postgres
# profile and CLAUDE.md.
if [ "$AGOR_RBAC_ENABLED" = "true" ]; then
  export AGOR_SET_RBAC_FLAG="true"
fi
if [ -n "$AGOR_UNIX_USER_MODE" ]; then
  export AGOR_SET_UNIX_MODE="$AGOR_UNIX_USER_MODE"
fi

# Configure RBAC settings from environment (set by postgres entrypoint or by
# the public-facing translation above).
if [ "$AGOR_SET_RBAC_FLAG" = "true" ] || [ -n "$AGOR_SET_UNIX_MODE" ]; then
  echo "🔐 Configuring RBAC settings..."

  # Enable branch RBAC if flag is set
  if [ "$AGOR_SET_RBAC_FLAG" = "true" ]; then
    if ! grep -q "branch_rbac" /home/agor/.agor/config.yaml 2>/dev/null; then
      sed -i '/^execution:/a\  branch_rbac: true' /home/agor/.agor/config.yaml
      echo "✅ Branch RBAC enabled"
    else
      # Update existing value to true
      sed -i 's/branch_rbac:.*/branch_rbac: true/' /home/agor/.agor/config.yaml
      echo "✅ Branch RBAC updated to enabled"
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
echo "👤 Ensuring development admin user exists..."
ADMIN_OUTPUT=$(pnpm --filter @agor/cli exec tsx bin/dev.ts user create-admin --dev-default 2>&1)
echo "$ADMIN_OUTPUT"

# In strict mode the daemon validates that a session creator's unix_username exists as a
# real OS account before spawning the executor. The admin DB user is created above via the
# CLI (direct DB write, no Feathers hook), so the normal after-create hook that calls
# unix.sync-user never fires. Provision the OS account explicitly here while we still have
# a clean pre-daemon window and sudoers access.
if [ "$AGOR_SET_UNIX_MODE" = "strict" ]; then
  echo "🔒 Provisioning bootstrap admin OS user (strict mode)..."
  pnpm agor local ensure-user --username admin || echo "⚠️  Could not provision admin OS user — check sudoers"
fi

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

# Load demo fixtures if LOAD_FIXTURES=true (idempotent: skips if demo data
# exists). Pure DB inserts — no git/network/executor. Orthogonal to SEED and
# runs AFTER it, so `SEED=true LOAD_FIXTURES=true` yields a real runnable branch
# plus a rich set of hardcoded fake data for instant end-to-end testing.
if [ "$LOAD_FIXTURES" = "true" ]; then
  echo "🎭 Loading demo fixtures..."
  if [ -n "$ADMIN_USER_ID" ]; then
    echo "   Using admin user: ${ADMIN_USER_ID}..."
    pnpm tsx scripts/load-fixtures.ts --skip-if-exists --user-id "$ADMIN_USER_ID"
  else
    echo "⚠️  Warning: Could not find admin user, loading demo fixtures without admin owner"
    pnpm tsx scripts/load-fixtures.ts --skip-if-exists
  fi
fi

# Create RBAC test users if enabled (PostgreSQL + RBAC mode)
if [ "$CREATE_RBAC_TEST_USERS" = "true" ]; then
  echo "👥 Creating RBAC test users and branches..."
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
# VITE_DAEMON_URL (when set by the .agor.yml dev variant) points the browser
# SPA at the daemon's host:DAEMON_PORT in this split-port env, where vite-dev
# serves the UI on a different port than the daemon API. Forwarded explicitly
# so vite exposes it as import.meta.env.VITE_DAEMON_URL.
echo "🎨 Starting UI on port ${UI_PORT:-5173}..."
VITE_DAEMON_PORT="${DAEMON_PORT:-3030}" VITE_DAEMON_URL="${VITE_DAEMON_URL:-}" pnpm --filter agor-ui dev --host 0.0.0.0 --port "${UI_PORT:-5173}"

# If UI exits, kill daemon, executor watch, and core watch
kill $DAEMON_PID 2>/dev/null || true
kill $CLIENT_PID 2>/dev/null || true
kill $EXECUTOR_PID 2>/dev/null || true
kill $CORE_PID 2>/dev/null || true
kill $GIT_PID 2>/dev/null || true
