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
sudo /usr/sbin/sshd
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
  sudo useradd -m -s /bin/bash "$username"

  # Set password to 'admin'
  echo "$username:admin" | sudo chpasswd

  # Create .agor directory
  sudo mkdir -p "/home/$username/.agor"

  # Copy Zellij config
  if [ -f "/home/agor/.config/zellij/config.kdl" ]; then
    sudo mkdir -p "/home/$username/.config/zellij"
    sudo cp /home/agor/.config/zellij/config.kdl "/home/$username/.config/zellij/"
  fi

  # Fix ownership
  sudo chown -R "$username:$username" "/home/$username"

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

# Configure RBAC settings if environment variables are set
# This must happen BEFORE the base entrypoint runs, so config is set before daemon starts
if [ -n "$AGOR_RBAC_ENABLED" ] || [ -n "$AGOR_UNIX_USER_MODE" ]; then
  echo "⚙️  Configuring RBAC settings from environment..."

  # Wait for base initialization to create config file
  # (base entrypoint will call 'agor init' which creates ~/.agor/config.yaml)

  if [ "$AGOR_RBAC_ENABLED" = "true" ]; then
    echo "  Setting execution.worktree_rbac = true"
    export AGOR_SET_RBAC_FLAG="true"
  fi

  if [ -n "$AGOR_UNIX_USER_MODE" ]; then
    echo "  Setting execution.unix_user_mode = $AGOR_UNIX_USER_MODE"
    export AGOR_SET_UNIX_MODE="$AGOR_UNIX_USER_MODE"
  fi

  echo ""
fi

# Run base entrypoint to start daemon and UI
# This handles:
# - Building @agor/core
# - Database migrations
# - Creating admin user
# - Applying RBAC config (via AGOR_SET_* env vars)
# - Starting daemon and UI
echo "🚀 Running base initialization..."
exec /usr/local/bin/docker-entrypoint.sh
