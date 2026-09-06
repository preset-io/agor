#!/bin/bash
set -e

echo "🔒 Starting Agor PostgreSQL + RBAC Environment..."
echo ""
echo "This environment includes:"
echo "  - PostgreSQL database"
echo "  - RBAC + executor filesystem sandbox"
echo "  - Multi-user testing (alice, bob)"
echo ""

# Log the execution mode the base entrypoint will apply.
if [ -n "$AGOR_UNIX_USER_MODE" ]; then
  echo "⚙️  Execution settings from environment:"
  [ -n "$AGOR_UNIX_USER_MODE" ] && echo "  execution.unix_user_mode = $AGOR_UNIX_USER_MODE"
  echo ""
fi

# Run base entrypoint to start daemon and UI
# This handles:
# - Building @agor/core
# - Database migrations
# - Creating admin user
# - Applying execution-mode config (AGOR_UNIX_USER_MODE)
# - Starting daemon and UI
echo "🚀 Running base initialization..."
exec /usr/local/bin/docker-entrypoint.sh
