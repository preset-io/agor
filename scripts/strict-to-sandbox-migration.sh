#!/usr/bin/env bash
#
# Migrate a self-hosted Agor deployment from unix_user_mode: strict/insulated
# to unix_user_mode: sandbox. Dry-run is the default; --apply mutates state.
#
# The script supports tenant-scoped PostgreSQL through DATABASE_URL and local
# SQLite through <data-home>/agor.db. PostgreSQL callers must name the tenant
# whose visible users are being migrated. Deploy database migrations first so
# users.filesystem_home exists before running this script.
#
# Usage:
#   scripts/strict-to-sandbox-migration.sh [--apply | --prepare-only] [--resume]
#       [--teardown]
#       [--data-home DIR] [--daemon-user USER] [--config FILE]
#       [--database-url URL] [--tenant-id ID] [--expected-user-count N]
#       [--manifest FILE] [--skip-manifest] [--service-name NAME]
set -euo pipefail

APPLY=0
PREPARE_ONLY=0
RESUME=0
TEARDOWN=0
SKIP_MANIFEST=0
DATA_HOME="${AGOR_DATA_HOME:-$HOME/.agor}"
DAEMON_USER="$(id -un)"
CONFIG=""
DATABASE_URL_VALUE="${DATABASE_URL:-}"
PGDATABASE_URL_SAFE=""
PGPASSWORD_VALUE=""
TENANT_ID="${AGOR_TENANT_ID:-default}"
EXPECTED_USER_COUNT=""
MANIFEST=""
SERVICE_NAME="agor-daemon"
DB_SQL_TMP=""
CONFIG_TMP=""
MANIFEST_TMP=""
OWNERSHIP_PLAN_TMP=""
OWNERSHIP_PROGRESS_TMP=""
OWNERSHIP_COUNTER=""

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "  $*"; }
cleanup() {
  [ -z "$DB_SQL_TMP" ] || rm -f -- "$DB_SQL_TMP"
  [ -z "$CONFIG_TMP" ] || rm -f -- "$CONFIG_TMP"
  [ -z "$MANIFEST_TMP" ] || rm -f -- "$MANIFEST_TMP"
  [ -z "$OWNERSHIP_PLAN_TMP" ] || rm -f -- "$OWNERSHIP_PLAN_TMP"
  [ -z "$OWNERSHIP_PROGRESS_TMP" ] || rm -f -- "$OWNERSHIP_PROGRESS_TMP"
  [ -z "$OWNERSHIP_COUNTER" ] || rm -f -- "$OWNERSHIP_COUNTER"
}
trap cleanup EXIT

require_value() {
  [ $# -ge 2 ] && [ -n "$2" ] || { echo "$1 requires a value" >&2; exit 2; }
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --prepare-only) APPLY=1; PREPARE_ONLY=1 ;;
    --resume) RESUME=1 ;;
    --teardown) TEARDOWN=1 ;;
    --skip-manifest) SKIP_MANIFEST=1 ;;
    --data-home) require_value "$@"; DATA_HOME="$2"; shift ;;
    --daemon-user) require_value "$@"; DAEMON_USER="$2"; shift ;;
    --config) require_value "$@"; CONFIG="$2"; shift ;;
    --database-url) require_value "$@"; DATABASE_URL_VALUE="$2"; shift ;;
    --tenant-id) require_value "$@"; TENANT_ID="$2"; shift ;;
    --expected-user-count) require_value "$@"; EXPECTED_USER_COUNT="$2"; shift ;;
    --manifest) require_value "$@"; MANIFEST="$2"; shift ;;
    --service-name) require_value "$@"; SERVICE_NAME="$2"; shift ;;
    -h|--help) grep '^#' "$0" | tail -n +2 | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

CONFIG="${CONFIG:-$DATA_HOME/config.yaml}"
SQLITE_DB="$DATA_HOME/agor.db"
MANIFEST="${MANIFEST:-$DATA_HOME/ownership-manifest-pre-sandbox.tsv.gz}"
CONFIG_BACKUP="$CONFIG.pre-sandbox"
OWNERSHIP_PLAN="$MANIFEST.ownership-plan"
OWNERSHIP_PROGRESS="$MANIFEST.ownership-progress"
here="$(cd "$(dirname "$0")" && pwd)"

