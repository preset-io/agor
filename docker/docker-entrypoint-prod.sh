#!/bin/sh
set -e

echo "🚀 Starting Agor production environment..."

# The image starts as root only for this fixed, non-configurable volume path.
# Never run Agor code, migrations, or user-controlled commands before dropping
# privilege. -xdev prevents crossing into nested mounts and -h does not follow
# symlink targets.
if [ "$(id -u)" -eq 0 ]; then
  install -d -o agor -g agor -m 0700 /home/agor/.agor
  find /home/agor/.agor -xdev -exec chown -h agor:agor {} +
  exec gosu agor "$0" "$@"
fi

if [ "$(id -u)" -ne "$(id -u agor)" ]; then
  echo "Production entrypoint must run as root or agor" >&2
  exit 1
fi

# Initialize database and configure daemon settings
# --skip-if-exists: Idempotent, won't overwrite existing database
# --set-config: Always update daemon config (for Docker networking)
echo "📦 Initializing Agor environment..."
agor init \
  --skip-if-exists \
  --set-config \
  --daemon-port "${DAEMON_PORT:-3030}" \
  --daemon-host "${DAEMON_HOST:-0.0.0.0}"

# Run schema migrations before daemon startup. The production entrypoint creates
# /home/agor/.agor before `agor init`, so init is intentionally idempotent and
# may skip DB creation; this migration step replaces the old create-admin side
# effect that used to run migrations.
echo "🔄 Running database migrations..."
agor db migrate --yes

# Do NOT create a fixed default admin here.
#
# On first daemon start, the daemon's first-run bootstrap creates the initial
# superadmin only when the users table is empty:
#   - If AGOR_ADMIN_PASSWORD is set, that operator-provided password is used
#     and is never echoed back to logs.
#   - Otherwise, a random password is written to
#     /home/agor/.agor/admin-credentials with mode 0600, and logs only point
#     at that file path.
#
# This keeps production images idempotent without shipping a takeover-grade
# admin@agor.live/admin credential in every fresh deployment.
echo "👤 Admin bootstrap will be handled by daemon first-run setup."

# Start daemon in foreground (this keeps container alive)
echo "🚀 Starting daemon on port ${DAEMON_PORT:-3030}..."
exec agor-daemon
