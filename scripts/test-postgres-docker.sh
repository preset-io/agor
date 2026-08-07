#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

postgres_image="${AGOR_POSTGRES_TEST_IMAGE:-pgvector/pgvector:0.8.2-pg16-trixie}"
container_name="agor-postgres-test-${$}-${RANDOM}"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null 2>&1 || {
  echo 'Docker is required for test:postgres:docker.' >&2
  exit 1
}

echo "Starting disposable PostgreSQL (${postgres_image})..."
docker run --detach --name "$container_name" \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_DB=agor \
  --env POSTGRES_USER=agor_bootstrap \
  --env POSTGRES_PASSWORD=agor_bootstrap_secret \
  "$postgres_image" >/dev/null

deadline=$((SECONDS + 60))
until docker exec "$container_name" \
  pg_isready --host 127.0.0.1 --username agor_bootstrap --dbname agor >/dev/null 2>&1; do
  if ((SECONDS >= deadline)) || [[ "$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null)" != true ]]; then
    echo 'PostgreSQL did not become ready within 60 seconds.' >&2
    docker logs "$container_name" >&2 || true
    exit 1
  fi
  sleep 1
done

# This is the same security-sensitive role bootstrap used by the dev image.
docker exec --interactive "$container_name" \
  psql --set ON_ERROR_STOP=1 --username agor_bootstrap --dbname agor \
  <docker/postgres-init-app-user.sql >/dev/null

role_flags="$({
  docker exec --env PGPASSWORD=agor_dev_secret "$container_name" \
    psql --host 127.0.0.1 --username agor_app --dbname agor --tuples-only --no-align \
    --command "SELECT current_user || ':' || rolsuper || ':' || rolbypassrls FROM pg_roles WHERE rolname = current_user"
} 2>/dev/null)"
if [[ "$role_flags" != 'agor_app:false:false' ]]; then
  echo 'Refusing to run: agor_app is not verified as NOSUPERUSER and NOBYPASSRLS.' >&2
  exit 1
fi
echo 'Verified test role: agor_app (NOSUPERUSER, NOBYPASSRLS).'

host_port="$(docker port "$container_name" 5432/tcp | awk -F: 'NR == 1 { print $NF }')"
if [[ -z "$host_port" ]]; then
  echo 'Could not determine the disposable PostgreSQL host port.' >&2
  exit 1
fi

AGOR_DB_DIALECT=postgresql \
AGOR_TEST_POSTGRES_URL="postgresql://agor_app:agor_dev_secret@127.0.0.1:${host_port}/agor" \
AGOR_TEST_POSTGRES_ADMIN_URL="postgresql://agor_bootstrap:agor_bootstrap_secret@127.0.0.1:${host_port}/agor" \
  pnpm test:postgres:integration
