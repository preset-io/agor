#!/bin/bash
# Test script to verify executor spawning and process isolation

echo "🧪 Executor Spawning Validation Test"
echo ""

# Check current user
echo "1. Current shell user:"
whoami
echo ""

# Check if agor_executor exists
echo "2. Checking agor_executor user:"
id agor_executor 2>/dev/null || echo "❌ User not found"
echo ""

# Check running processes
echo "3. Checking for executor processes:"
echo "   Looking for processes running as agor_executor..."
ps aux | grep agor_executor | grep -v grep || echo "   No executor processes currently running"
echo ""

# Check if we can see the agor-executor binary
echo "4. Checking for executor binary:"
which agor-executor || echo "   Binary not in PATH (expected - it's in node_modules)"
ls -la packages/executor/dist/cli.js 2>/dev/null || echo "   Not built yet"
echo ""

echo "5. To test actual spawning, you need to:"
echo "   a) Create a test session via the API"
echo "   b) Send a prompt to trigger SDK execution"
echo "   c) While it's running, check: ps aux | grep agor_executor"
echo ""
echo "Example:"
echo "  # In another terminal, watch for executor processes:"
echo "  watch -n 0.5 'ps aux | grep agor_executor | grep -v grep'"
echo ""
