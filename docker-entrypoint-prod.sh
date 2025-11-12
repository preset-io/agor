#!/bin/sh
set -e

echo "🚀 Starting Agor in production mode..."

# Initialize database if it doesn't exist
if [ ! -f "/home/agor/.agor/agor.db" ]; then
  echo "📦 Initializing Agor database..."
  pnpm --filter @agor/cli exec node bin/run.js init
fi

# Start daemon (which serves both API and static UI)
echo "🚀 Starting Agor daemon on port ${PORT:-3030}..."
cd /app/apps/agor-daemon
exec pnpm start