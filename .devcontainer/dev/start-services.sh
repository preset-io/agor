#!/bin/bash
set -e

echo "🚀 Starting Agor Dev Codespace..."
echo ""

# Check if user wants to develop from source
if [ -f "/workspaces/agor/package.json" ] && [ "$AGOR_DEV_FROM_SOURCE" = "true" ]; then
  echo "🔧 DEV MODE: Using source code"
  echo ""

  # Check if dependencies are installed
  if [ ! -d "/workspaces/agor/node_modules" ]; then
    echo "📦 Installing dependencies..."
    cd /workspaces/agor
    pnpm install
  fi

  # Check if core is built
  if [ ! -f "/workspaces/agor/packages/core/dist/index.js" ]; then
    echo "🏗️  Building core package..."
    cd /workspaces/agor/packages/core
    pnpm build
  fi

  echo "✅ Using source from /workspaces/agor"
  echo ""
  echo "💡 To rebuild: cd /workspaces/agor && pnpm -r build"
  echo ""

  CLI_CMD="cd /workspaces/agor/apps/agor-cli && pnpm exec tsx bin/dev.ts"
  DAEMON_CMD="cd /workspaces/agor/apps/agor-daemon && pnpm dev"
  UI_CMD="cd /workspaces/agor/apps/agor-ui && pnpm dev"
else
  echo "⚡ QUICK MODE: Using agor-live from npm"
  echo ""
  echo "💡 To develop from source: export AGOR_DEV_FROM_SOURCE=true"
  echo ""

  CLI_CMD="agor"
  DAEMON_CMD="agor daemon start"
  UI_CMD="agor ui"
fi

# Check if this is first run
if [ ! -d ~/.agor ]; then
  echo "📦 First run - initializing Agor..."
  echo ""

  if [ "$AGOR_DEV_FROM_SOURCE" = "true" ]; then
    cd /workspaces/agor/apps/agor-cli
    pnpm exec tsx bin/dev.ts init --force
    pnpm exec tsx bin/dev.ts user create-admin
  else
    agor init --force
    agor user create-admin
  fi

  echo ""
  echo "✅ Initialization complete!"
  echo ""
  echo "📝 Login credentials:"
  echo "   Email:    admin@agor.live"
  echo "   Password: admin"
  echo ""
fi

# Start daemon in background
echo "🔧 Starting daemon on :3030..."
if [ "$AGOR_DEV_FROM_SOURCE" = "true" ]; then
  cd /workspaces/agor/apps/agor-daemon
  nohup pnpm dev > /tmp/agor-daemon.log 2>&1 &
else
  nohup agor daemon start > /tmp/agor-daemon.log 2>&1 &
fi
DAEMON_PID=$!

# Wait for daemon to be ready
echo -n "   Waiting for daemon"
for i in {1..30}; do
  if curl -s http://localhost:3030/health > /dev/null 2>&1; then
    echo " ✅ (PID $DAEMON_PID)"
    break
  fi
  if [ $i -eq 30 ]; then
    echo " ❌"
    echo ""
    echo "Daemon failed to start. Check logs:"
    echo "  tail -f /tmp/agor-daemon.log"
    exit 1
  fi
  echo -n "."
  sleep 1
done

# Start UI in background
echo "🎨 Starting UI on :5173..."

# Detect Codespaces and set daemon URL
if [ -n "$CODESPACE_NAME" ]; then
  DAEMON_URL="https://${CODESPACE_NAME}-3030.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  echo "   Codespaces detected - daemon URL: $DAEMON_URL"
  export VITE_DAEMON_URL="$DAEMON_URL"
fi

if [ "$AGOR_DEV_FROM_SOURCE" = "true" ]; then
  cd /workspaces/agor/apps/agor-ui
  nohup pnpm dev > /tmp/agor-ui.log 2>&1 &
else
  nohup agor ui > /tmp/agor-ui.log 2>&1 &
fi
UI_PID=$!

# Wait for UI to be ready
echo -n "   Waiting for UI"
for i in {1..30}; do
  if curl -s http://localhost:5173 > /dev/null 2>&1; then
    echo " ✅ (PID $UI_PID)"
    break
  fi
  if [ $i -eq 30 ]; then
    echo " ❌"
    echo ""
    echo "UI failed to start. Check logs:"
    echo "  tail -f /tmp/agor-ui.log"
    exit 1
  fi
  echo -n "."
  sleep 1
done

echo ""
echo "🎉 Agor is running!"
echo ""
echo "   Daemon: http://localhost:3030"
echo "   UI: http://localhost:5173"
echo ""
echo "   (Codespaces auto-forwards these ports)"
echo ""
echo "📝 Logs:"
echo "   tail -f /tmp/agor-daemon.log"
echo "   tail -f /tmp/agor-ui.log"
echo ""

if [ "$AGOR_DEV_FROM_SOURCE" = "true" ]; then
  echo "🔧 DEV MODE (source)"
  echo "   - Edit code in /workspaces/agor"
  echo "   - Watch mode active (auto-recompiles)"
else
  echo "⚡ QUICK MODE (npm package)"
  echo "   - Using agor-live@latest from npm"
  echo "   - Set AGOR_DEV_FROM_SOURCE=true to develop from source"
fi

echo ""
echo "🔄 Keeping services running (Ctrl+C to stop)..."
echo ""

# Keep script running
wait
