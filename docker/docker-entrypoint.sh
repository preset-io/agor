#!/bin/sh
set -e

echo "🚀 Starting Agor development environment..."

# Dependencies are baked into the Docker image and preserved via anonymous volumes
# No pnpm install needed at runtime - this is the key to fast startups!
echo "✅ Using pre-built dependencies from Docker image"

# pnpm runs a workspace-wide deps-status check (runDepsStatusCheck) before every
# `pnpm run` / `pnpm --filter … <script>`. This image bakes in deps for only 8 of the
# 10 workspace packages (apps/agor-docs and packages/agor-live are neither installed
# nor shadowed by an anonymous node_modules volume), so that check always decides
# node_modules is out of sync and kicks off a full `pnpm install`. That install then
# wants to purge and reinstall node_modules "from scratch" and asks to confirm — a
# prompt that hangs forever under `docker compose up` (the dev service runs with
# tty:true, so pnpm prompts instead of erroring, and nothing ever answers it). The
# packages we actually build and run below all have their deps baked in, so disable
# the pre-run check entirely: the builds use what's already in the image, startup
# stays fast, and nothing tries to reinstall.
#
# NB: this setting is pnpm-specific and is only read from the `pnpm_config_*` env
# namespace — `npm_config_verify_deps_before_run` is silently ignored (verified
# against pnpm 11.13, the version this repo pins).
export pnpm_config_verify_deps_before_run=false
# Belt-and-suspenders: force non-interactive mode so that if any pnpm command still
# decides to touch node_modules, it auto-answers its modules-purge confirmation
# instead of blocking on it (CI=true → pnpm skips the confirmation prompt).
export CI=true

# Mark /app as a safe git directory for non-branch clones (where the
# bind-mounted source tree is owned by the host UID and trips git's
# "dubious ownership" guard inside the container). Harmless in Agor's
# branch-managed setup, where /app/.git is a FILE pointing to a host-only
# gitdir that can't be resolved from inside the container at all — those
# setups feed AGOR_BUILD_SHA via env from .agor.yml's start command instead.
git config --global --add safe.directory /app 2>/dev/null || true

# Fix home directory permissions (volumes may have wrong UID/GID from previous builds)
echo "🔧 Fixing home directory permissions..."
mkdir -p -m 0700 /home/agor/.agor
mkdir -p /home/agor/.cache
sudo -n chown -R agor:agor /home/agor 2>/dev/null || true

echo "✅ Home directory permissions fixed"

# Fix build directory permissions (clean stale dist files with wrong ownership)
echo "🔧 Ensuring write access for build tools..."
DIST_DIRS="/app/packages/git/dist /app/packages/core/dist /app/packages/agentic-tool-opencode/dist /app/packages/agentic-tools/dist /app/packages/executor/dist /app/packages/client/dist /app/apps/agor-daemon/dist /app/apps/agor-cli/dist /app/apps/agor-ui/dist"
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
    /app/packages/agentic-tool-opencode/node_modules/.tmp/tsconfig.tsbuildinfo \
    /app/packages/agentic-tools/node_modules/.tmp/tsconfig.tsbuildinfo \
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
  BUILD_INFO_DIRS="/app/packages/core/node_modules/.tmp /app/packages/agentic-tool-opencode/node_modules/.tmp /app/packages/agentic-tools/node_modules/.tmp /app/packages/executor/node_modules/.tmp /app/packages/client/node_modules/.tmp"
  sudo -n rm -rf $BUILD_INFO_DIRS 2>/dev/null || true
  sudo -n mkdir -p $BUILD_INFO_DIRS
  sudo -n chown -R agor:agor $BUILD_INFO_DIRS

  echo "✅ Build directories ready"
else
  # Fallback: try without sudo (might work depending on host permissions)
  rm -rf $DIST_DIRS 2>/dev/null || true
  rm -rf /app/packages/core/node_modules/.tmp /app/packages/agentic-tool-opencode/node_modules/.tmp /app/packages/agentic-tools/node_modules/.tmp /app/packages/executor/node_modules/.tmp /app/packages/client/node_modules/.tmp 2>/dev/null || true
  mkdir -p /app/packages/core/node_modules/.tmp /app/packages/agentic-tool-opencode/node_modules/.tmp /app/packages/agentic-tools/node_modules/.tmp /app/packages/executor/node_modules/.tmp /app/packages/client/node_modules/.tmp 2>/dev/null || true
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