[[ "$DATA_HOME" = /* ]] || die "data home must be absolute: $DATA_HOME"
[ "$DATA_HOME" != "/" ] || die "refusing to use / as the data home"
[[ "$CONFIG" = /* ]] || die "config path must be absolute: $CONFIG"
[[ "$MANIFEST" = /* ]] || die "manifest path must be absolute: $MANIFEST"
if [ "$PREPARE_ONLY" = 1 ] && [ "$TEARDOWN" = 1 ]; then
  die "--prepare-only cannot be combined with --teardown"
fi
if [ "$PREPARE_ONLY" = 1 ] && [ "$SKIP_MANIFEST" = 1 ]; then
  die "--prepare-only requires the ownership manifest"
fi
[[ "$TENANT_ID" =~ ^[A-Za-z0-9_-]+$ ]] || die "tenant id contains unsupported characters"
if [ -n "$EXPECTED_USER_COUNT" ]; then
  [[ "$EXPECTED_USER_COUNT" =~ ^[0-9]+$ ]] || die "expected user count must be a non-negative integer"
fi
[ -d "$DATA_HOME" ] || die "data home not found: $DATA_HOME"
[ -f "$CONFIG" ] || die "config not found: $CONFIG"
id "$DAEMON_USER" >/dev/null 2>&1 || die "daemon user does not exist: $DAEMON_USER"
DAEMON_GROUP="$(id -gn "$DAEMON_USER")"
DAEMON_HOME="$(getent passwd "$DAEMON_USER" | cut -d: -f6 || true)"
[ -n "$DAEMON_HOME" ] && [ -d "$DAEMON_HOME" ] || die "daemon passwd home not found"

mapfile -t CONFIG_MODES < <(
  sed -nE 's/^[[:space:]]*unix_user_mode:[[:space:]]*([^#[:space:]]+).*/\1/p' "$CONFIG"
)
[ "${#CONFIG_MODES[@]}" -eq 1 ] || die "config must contain exactly one unix_user_mode entry"
CURRENT_MODE="${CONFIG_MODES[0]}"
case "$CURRENT_MODE" in
  strict|insulated) ;;
  sandbox) [ "$RESUME" = 1 ] || die "config is already in sandbox mode; use --resume if intentional" ;;
  *) die "expected unix_user_mode strict or insulated, found: $CURRENT_MODE" ;;
esac

if [ "$APPLY" = 1 ]; then
  [ "$EUID" -eq 0 ] || die "--apply/--prepare-only must run as root"
  if command -v systemctl >/dev/null && systemctl is-active --quiet "$SERVICE_NAME"; then
    die "$SERVICE_NAME is active; drain work and stop the daemon before --apply"
  fi
elif [ "$EUID" -ne 0 ]; then
  say "WARNING: run the final dry-run as root so pre-flight can read every credential file"
fi

