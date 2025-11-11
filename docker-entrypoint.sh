#!/bin/sh
set -e

echo "🚀 Starting Agor development environment..."

# Dependencies are installed during Docker build and node_modules are excluded from volume mount
# Just verify they exist, don't reinstall unless something is actually missing
if [ ! -d "/app/node_modules" ]; then
  echo "📦 Installing dependencies (first run)..."
  yes | pnpm install --frozen-lockfile --reporter=default
else
  echo "📦 Dependencies already installed (from Docker build)"
fi

# Initialize husky git hooks (required for git commit hooks)
echo "🎣 Initializing git hooks..."
pnpm husky install

# Build @agor/core (required for CLI commands and daemon)
echo "🔨 Building @agor/core..."
pnpm --filter @agor/core build

# Initialize database (idempotent: skip if already exists)
echo "📦 Initializing Agor environment..."
pnpm agor init --skip-if-exists

# Always ensure auth is enabled in docker (create/overwrite config for multiplayer mode)
# Fix volume permissions (volumes may be created with wrong ownership)
# Only chown .agor directory (not .ssh which is mounted read-only)
mkdir -p /home/agor/.agor
sudo chown -R agor:agor /home/agor/.agor

# Use agor CLI to set config values (preserves existing secrets)
# This is safer than overwriting the entire config.yaml file
pnpm agor config set daemon.port "${DAEMON_PORT:-3030}"
pnpm agor config set daemon.host localhost
pnpm agor config set daemon.allowAnonymous false
pnpm agor config set daemon.requireAuth true
pnpm agor config set opencode.enabled true
pnpm agor config set opencode.serverUrl http://host.docker.internal:4096

# Always create/update admin user (safe: only upserts)
echo "👤 Ensuring default admin user exists..."
pnpm --filter @agor/cli exec tsx bin/dev.ts user create-admin --force

# Run seed script if SEED=true (idempotent: only runs if no data exists)
if [ "$SEED" = "true" ]; then
  echo "🌱 Seeding development fixtures..."
  pnpm tsx scripts/seed.ts --skip-if-exists
fi

# Start daemon in background (use DAEMON_PORT env var or default to 3030)
echo "🚀 Starting daemon on port ${DAEMON_PORT:-3030}..."
PORT="${DAEMON_PORT:-3030}" pnpm --filter @agor/daemon dev &
DAEMON_PID=$!

# Wait a bit for daemon to start
sleep 3

# Start UI in foreground (this keeps container alive)
echo "🎨 Starting UI on port ${UI_PORT:-5173}..."
VITE_DAEMON_PORT="${DAEMON_PORT:-3030}" pnpm --filter agor-ui dev --host 0.0.0.0 --port "${UI_PORT:-5173}"

# If UI exits, kill daemon too
kill $DAEMON_PID 2>/dev/null || true