echo "🔨 Building @agor/agentic-tool-opencode (initial build)..."
pnpm --filter @agor/agentic-tool-opencode build

echo "⏳ Waiting for @agor/agentic-tool-opencode type definitions..."
MAX_WAIT=30
WAITED=0
while [ ! -f "/app/packages/agentic-tool-opencode/dist/shared/index.d.ts" ] || [ ! -f "/app/packages/agentic-tool-opencode/dist/runtime/index.d.ts" ] || [ ! -f "/app/packages/agentic-tool-opencode/dist/ui/index.d.ts" ]; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "❌ Timeout waiting for agentic-tool-opencode type definitions!"
    exit 1
  fi
  sleep 0.5
  WAITED=$((WAITED + 1))
done
echo "✅ @agor/agentic-tool-opencode initial build complete (including type definitions)"

echo "🔨 Building @agor/agentic-tools (initial build)..."
pnpm --filter @agor/agentic-tools build

echo "⏳ Waiting for @agor/agentic-tools type definitions..."
MAX_WAIT=30
WAITED=0
while [ ! -f "/app/packages/agentic-tools/dist/index.d.ts" ] || [ ! -f "/app/packages/agentic-tools/dist/ui.d.ts" ]; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "❌ Timeout waiting for agentic-tools type definitions!"
    exit 1
  fi
  sleep 0.5
  WAITED=$((WAITED + 1))
done
echo "✅ @agor/agentic-tools initial build complete (including type definitions)"

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

export AGOR_EXECUTOR_PATH=/app/packages/executor/bin/agor-executor

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

pnpm --filter @agor/agentic-tool-opencode dev &
AGENTIC_TOOL_OPENCODE_PID=$!

pnpm --filter @agor/agentic-tools dev &
AGENTIC_TOOLS_PID=$!

pnpm --filter @agor/executor dev &
EXECUTOR_PID=$!

pnpm --filter @agor-live/client dev &
CLIENT_PID=$!

echo "✅ Watch modes started (git, core, agentic tools, executor, and client will rebuild on file changes)"

# `agor init` is the SQLite installation bootstrap and intentionally creates
# ~/.agor/agor.db. PostgreSQL deployments get their database state from the
# migrations and daemon bootstrap below, but still need the deployment-owned
# identity and secrets that `agor init` normally creates. Generate a complete
# config on first start and persist it in the agor-home volume.
if [ "${AGOR_DB_DIALECT:-sqlite}" = "postgresql" ]; then
  echo "🪪 Ensuring PostgreSQL development deployment config exists..."
  pnpm tsx scripts/ensure-development-config.ts
  echo "⏭️  Skipping SQLite database initialization for PostgreSQL deployment"
else
  echo "📦 Initializing Agor environment..."
  pnpm agor init --skip-if-exists --non-interactive --agentic-tools "${AGOR_AGENTIC_TOOLS:-none}" --daemon-port "${DAEMON_PORT:-3030}" --daemon-host "${DAEMON_HOST:-0.0.0.0}"
fi

# Run database migrations (idempotent: safe to run on every start).
# This ensures schema is up-to-date even when using existing database volumes.
# Managed, isolated development environments explicitly acknowledge offline
# cutovers through AGOR_MIGRATION_OFFLINE_CUTOVER. Keep the default fail-closed:
# arbitrary Compose users may point this container at a shared database, so the
# entrypoint must not infer that an offline migration is safe merely because it
# is the development image.
echo "🔄 Running database migrations..."
if [ "${AGOR_MIGRATION_OFFLINE_CUTOVER:-false}" = "true" ]; then
  echo "⚠️  Applying acknowledged offline-cutover migrations in this isolated development environment"
  pnpm agor db migrate --yes --offline-cutover
else
  pnpm agor db migrate --yes
fi

# Runtime deployment overrides are consumed directly from the environment by
# the daemon. Never materialize them into the operator-owned config.yaml.

# Always create/update admin user (safe: only upserts)
echo "👤 Ensuring development admin user exists..."
ADMIN_OUTPUT=$(pnpm --filter @agor/cli exec tsx bin/dev.ts local create-admin --dev-default 2>&1)
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
kill $AGENTIC_TOOLS_PID 2>/dev/null || true
kill $AGENTIC_TOOL_OPENCODE_PID 2>/dev/null || true
kill $CORE_PID 2>/dev/null || true
kill $GIT_PID 2>/dev/null || true