if [[ "$DATABASE_URL_VALUE" =~ ^postgres(ql)?:// ]]; then
  DB_KIND="postgres"
  command -v psql >/dev/null || die "psql is required for PostgreSQL migration"
  command -v node >/dev/null || die "node is required to parse the PostgreSQL URL safely"
  pg_parts_output="$(
    AGOR_MIGRATION_DATABASE_URL="$DATABASE_URL_VALUE" node <<'NODE'
const url = new URL(process.env.AGOR_MIGRATION_DATABASE_URL);
const queryPassword = url.searchParams.get('password');
const password = queryPassword ?? decodeURIComponent(url.password);
url.password = '';
url.searchParams.delete('password');
console.log(`url:${Buffer.from(url.toString()).toString('base64')}`);
console.log(`password:${Buffer.from(password).toString('base64')}`);
NODE
  )"
  mapfile -t pg_parts <<< "$pg_parts_output"
  [ "${#pg_parts[@]}" -eq 2 ] || die "could not parse PostgreSQL URL"
  [[ "${pg_parts[0]}" = url:* ]] || die "could not parse PostgreSQL URL"
  [[ "${pg_parts[1]}" = password:* ]] || die "could not parse PostgreSQL password"
  PGDATABASE_URL_SAFE="$(printf '%s' "${pg_parts[0]#url:}" | base64 -d)"
  PGPASSWORD_VALUE="$(printf '%s' "${pg_parts[1]#password:}" | base64 -d)"
elif [ -n "$DATABASE_URL_VALUE" ]; then
  die "unsupported database URL for this migration; expected postgres:// or postgresql://"
elif [ -f "$SQLITE_DB" ]; then
  DB_KIND="sqlite"
  command -v sqlite3 >/dev/null || die "sqlite3 is required for SQLite migration"
else
  die "no PostgreSQL DATABASE_URL or SQLite database found"
fi
if [ "$APPLY" = 1 ] && [ "$DB_KIND" = "postgres" ] && [ -z "$EXPECTED_USER_COUNT" ]; then
  die "PostgreSQL --apply requires --expected-user-count to guard against an incomplete RLS scope"
fi
if [ "$TEARDOWN" = 1 ] && [ "$DB_KIND" = "postgres" ]; then
  die "--teardown is unavailable with PostgreSQL because tenant-scoped RLS cannot prove host-global Unix state"
fi
if [ -e "$CONFIG_BACKUP" ] && [ "$RESUME" = 0 ]; then
  die "config backup already exists; preserve it and rerun with --resume"
fi
if [ -e "$OWNERSHIP_PLAN" ] && [ "$RESUME" = 0 ]; then
  die "ownership plan already exists; preserve it and rerun with --resume"
fi
if [ -e "$OWNERSHIP_PROGRESS" ] && [ "$RESUME" = 0 ]; then
  die "ownership progress already exists; preserve it and rerun with --resume"
fi

echo "== strict -> sandbox migration =="
if [ "$PREPARE_ONLY" = 1 ]; then
  RUN_MODE="PREPARE-ONLY"
elif [ "$APPLY" = 1 ]; then
  RUN_MODE="APPLY"
else
  RUN_MODE="DRY-RUN"
fi
echo "mode          : $RUN_MODE"
echo "resume        : $([ "$RESUME" = 1 ] && echo yes || echo no)"
echo "data home     : $DATA_HOME"
echo "daemon owner  : $DAEMON_USER:$DAEMON_GROUP"
echo "daemon home   : $DAEMON_HOME"
echo "config        : $CONFIG"
echo "database      : $DB_KIND"
echo "tenant        : $TENANT_ID"
echo "manifest      : $([ "$SKIP_MANIFEST" = 1 ] && echo SKIPPED || echo "$MANIFEST")"
echo "owner plan    : $OWNERSHIP_PLAN"
echo "owner progress: $OWNERSHIP_PROGRESS"
echo

postgres_psql() {
  PGPASSWORD="$PGPASSWORD_VALUE" psql "$PGDATABASE_URL_SAFE" -X -v ON_ERROR_STOP=1 "$@"
}

declare -a OWNERSHIP_UNITS=()

add_ownership_unit() {
  local kind="$1"
  local depth="$2"
  local path="$3"
  case "$kind" in
    tree|shallow) ;;
    *) die "unsupported ownership unit type: $kind" ;;
  esac
  [[ "$depth" =~ ^[0-9]+$ ]] || die "invalid ownership unit depth: $depth"
  case "$path" in
    *'|'*|*$'\n'*|*$'\r'*) die "ownership unit path contains an unsupported delimiter: $path" ;;
  esac
  [ -e "$path" ] || [ -L "$path" ] || die "ownership unit disappeared: $path"
  OWNERSHIP_UNITS+=("$kind|$depth|$path")
}

