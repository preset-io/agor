#!/bin/bash
set -e

echo "🔒 Starting Agor PostgreSQL + RBAC Environment..."
echo ""
echo "This environment includes:"
echo "  - PostgreSQL database"
echo "  - RBAC + Unix integration (insulated mode)"
echo "  - Multi-user testing (alice, bob)"
echo "  - SSH server on port ${SSH_PORT:-2222}"
echo ""

# Start SSH server in background (only if postgres profile is active)
echo "🔑 Starting SSH server..."
sudo -n /usr/sbin/sshd
echo "✅ SSH server running on port 22 (exposed as ${SSH_PORT:-2222})"

# Create Unix users: alice and bob
create_unix_user() {
  local username=$1

  if id "$username" &>/dev/null; then
    echo "✓ Unix user already exists: $username"
    return 0
  fi

  echo "👤 Creating Unix user: $username"

  # Create user with home directory
  sudo -n useradd -m -s /bin/bash "$username"

  # Set password to 'admin'
  echo "$username:admin" | sudo -n chpasswd

  # Create .agor directory
  sudo -n mkdir -p "/home/$username/.agor"

  # Copy Zellij config
  if [ -f "/home/agor/.config/zellij/config.kdl" ]; then
    sudo -n mkdir -p "/home/$username/.config/zellij"
    sudo -n cp /home/agor/.config/zellij/config.kdl "/home/$username/.config/zellij/"
  fi

  # Fix ownership
  sudo -n chown -R "$username:$username" "/home/$username"

  echo "✅ Unix user created: $username (password: admin)"
}

# Create alice and bob Unix users
if [ "$CREATE_RBAC_TEST_USERS" = "true" ]; then
  echo ""
  echo "👥 Creating test Unix users..."
  create_unix_user "alice"
  create_unix_user "bob"
  echo ""
fi

# Log the RBAC config the base entrypoint will apply. The public-facing
# AGOR_RBAC_ENABLED / AGOR_UNIX_USER_MODE → internal AGOR_SET_* translation is
# handled by the base entrypoint (docker-entrypoint.sh), so both the postgres
# and plain profiles use the same naming contract.
if [ -n "$AGOR_RBAC_ENABLED" ] || [ -n "$AGOR_UNIX_USER_MODE" ]; then
  echo "⚙️  RBAC settings from environment:"
  [ "$AGOR_RBAC_ENABLED" = "true" ] && echo "  execution.worktree_rbac = true"
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
