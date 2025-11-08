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
# Note: /home/agor is a volume mount, should already be owned by agor user
mkdir -p /home/agor/.agor
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