build_ownership_plan() {
  local child owner repo
  local repos_root="$DATA_HOME_CANONICAL/repos"
  local worktrees_root="$DATA_HOME_CANONICAL/worktrees"

  [ ! -L "$repos_root" ] || die "managed repos root must not be a symlink: $repos_root"
  [ ! -L "$worktrees_root" ] || die "managed worktrees root must not be a symlink: $worktrees_root"

  OWNERSHIP_UNITS=()
  # The root unit handles only scaffolding and top-level files. Large managed
  # trees are separate units so a resume never repeats the entire data root.
  add_ownership_unit shallow 1 "$DATA_HOME_CANONICAL"

  shopt -s dotglob nullglob
  for child in "$DATA_HOME_CANONICAL"/*; do
    [ -d "$child" ] && [ ! -L "$child" ] || continue
    case "$child" in
      "$repos_root"|"$worktrees_root") ;;
      *) add_ownership_unit tree 0 "$child" ;;
    esac
  done

  if [ -d "$repos_root" ] && [ ! -L "$repos_root" ]; then
    add_ownership_unit shallow 1 "$repos_root"
    for repo in "$repos_root"/*; do
      [ -d "$repo" ] && [ ! -L "$repo" ] || continue
      add_ownership_unit tree 0 "$repo"
    done
  fi

  if [ -d "$worktrees_root" ] && [ ! -L "$worktrees_root" ]; then
    add_ownership_unit shallow 2 "$worktrees_root"
    for owner in "$worktrees_root"/*; do
      [ -d "$owner" ] && [ ! -L "$owner" ] || continue
      for repo in "$owner"/*; do
        [ -d "$repo" ] && [ ! -L "$repo" ] || continue
        add_ownership_unit tree 0 "$repo"
      done
    done
  fi
  shopt -u dotglob nullglob

  # Homes are deliberately last. Owner-only conversion preserves branch/repo
  # group ACLs, while keeping homes untouched as long as possible improves the
  # chance of a cheap strict-mode abort before the final phase.
  for row in "${HOME_ROWS[@]}"; do
    IFS='|' read -r tenant_id user_id unix_username home home_canonical <<< "$row"
    add_ownership_unit tree 0 "$home_canonical"
  done
}

render_ownership_plan() {
  local index=0 unit
  for unit in "${OWNERSHIP_UNITS[@]}"; do
    index=$((index + 1))
    printf '%06d|%s\n' "$index" "$unit"
  done
}

echo "-- step 1: resolve database users and host homes --"
declare -a USER_ROWS=()
if [ "$DB_KIND" = "postgres" ]; then
  column_exists="$(
    postgres_psql -Atqc \
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'filesystem_home')"
  )"
  [ "$column_exists" = "t" ] || die "users.filesystem_home is missing; deploy database migrations first"
  user_rows_output="$(
    postgres_psql -v agor_tenant="$TENANT_ID" -At -F '|' <<'SQL'
SELECT set_config('agor.tenant_id', :'agor_tenant', false) \gset
SELECT tenant_id::text, user_id::text, unix_username
FROM users
WHERE unix_username IS NOT NULL AND unix_username <> ''
ORDER BY user_id;
SQL
  )"
else
  column_exists="$(sqlite3 "$SQLITE_DB" "SELECT count(*) FROM pragma_table_info('users') WHERE name = 'filesystem_home';")"
  [ "$column_exists" = "1" ] || die "users.filesystem_home is missing; deploy database migrations first"
  user_rows_output="$(
    sqlite3 -separator '|' "$SQLITE_DB" \
      "SELECT tenant_id, user_id, unix_username FROM users WHERE tenant_id = '$TENANT_ID' AND unix_username IS NOT NULL AND unix_username != '' ORDER BY user_id;"
  )"
fi
while IFS= read -r row; do [ -z "$row" ] || USER_ROWS+=("$row"); done <<< "$user_rows_output"

[ "${#USER_ROWS[@]}" -gt 0 ] || die "no users with Unix identities are visible for tenant $TENANT_ID"
if [ -n "$EXPECTED_USER_COUNT" ] && [ "${#USER_ROWS[@]}" -ne "$EXPECTED_USER_COUNT" ]; then
  die "expected $EXPECTED_USER_COUNT Unix identities, database returned ${#USER_ROWS[@]}"
fi

declare -a HOME_ROWS=()
DATA_HOME_CANONICAL="$(readlink -f "$DATA_HOME")"
declare -A SEEN_HOME_ROOTS=()
for row in "${USER_ROWS[@]}"; do
  IFS='|' read -r tenant_id user_id unix_username extra <<< "$row"
  [ -z "${extra:-}" ] || die "database row contains an unsupported | delimiter"
  [ "$tenant_id" = "$TENANT_ID" ] || die "database returned tenant $tenant_id while scoped to $TENANT_ID"
  home="$(getent passwd "$unix_username" | cut -d: -f6 || true)"
  [ -n "$home" ] && [ -d "$home" ] || die "no host home for $unix_username ($user_id)"
  [[ "$home" = /* ]] && [ "$home" != "/" ] || die "unsafe host home for $unix_username: $home"
  [[ "$home" != *'|'* ]] || die "host home contains unsupported | delimiter: $home"
  home_canonical="$(readlink -f "$home")"
  [[ "$home_canonical" != *'|'* ]] || die "canonical home contains unsupported | delimiter: $home_canonical"
  if [ "$home_canonical" = "$DATA_HOME_CANONICAL" ] || \
    [[ "$home_canonical" = "$DATA_HOME_CANONICAL/"* ]] || \
    [[ "$DATA_HOME_CANONICAL" = "$home_canonical/"* ]]; then
    die "host home overlaps the Agor data root for $unix_username: $home"
  fi
  [ -z "${SEEN_HOME_ROOTS[$home_canonical]+x}" ] || \
    die "multiple Unix identities resolve to the same home: $home_canonical"
  SEEN_HOME_ROOTS["$home_canonical"]="$unix_username"
  HOME_ROWS+=("$tenant_id|$user_id|$unix_username|$home|$home_canonical")
  if [ "$home" = "$home_canonical" ]; then
    say "$user_id ($unix_username) -> $home"
  else
    say "$user_id ($unix_username) -> $home (canonical: $home_canonical)"
  fi
done
say "resolved ${#HOME_ROWS[@]} Unix-backed users"
echo

echo "-- step 2: pre-flight per-user home relocation --"
[ -x "$here/sandbox-home-migration-preflight.sh" ] || die "pre-flight script not found"
for row in "${HOME_ROWS[@]}"; do
  IFS='|' read -r tenant_id user_id unix_username home home_canonical <<< "$row"
  "$here/sandbox-home-migration-preflight.sh" "$home" --stable-home "$DAEMON_HOME"
done
echo

build_ownership_plan
say "planned ${#OWNERSHIP_UNITS[@]} restartable ownership units"
echo

if [ "$SKIP_MANIFEST" = 0 ]; then
  echo "-- step 3: ownership manifest --"
  if [ -f "$MANIFEST" ]; then
    [ "$RESUME" = 1 ] || die "manifest already exists; preserve it and rerun with --resume"
    gzip -t "$MANIFEST" || die "existing manifest is corrupt: $MANIFEST"
    say "reusing verified manifest: $MANIFEST"
  elif [ "$APPLY" = 1 ]; then
    MANIFEST_TMP="$MANIFEST.partial.$$"
    [ ! -e "$MANIFEST_TMP" ] || die "temporary manifest already exists: $MANIFEST_TMP"
    umask 077
    say "capturing numeric owner/group/path records; this may be several GB before compression"
    declare -a manifest_roots=("$DATA_HOME_CANONICAL")
    for row in "${HOME_ROWS[@]}"; do
      IFS='|' read -r tenant_id user_id unix_username home home_canonical <<< "$row"
      already_added=0
      for root in "${manifest_roots[@]}"; do
        [ "$root" != "$home_canonical" ] || already_added=1
      done
      [ "$already_added" = 1 ] || manifest_roots+=("$home_canonical")
    done
    manifest_canonical="$(readlink -m "$MANIFEST")"
    manifest_tmp_canonical="$(readlink -m "$MANIFEST_TMP")"
    find "${manifest_roots[@]}" -xdev \
      ! -path "$MANIFEST" ! -path "$MANIFEST_TMP" \
      ! -path "$manifest_canonical" ! -path "$manifest_tmp_canonical" \
      -printf '%U\t%G\t%p\0' | gzip -1 > "$MANIFEST_TMP"
    gzip -t "$MANIFEST_TMP"
    mv "$MANIFEST_TMP" "$MANIFEST"
    MANIFEST_TMP=""
    say "manifest complete: $MANIFEST"
  else
    say "would create compressed, NUL-delimited manifest: $MANIFEST"
  fi
  echo
fi

echo "-- step 4: preserve operator config --"
if [ "$APPLY" = 1 ]; then
  if [ -e "$CONFIG_BACKUP" ]; then
    say "reusing config backup: $CONFIG_BACKUP"
  else
    cp --preserve=all -- "$CONFIG" "$CONFIG_BACKUP"
    say "config backup complete: $CONFIG_BACKUP"
  fi
else
  say "would preserve config at $CONFIG_BACKUP"
fi
echo

echo "-- step 5: freeze restartable ownership plan --"
if [ "$APPLY" = 1 ]; then
  OWNERSHIP_PLAN_TMP="$(mktemp "$OWNERSHIP_PLAN.partial.XXXXXX")"
  chmod 600 "$OWNERSHIP_PLAN_TMP"
  render_ownership_plan > "$OWNERSHIP_PLAN_TMP"
  if [ -e "$OWNERSHIP_PLAN" ]; then
    [ "$RESUME" = 1 ] || die "ownership plan already exists: $OWNERSHIP_PLAN"
    cmp -s "$OWNERSHIP_PLAN_TMP" "$OWNERSHIP_PLAN" || \
      die "current ownership roots differ from the preserved plan: $OWNERSHIP_PLAN"
    rm -f -- "$OWNERSHIP_PLAN_TMP"
    OWNERSHIP_PLAN_TMP=""
    say "reusing verified ownership plan: $OWNERSHIP_PLAN"
  else
    mv "$OWNERSHIP_PLAN_TMP" "$OWNERSHIP_PLAN"
    OWNERSHIP_PLAN_TMP=""
    say "ownership plan complete: $OWNERSHIP_PLAN"
  fi

  PLAN_SHA256="$(sha256sum "$OWNERSHIP_PLAN" | awk '{print $1}')"
  if [ "$SKIP_MANIFEST" = 1 ]; then
    MANIFEST_SHA256="skipped"
  else
    MANIFEST_SHA256="$(sha256sum "$MANIFEST" | awk '{print $1}')"
  fi
  if [ -e "$OWNERSHIP_PROGRESS" ]; then
    [ "$RESUME" = 1 ] || die "ownership progress already exists: $OWNERSHIP_PROGRESS"
    grep -qxF 'version=1' "$OWNERSHIP_PROGRESS" || die "unsupported ownership progress format"
    grep -qxF "plan_sha256=$PLAN_SHA256" "$OWNERSHIP_PROGRESS" || \
      die "ownership progress does not match the preserved plan"
    grep -qxF "manifest_sha256=$MANIFEST_SHA256" "$OWNERSHIP_PROGRESS" || \
      die "ownership progress does not match the preserved manifest"
    say "reusing verified ownership progress: $OWNERSHIP_PROGRESS"
  else
    OWNERSHIP_PROGRESS_TMP="$(mktemp "$OWNERSHIP_PROGRESS.partial.XXXXXX")"
    chmod 600 "$OWNERSHIP_PROGRESS_TMP"
    printf 'version=1\nplan_sha256=%s\nmanifest_sha256=%s\n' \
      "$PLAN_SHA256" "$MANIFEST_SHA256" > "$OWNERSHIP_PROGRESS_TMP"
    mv "$OWNERSHIP_PROGRESS_TMP" "$OWNERSHIP_PROGRESS"
    OWNERSHIP_PROGRESS_TMP=""
    say "ownership progress initialized: $OWNERSHIP_PROGRESS"
  fi
  sync -f "$CONFIG_BACKUP" "$OWNERSHIP_PLAN" "$OWNERSHIP_PROGRESS"
  [ "$SKIP_MANIFEST" = 1 ] || sync -f "$MANIFEST"
else
  say "would freeze ${#OWNERSHIP_UNITS[@]} ownership units and initialize durable progress"
fi
echo

if [ "$PREPARE_ONLY" = 1 ]; then
  echo "== done (PREPARED; no database, ownership, or mode mutation) =="
  echo "Review and preserve the artifacts, then rerun the exact command with --apply --resume."
  exit 0
fi

sql_quote() {
  local value="$1"
  value="${value//\'/\'\'}"
  printf "'%s'" "$value"
}

echo "-- step 6: set users.filesystem_home transactionally --"
if [ "$APPLY" = 1 ]; then
  DB_SQL_TMP="$(mktemp)"
  chmod 600 "$DB_SQL_TMP"
  if [ "$DB_KIND" = "postgres" ]; then
    {
      echo 'BEGIN;'
      printf 'SELECT set_config(%s, %s, true);\n' "$(sql_quote 'agor.tenant_id')" "$(sql_quote "$TENANT_ID")"
      echo 'CREATE TEMP TABLE agor_sandbox_home_map (tenant_id text, user_id text, filesystem_home text) ON COMMIT DROP;'
      echo 'INSERT INTO agor_sandbox_home_map (tenant_id, user_id, filesystem_home) VALUES'
      for i in "${!HOME_ROWS[@]}"; do
        IFS='|' read -r tenant_id user_id unix_username home home_canonical <<< "${HOME_ROWS[$i]}"
        suffix=','
        [ "$i" -lt "$(( ${#HOME_ROWS[@]} - 1 ))" ] || suffix=';'
        printf '  (%s, %s, %s)%s\n' \
          "$(sql_quote "$tenant_id")" "$(sql_quote "$user_id")" "$(sql_quote "$home")" "$suffix"
      done
      echo 'UPDATE users AS u SET filesystem_home = m.filesystem_home FROM agor_sandbox_home_map AS m WHERE u.tenant_id::text = m.tenant_id AND u.user_id::text = m.user_id;'
      cat <<SQL
DO \$agor\$
BEGIN
  IF (SELECT count(*) FROM users AS u JOIN agor_sandbox_home_map AS m ON u.tenant_id::text = m.tenant_id AND u.user_id::text = m.user_id AND u.filesystem_home = m.filesystem_home) <> ${#HOME_ROWS[@]} THEN
    RAISE EXCEPTION 'filesystem_home verification failed';
  END IF;
END
\$agor\$;
COMMIT;
SQL
    } > "$DB_SQL_TMP"
    postgres_psql -q -f "$DB_SQL_TMP"
  else
    {
      echo 'BEGIN IMMEDIATE;'
      echo 'CREATE TEMP TABLE agor_sandbox_home_map (tenant_id text, user_id text, filesystem_home text);'
      echo 'INSERT INTO agor_sandbox_home_map (tenant_id, user_id, filesystem_home) VALUES'
      for i in "${!HOME_ROWS[@]}"; do
        row="${HOME_ROWS[$i]}"
        IFS='|' read -r tenant_id user_id unix_username home home_canonical <<< "$row"
        suffix=','
        [ "$i" -lt "$(( ${#HOME_ROWS[@]} - 1 ))" ] || suffix=';'
        printf '  (%s, %s, %s)%s\n' \
          "$(sql_quote "$tenant_id")" "$(sql_quote "$user_id")" "$(sql_quote "$home")" "$suffix"
      done
      echo 'UPDATE users SET filesystem_home = (SELECT m.filesystem_home FROM agor_sandbox_home_map AS m WHERE m.tenant_id = users.tenant_id AND m.user_id = users.user_id) WHERE EXISTS (SELECT 1 FROM agor_sandbox_home_map AS m WHERE m.tenant_id = users.tenant_id AND m.user_id = users.user_id);'
      printf 'CREATE TEMP TABLE agor_sandbox_home_verification (matched integer CHECK (matched = %s));\n' "${#HOME_ROWS[@]}"
      echo 'INSERT INTO agor_sandbox_home_verification SELECT count(*) FROM users AS u JOIN agor_sandbox_home_map AS m ON u.tenant_id = m.tenant_id AND u.user_id = m.user_id AND u.filesystem_home = m.filesystem_home;'
      echo 'COMMIT;'
    } > "$DB_SQL_TMP"
    sqlite3 -bail "$SQLITE_DB" < "$DB_SQL_TMP"
  fi
  say "database mapping committed and verified"
else
  say "would update ${#HOME_ROWS[@]} rows in one $DB_KIND transaction"
fi
echo

declare -A COMPLETED_OWNERSHIP_UNITS=()

load_completed_ownership_units() {
  local line unit_id
  while IFS= read -r line; do
    case "$line" in
      done=*)
        unit_id="${line#done=}"
        [[ "$unit_id" =~ ^[0-9]{6}$ ]] || die "invalid completed ownership unit: $unit_id"
        COMPLETED_OWNERSHIP_UNITS["$unit_id"]=1
        ;;
    esac
  done < "$OWNERSHIP_PROGRESS"
}

run_ownership_unit() {
  local unit_id="$1"
  local total="$2"
  local kind="$3"
  local depth="$4"
  local path="$5"
  local started_at status processed elapsed

  if [ -n "${COMPLETED_OWNERSHIP_UNITS[$unit_id]+x}" ]; then
    say "[$unit_id/$total] already complete; skipping $path"
    return
  fi

  say "[$unit_id/$total] owner -> $DAEMON_USER (preserve group; no chmod/setfacl): $path"
  OWNERSHIP_COUNTER="$(mktemp)"
  started_at="$(date +%s)"
  set +e
  if [ "$kind" = "shallow" ]; then
    find "$path" -xdev -maxdepth "$depth" -printf x \
      \( -user "$DAEMON_USER" -o -exec chown -h -- "$DAEMON_USER" {} + \)
  else
    find "$path" -xdev -printf x \
      \( -user "$DAEMON_USER" -o -exec chown -h -- "$DAEMON_USER" {} + \)
  fi | fold -w 100000 | awk -v unit="$unit_id" -v total="$total" -v output="$OWNERSHIP_COUNTER" '
    { processed += length($0); if (length($0) == 100000) printf "  [%s/%s] scanned %d paths\n", unit, total, processed > "/dev/stderr" }
    END { print processed + 0 > output }
  '
  status="$?"
  set -e
  processed="$(cat "$OWNERSHIP_COUNTER")"
  rm -f -- "$OWNERSHIP_COUNTER"
  OWNERSHIP_COUNTER=""
  [ "$status" -eq 0 ] || die "ownership unit $unit_id failed: $path"

  sync -f "$path"
  printf 'done=%s\n' "$unit_id" >> "$OWNERSHIP_PROGRESS"
  sync -f "$OWNERSHIP_PROGRESS"
  COMPLETED_OWNERSHIP_UNITS["$unit_id"]=1
  elapsed=$(( $(date +%s) - started_at ))
  say "[$unit_id/$total] complete; scanned $processed paths; elapsed ${elapsed}s"
}

verify_ownership_roots() {
  local row tenant_id user_id unix_username home home_canonical unexpected
  for row in "${HOME_ROWS[@]}"; do
    IFS='|' read -r tenant_id user_id unix_username home home_canonical <<< "$row"
    unexpected="$(find "$home_canonical" -xdev ! -user "$DAEMON_USER" -print -quit)"
    [ -z "$unexpected" ] || die "ownership verification failed under $home_canonical: $unexpected"
  done
  unexpected="$(find "$DATA_HOME_CANONICAL" -xdev ! -user "$DAEMON_USER" -print -quit)"
  [ -z "$unexpected" ] || die "ownership verification failed under $DATA_HOME_CANONICAL: $unexpected"
}

echo "-- step 7: transfer filesystem ownership in restartable units --"
if [ "$APPLY" = 1 ]; then
  load_completed_ownership_units
  total_units="${#OWNERSHIP_UNITS[@]}"
  while IFS='|' read -r unit_id kind depth path; do
    run_ownership_unit "$unit_id" "$total_units" "$kind" "$depth" "$path"
  done < "$OWNERSHIP_PLAN"
  say "verifying every migration root is owned by $DAEMON_USER"
  verify_ownership_roots
  say "ownership verification complete; groups, modes, and ACLs were not rewritten"
else
  say "would change only the owner across ${#OWNERSHIP_UNITS[@]} restartable, mount-bounded units"
  say "would preserve groups and avoid explicit chmod/setfacl operations"
fi
echo

echo "-- step 8: activate sandbox mode --"
if [ "$APPLY" = 1 ]; then
  CONFIG_TMP="$(mktemp "$CONFIG.sandbox.XXXXXX")"
  cp --preserve=all -- "$CONFIG" "$CONFIG_TMP"
  sed -i -E 's/^([[:space:]]*)unix_user_mode:.*/\1unix_user_mode: sandbox/' "$CONFIG_TMP"
  mv -- "$CONFIG_TMP" "$CONFIG"
  CONFIG_TMP=""
  grep -qE '^[[:space:]]*unix_user_mode:[[:space:]]*sandbox([[:space:]]|$)' "$CONFIG" || \
    die "config activation verification failed"
  say "set unix_user_mode: sandbox; backup: $CONFIG_BACKUP"
else
  say "would atomically set unix_user_mode: sandbox and preserve $CONFIG_BACKUP"
fi
echo

if [ "$TEARDOWN" = 1 ]; then
  echo "-- step 9: teardown legacy OS plumbing --"
  if [ "$APPLY" = 1 ]; then
    getent group | awk -F: '/^agor_wt_/{print $1}' | xargs -r -n1 groupdel
    rm -f -- /etc/sudoers.d/agor-daemon
    say "removed per-branch groups and daemon sudoers; Unix accounts retained"
  else
    say "would remove agor_wt_* groups and /etc/sudoers.d/agor-daemon"
  fi
  echo
fi

echo "== done ($([ "$APPLY" = 1 ] && echo APPLIED || echo DRY-RUN)) =="
[ "$APPLY" = 1 ] || echo "Re-run as root with --apply only after reviewing every resolved path."
