#!/bin/sh
set -eu

# This volume subtree is disposable build state, not an Agor managed worktree.
export AGOR_RUNTIME_STATE=/home/agor/.agor/runtime-build
: "${AGOR_SOURCE_REPO:=https://github.com/preset-io/agor.git}"
: "${AGOR_SOURCE_BRANCH:?Set AGOR_SOURCE_BRANCH for runtime builds}"
export AGOR_SOURCE_REPO AGOR_SOURCE_BRANCH
mkdir -p /home/agor/.agor
sudo -n chown agor:agor /home/agor/.agor
mkdir -p "$AGOR_RUNTIME_STATE"
# Serialize startup and keep ownership until the daemon exits.
exec 9>"$AGOR_RUNTIME_STATE/start.lock"
flock -n 9 || { echo 'Another runtime-build instance owns this volume'; exit 1; }

echo 'Fetching runtime branch source...'
AGOR_BUILD_SHA=$(node /usr/local/lib/agor/runtime-checkout.mjs)
export AGOR_BUILD_SHA
echo "Runtime source commit: $AGOR_BUILD_SHA"

# Source is copied at RUNTIME, never into an image layer. Keep the image's
# platform-specific dependencies at their original pnpm workspace paths.
# /app is disposable container storage; never rsync into user-managed repos.
rsync -a --delete \
  --exclude=node_modules --exclude=dist --exclude=.turbo \
  "$AGOR_RUNTIME_STATE/checkout/" /app/
cd /app
# Optional shared SQLite watch runner; preserve the same data volume.
if [ "${AGOR_RUNTIME_MODE:-build}" = "watch" ]; then
  exec node /usr/local/lib/agor/runtime-watch.mjs
fi
export TURBO_CACHE_DIR="$AGOR_RUNTIME_STATE/turbo"
export CI=true pnpm_config_verify_deps_before_run=false
export NODE_ENV=production

# Share the existing source-release build and production bootstrap. Unlike the
# watch entrypoint, this does not unconditionally clear every package's dist.
# Keep operator credentials out of build/pack subprocess environments.
echo 'Building runtime release (persistent Turbo cache)...'
env -i PATH="$PATH" HOME="$HOME" CI=true NODE_ENV=production \
  pnpm_config_verify_deps_before_run=false \
  AGOR_BUILD_SHA="$AGOR_BUILD_SHA" TURBO_CACHE_DIR="$TURBO_CACHE_DIR" \
  bash packages/agor-live/build.sh --skip-install
env -i PATH="$PATH" HOME="$HOME" \
  npm install -g --prefix /opt/agor-runtime --ignore-scripts --no-audit --no-fund \
  packages/agor-live/release/agor-live-client-*.tgz \
  packages/agor-live/release/agor-live-[0-9]*.tgz
export PATH="/opt/agor-runtime/bin:$PATH"
# Explicit opt-in migration for an existing deployment; normal compose and
# production bootstrap policy remain unchanged. Never pass operator secrets to npm.
if [ -n "${AGOR_RUNTIME_ADD_TOOLS:-}" ]; then
  env -i PATH="$PATH" HOME="$HOME" agor init --skip-if-exists --non-interactive --agentic-tools "${AGOR_AGENTIC_TOOLS:-none}" \
    --daemon-port "${DAEMON_PORT:-3030}" --daemon-host "${DAEMON_HOST:-0.0.0.0}"
  node /app/docker/runtime-tools.mjs
  env -i PATH="$PATH" HOME="$HOME" agor install --sync
fi
exec /usr/local/bin/docker-entrypoint-prod.sh
