#!/bin/sh
set -e

echo "🚀 Starting Agor development environment..."

# Always run pnpm install on startup (fast if deps already installed, fixes worktree mounts)
# Use CI=true to disable interactive prompts
echo "📦 Checking dependencies..."
CI=true pnpm install --reporter=append-only

# Build @agor/core (required for CLI commands and daemon)
echo "🔨 Building @agor/core..."
pnpm --filter @agor/core build

# Initialize database if it doesn't exist
if [ ! -f /root/.agor/agor.db ]; then
  echo "📦 Initializing database..."
  pnpm exec tsx packages/core/src/db/scripts/setup-db.ts

  # Wait a moment for database to be fully written
  sleep 1

  # Verify users table exists
  echo "🔍 Verifying database schema..."
  sqlite3 /root/.agor/agor.db "SELECT name FROM sqlite_master WHERE type='table' AND name='users';" || {
    echo "❌ Users table not found! Database schema may be incomplete."
    exit 1
  }

  echo "👤 Creating default admin user..."
  # Create config with auth enabled (use DAEMON_PORT env var or default to 3030)
  mkdir -p /root/.agor
  cat > /root/.agor/config.yaml <<EOF
daemon:
  port: ${DAEMON_PORT:-3030}
  host: localhost
  allowAnonymous: false
  requireAuth: true
EOF

  # Create admin user via CLI (uses defaults: admin@agor.live / admin)
  pnpm --filter @agor/cli exec tsx bin/dev.ts user create-admin
else
  echo "📦 Database already exists"
fi

# Start daemon in background (use DAEMON_PORT env var or default to 3030)
echo "📡 Starting daemon on port ${DAEMON_PORT:-3030}..."
PORT="${DAEMON_PORT:-3030}" pnpm --filter @agor/daemon dev &
DAEMON_PID=$!

# Wait a bit for daemon to start
sleep 3

# Start UI in foreground (this keeps container alive)
echo "🎨 Starting UI on port ${UI_PORT:-5173}..."
VITE_DAEMON_PORT="${DAEMON_PORT:-3030}" pnpm --filter agor-ui dev --host 0.0.0.0 --port "${UI_PORT:-5173}"

# If UI exits, kill daemon too
kill $DAEMON_PID 2>/dev/null || true
