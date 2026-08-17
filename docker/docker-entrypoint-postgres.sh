#!/bin/bash
set -e

echo "🔒 Starting Agor PostgreSQL + RBAC Environment..."
echo ""
echo "This environment includes:"
echo "  - PostgreSQL database"
echo "  - RBAC + executor filesystem sandbox"
echo "  - Multi-user testing (alice, bob)"
echo ""

# Log the RBAC config the base entrypoint will apply. The public-facing
# AGOR_RBAC_ENABLED / AGOR_UNIX_USER_MODE → internal AGOR_SET_* translation is
# handled by the base entrypoint (docker-entrypoint.sh), so both the postgres
# and plain profiles use the same naming contract.
if [ -n "$AGOR_RBAC_ENABLED" ] || [ -n "$AGOR_UNIX_USER_MODE" ]; then
  echo "⚙️  RBAC settings from environment:"
  [ "$AGOR_RBAC_ENABLED" = "true" ] && echo "  execution.branch_rbac = true"
  [ -n "$AGOR_UNIX_USER_MODE" ] && echo "  execution.unix_user_mode = $AGOR_UNIX_USER_MODE"
  echo ""
fi

# Run base entrypoint to start daemon and UI
# This handles:
# - Building @agor/core
# - Database migrations
# - Creating admin user
# - Applying RBAC config (AGOR_RBAC_ENABLED / AGOR_UNIX_USER_MODE)
# - Starting daemon and UI
echo "🚀 Running base initialization..."
exec /usr/local/bin/docker-entrypoint.sh
