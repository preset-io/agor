#!/usr/bin/env bash
#
# Migrate a self-hosted Agor deployment from unix_user_mode: strict/insulated to
# unix_user_mode: sandbox (the filesystem-sandbox isolation that replaces the
# Unix-account apparatus). See context/explorations/executor-sandboxing.md §7.
#
# What it does (in order):
#   1. Pre-flight the per-user home relocation (config path-independence).
#   2. Point each Agor user's `filesystem_home` at their EXISTING /home/<unix_username>
#      so the sandbox overlays their current home in place — NO files move.
#   3. chown the data tree + each per-user home to the daemon user, because under
#      `sandbox` everything runs as the daemon user (Agor owns its filesystem).
#   4. Flip execution.unix_user_mode → sandbox in config.yaml.
#   5. (Optional, --teardown) remove the OS plumbing: per-branch groups + sudoers.
#
# SAFETY: dry-run by DEFAULT. It prints every action and changes nothing until
# you pass --apply. chown of real home dirs is irreversible-ish; read the plan.
#
# SQLite only for the DB step (the common self-hosted case). For Postgres, the
# script prints the SQL to run yourself.
#
# Usage:
#   scripts/strict-to-sandbox-migration.sh [--apply] [--teardown]
#       [--data-home DIR] [--daemon-user USER] [--config FILE]
set -euo pipefail

APPLY=0
TEARDOWN=0
DATA_HOME="${AGOR_DATA_HOME:-$HOME/.agor}"
DAEMON_USER="$(id -un)"
CONFIG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --teardown) TEARDOWN=1 ;;
    --data-home) DATA_HOME="$2"; shift ;;
    --daemon-user) DAEMON_USER="$2"; shift ;;
    --config) CONFIG="$2"; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

CONFIG="${CONFIG:-$DATA_HOME/config.yaml}"
DB="$DATA_HOME/agor.db"
here="$(cd "$(dirname "$0")" && pwd)"

say() { echo "  $*"; }
run() {
  if [ "$APPLY" = "1" ]; then say "RUN : $*"; eval "$@";
  else say "DRY : $*"; fi
}

echo "== strict → sandbox migration =="
echo "mode        : $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"
echo "data home   : $DATA_HOME"
echo "daemon user : $DAEMON_USER"
echo "config      : $CONFIG"
echo "db          : $DB"
echo

# ── 1. pre-flight home path-independence ────────────────────────────────────
echo "-- step 1: pre-flight per-user home relocation --"
if [ -x "$here/sandbox-home-migration-preflight.sh" ]; then
  "$here/sandbox-home-migration-preflight.sh" '/home/*' || {
    echo "Pre-flight found blockers. Resolve them before migrating." >&2; exit 1;
  }
else
  say "(pre-flight script not found; skipping)"
fi
echo

# ── 1b. ownership manifest (cheap rollback insurance, no 1TB backup needed) ──
# chown -R is not reversible without knowing the prior owners. Capturing a
# text manifest of <owner> <group> <path> is tiny (even for ~1TB of files) and
# lets you reconstruct per-user ownership if you must roll back to strict.
echo "-- step 1b: capture ownership manifest --"
MANIFEST="$DATA_HOME/ownership-manifest-pre-sandbox.txt"
run "find '$DATA_HOME' /home -xdev -printf '%u %g %p\\n' > '$MANIFEST' 2>/dev/null || true"
say "manifest → $MANIFEST (restore with: while read u g p; do chown \"\$u:\$g\" \"\$p\"; done < manifest)"
echo

# ── 2. + 3. per-user: set filesystem_home + chown home in place ─────────────
echo "-- step 2/3: per-user filesystem_home + chown --"
declare -a USER_ROWS=()
if [ -f "$DB" ] && command -v sqlite3 >/dev/null; then
  # user_id | unix_username for users that have a Unix account
  while IFS='|' read -r uid uname; do
    [ -n "$uid" ] && USER_ROWS+=("$uid|$uname")
  done < <(sqlite3 "$DB" "SELECT user_id, unix_username FROM users WHERE unix_username IS NOT NULL AND unix_username != '';" 2>/dev/null || true)
else
  say "(no sqlite agor.db — for Postgres, run the printed SQL manually)"
fi

for row in "${USER_ROWS[@]:-}"; do
  [ -z "$row" ] && continue
  uid="${row%%|*}"; uname="${row##*|}"
  home="$(getent passwd "$uname" | cut -d: -f6)"
  if [ -z "$home" ] || [ ! -d "$home" ]; then
    say "SKIP user $uid ($uname): no home dir found"; continue
  fi
  say "user $uid ($uname) → filesystem_home=$home"
  if [ -f "$DB" ] && command -v sqlite3 >/dev/null; then
    run "sqlite3 '$DB' \"UPDATE users SET filesystem_home='$home' WHERE user_id='$uid';\""
  else
    echo "      SQL: UPDATE users SET filesystem_home='$home' WHERE user_id='$uid';"
  fi
  # chown the home so the daemon user can read/write the overlaid tool state.
  run "chown -R '$DAEMON_USER':'$DAEMON_USER' '$home'"
done

# data tree (worktrees + repos + config + db) → daemon user
say "chown the Agor data tree → $DAEMON_USER"
run "chown -R '$DAEMON_USER':'$DAEMON_USER' '$DATA_HOME'"
echo

# ── 4. flip config ──────────────────────────────────────────────────────────
echo "-- step 4: set execution.unix_user_mode: sandbox --"
if [ -f "$CONFIG" ]; then
  if grep -qE '^\s*unix_user_mode:' "$CONFIG"; then
    run "sed -i.bak -E 's/^(\s*)unix_user_mode:.*/\1unix_user_mode: sandbox/' '$CONFIG'"
  else
    say "no unix_user_mode line found — add manually under execution::"
    echo "      execution:"
    echo "        unix_user_mode: sandbox"
  fi
else
  say "config not found at $CONFIG — set execution.unix_user_mode: sandbox manually"
fi
echo

# ── 5. optional teardown of the OS plumbing ─────────────────────────────────
if [ "$TEARDOWN" = "1" ]; then
  echo "-- step 5: teardown OS plumbing (per-branch groups + sudoers) --"
  say "remove per-branch groups (agor_wt_*)"
  run "getent group | awk -F: '/^agor_wt_/{print \$1}' | xargs -r -n1 groupdel"
  say "remove daemon sudoers"
  run "rm -f /etc/sudoers.d/agor-daemon"
  say "NOTE: leave unix accounts in place until you've confirmed sandbox works."
  echo
fi

echo "== done ($([ "$APPLY" = 1 ] && echo APPLIED || echo DRY-RUN)) =="
[ "$APPLY" = 1 ] || echo "Re-run with --apply to execute. Restart the daemon afterward."
