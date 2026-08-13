#!/usr/bin/env bash
# Agor one-line installer — https://agor.live/install.sh
#
#   curl -fsSL https://agor.live/install.sh | bash
#
# Installs agor-live via npm, runs a non-interactive `agor init`, starts the
# daemon, and opens the UI. Safe to re-run: `agor init --skip-if-exists` and
# `agor daemon start` are both idempotent no-ops on an existing install.
#
# Env overrides:
#   AGOR_AGENTIC_TOOLS   comma-separated tool list, "all", or "none" (default: all)
#   AGOR_VERSION         npm dist-tag or version to install (default: latest)
set -euo pipefail

BOLD='\033[1m'
DIM='\033[2m'
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
RESET='\033[0m'

info() { printf '%b\n' "${DIM}$*${RESET}"; }
ok() { printf '%b\n' "${GREEN}✓${RESET} $*"; }
warn() { printf '%b\n' "${YELLOW}!${RESET} $*"; }
fail() {
  printf '%b\n' "${RED}✗ $*${RESET}" >&2
  exit 1
}

# --- Prerequisites -----------------------------------------------------
command -v git >/dev/null 2>&1 ||
  fail "Git is required but wasn't found on PATH. Install it from https://git-scm.com/downloads and re-run this script."

command -v node >/dev/null 2>&1 ||
  fail "Node.js >= 22.12 is required but wasn't found. Install it from https://nodejs.org and re-run this script."

command -v npm >/dev/null 2>&1 ||
  fail "npm is required but wasn't found (it normally ships with Node.js)."

node_version="$(node -v | sed 's/^v//')"
node_major="${node_version%%.*}"
node_minor="$(echo "$node_version" | cut -d. -f2)"
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 12 ]; }; then
  fail "Node.js >= 22.12 is required (found v${node_version}). Upgrade at https://nodejs.org and re-run this script."
fi

ok "Prerequisites OK (Node v${node_version}, git, npm)"

# --- Install -------------------------------------------------------------
info "Installing agor-live@${AGOR_VERSION:-latest}..."
npm install -g "agor-live@${AGOR_VERSION:-latest}" ||
  fail "npm install -g agor-live failed. See the npm output above."
ok "agor-live installed"

if ! command -v agor >/dev/null 2>&1; then
  npm_prefix="$(npm config get prefix 2>/dev/null || true)"
  fail "agor-live installed, but the 'agor' command isn't on PATH yet.
This usually means npm's global bin directory isn't in your PATH. Add it and re-run this script, or run these manually:
  export PATH=\"${npm_prefix}/bin:\$PATH\"
  agor init --non-interactive --skip-if-exists --agentic-tools \"${AGOR_AGENTIC_TOOLS:-all}\"
  agor daemon start
  agor open"
fi

info "Initializing Agor (agentic-tools=${AGOR_AGENTIC_TOOLS:-all})..."
agor init --non-interactive --skip-if-exists --agentic-tools "${AGOR_AGENTIC_TOOLS:-all}" ||
  fail "agor init failed. See the output above."
ok "Agor initialized"

info "Starting the daemon..."
agor daemon start || fail "agor daemon start failed. See the output above."

# UI URL for a package install (agor open's own hardcoded default for this
# case — see apps/agor-cli/src/lib/context.js's getUIUrl()).
DAEMON_URL="http://localhost:3030"
UI_URL="${DAEMON_URL}/ui"

# `agor daemon start` spawns a detached process and returns immediately, so
# the daemon may still be booting. Poll its health endpoint directly rather
# than repeatedly invoking `agor open`: isDaemonRunning() (packages/core/src
# /api/index.ts) gives that check a hard 1000ms timeout, and spawning a
# fresh `agor` CLI process every second competes with the daemon for CPU —
# under that load `agor open` can keep reporting "not running" well past
# the point a plain curl confirms the daemon is actually healthy (verified
# live: curl succeeded at 3s while a parallel agor-open retry loop was still
# failing at 60s+). curl is cheap enough not to cause that contention itself.
info "Waiting for the daemon..."
attempt=0
healthy=0
while [ "$healthy" -eq 0 ]; do
  if curl -fsS -m 2 "${DAEMON_URL}/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    break
  fi
  sleep 1
done

echo
if [ "$healthy" -eq 1 ]; then
  info "Opening Agor..."
  # Best-effort: agor open re-checks readiness itself with that same 1000ms
  # timeout, so it can occasionally print a stale "not running" here even
  # though the curl check above already confirmed the daemon is healthy —
  # don't let that flakiness affect overall success.
  agor open || true
  ok "${BOLD}Agor is ready${RESET} at ${BOLD}${UI_URL}${RESET}. If a browser tab didn't open, visit that URL."
else
  warn "Agor is installed, but the daemon didn't report healthy within 60s. Check ~/.agor/logs/daemon.log, then try: agor open (${UI_URL})"
fi
