#!/usr/bin/env bash
# Build the throwaway Agor home + synthetic database the slow-network benchmark
# boots every daemon against. Never touches ~/.agor: HOME is redirected.
#
#   scripts/perf-slow-network/prepare-seed.sh /tmp/agor-bench-seed-home [--scale 1]
set -euo pipefail

SEED_HOME=${1:?usage: prepare-seed.sh <seed-home> [--scale N]}
shift
REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)

rm -rf "$SEED_HOME"
mkdir -p "$SEED_HOME/.agor"
cat >"$SEED_HOME/.agor/config.yaml" <<EOF
daemon:
  port: 4410
  deployment_id: $(node -e 'console.log(crypto.randomUUID())')
ui:
  port: 4410
execution:
  unix_user_mode: simple
EOF
cat >"$SEED_HOME/env.sh" <<EOF
export HOME=$SEED_HOME
export NODE_ENV=development
export AGOR_JWT_SECRET=$(openssl rand -hex 32)
export AGOR_MASTER_SECRET=$(openssl rand -hex 32)
export AGOR_ADMIN_PASSWORD=admin
export AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN=true
EOF
# shellcheck disable=SC1091
source "$SEED_HOME/env.sh"

cd "$REPO_ROOT/apps/agor-cli"
NODE_OPTIONS=--conditions=source npx tsx bin/dev.ts db migrate --yes --offline-cutover
NODE_OPTIONS=--conditions=source npx tsx bin/dev.ts local create-admin --dev-default

cd "$REPO_ROOT/apps/agor-daemon"
NODE_OPTIONS=--conditions=source npx tsx ../../scripts/perf-slow-network/seed-workspace.ts \
  --out "$SEED_HOME/bench-manifest.json" "$@" >"$SEED_HOME/seed.log"
tail -25 "$SEED_HOME/seed.log"

sqlite3 "$SEED_HOME/.agor/agor.db" "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 "$SEED_HOME/.agor/agor.db" "VACUUM INTO '$SEED_HOME/pristine.db'"
echo "seed ready: $SEED_HOME/pristine.db"
