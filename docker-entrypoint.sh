#!/bin/sh
set -e

echo "🚀 Starting Agor development environment..."

# Re-run pnpm install to sync any package.json changes since build
# Uses --prefer-frozen-lockfile to avoid full reinstall when nothing changed
# Use yes pipe to auto-confirm any prompts if lockfile needs update
echo "📦 Syncing dependencies (if package.json changed)..."
yes | pnpm install --prefer-frozen-lockfile --reporter=default 2>&1 | grep -vE "(Already up to date|up to date, audited)" || true

# Initialize husky git hooks (required in Docker since --prefer-frozen-lockfile skips post-install hooks)
echo "🎣 Initializing git hooks..."
pnpm husky install

# Build @agor/core (required for CLI commands and daemon)
echo "🔨 Building @agor/core..."
pnpm --filter @agor/core build

# Initialize database (idempotent: skip if already exists)
echo "📦 Initializing Agor environment..."
pnpm agor init --skip-if-exists

# Always ensure auth is enabled in docker (create/overwrite config for multiplayer mode)
# Note: /home/agor is a volume mount, ensure we have write permissions
sudo sh -c "mkdir -p /home/agor/.agor && chown -R agor:agor /home/agor/.agor"
cat > /home/agor/.agor/config.yaml <<EOF
daemon:
  port: ${DAEMON_PORT:-3030}
  host: localhost
  allowAnonymous: false
  requireAuth: true
EOF

# Always create/update admin user (safe: only upserts)
echo "👤 Ensuring default admin user exists..."
pnpm --filter @agor/cli exec tsx bin/dev.ts user create-admin --force

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
