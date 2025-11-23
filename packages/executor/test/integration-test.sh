#!/bin/bash
# Simple integration test for executor

set -e

SOCKET_PATH="/tmp/test-executor-int.sock"

echo "=== Executor Integration Test ==="
echo ""

# Clean up any existing socket
rm -f "$SOCKET_PATH"

echo "1. Starting executor in background..."
npx tsx ../src/index.ts --socket "$SOCKET_PATH" &
EXECUTOR_PID=$!

# Wait for socket to exist
echo "2. Waiting for socket..."
for i in {1..50}; do
  if [ -S "$SOCKET_PATH" ]; then
    echo "   Socket ready!"
    break
  fi
  sleep 0.1
done

if [ ! -S "$SOCKET_PATH" ]; then
  echo "ERROR: Socket not created"
  kill $EXECUTOR_PID 2>/dev/null || true
  exit 1
fi

echo "3. Sending ping request..."
# Use nc (netcat) to send request
echo '{"jsonrpc":"2.0","id":"1","method":"ping","params":{}}' | nc -U "$SOCKET_PATH" | head -1 > /tmp/response.json

echo "4. Response:"
cat /tmp/response.json | npx json_pp

# Check if response contains "pong"
if grep -q '"pong"' /tmp/response.json; then
  echo ""
  echo "✅ Test PASSED!"
else
  echo ""
  echo "❌ Test FAILED - unexpected response"
  cat /tmp/response.json
  kill $EXECUTOR_PID 2>/dev/null || true
  exit 1
fi

# Cleanup
echo "5. Cleaning up..."
kill $EXECUTOR_PID 2>/dev/null || true
rm -f "$SOCKET_PATH" /tmp/response.json

echo "Done!"
