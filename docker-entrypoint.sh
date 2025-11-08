#!/bin/sh
set -e

echo "🚀 Starting Agor development environment..."

# Check if package.json has changed since build (compare timestamps or checksums)
# Only run install if package.json is newer than node_modules
if [ /app/package.json -nt /app/node_modules/.modules.yaml ] || \
   [ /app/apps/agor-daemon/package.json -nt /app/apps/agor-daemon/node_modules ] || \
   [ /app/apps/agor-cli/package.json -nt /app/apps/agor-cli/node_modules ] || \
   [ /app/apps/agor-ui/package.json -nt /app/apps/agor-ui/node_modules ] || \
   [ /app/packages/core/package.json -nt /app/packages/core/node_modules ]; then
  echo "📦 Package.json changed, syncing dependencies..."
  yes | pnpm install --prefer-frozen-lockfile --reporter=default
else
  echo "📦 Dependencies up to date (skipping install)"
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
