#!/usr/bin/env bash
set -euo pipefail

# GitHub supplies these values inside every Codespace. Validate before using
# them to construct browser-facing URLs or an environment label.
: "${CODESPACE_NAME:?GitHub Codespaces did not set CODESPACE_NAME}"
if [[ ! "$CODESPACE_NAME" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "Invalid CODESPACE_NAME" >&2
  exit 1
fi

port_domain="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
if [[ ! "$port_domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "Invalid GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN" >&2
  exit 1
fi

daemon_url="https://${CODESPACE_NAME}-3000.${port_domain}"
ui_url="https://${CODESPACE_NAME}-5000.${port_domain}"

# This preview can deliberately publish both forwarded ports. Never expose the
# repository-wide development default (admin/admin): create a per-Codespace,
# mode-0600 bootstrap secret outside the Git workspace and reuse it across
# stop/start cycles. The value is passed only through the nested Compose
# process environment and is never printed.
credentials_dir="${HOME:?}/.agor-managed"
admin_password_file="${credentials_dir}/bootstrap-admin-password"
mkdir -p "$credentials_dir"
chmod 700 "$credentials_dir"

# GitHub's post-start hook and an explicit repair/Sync can overlap. Serialize
# all password and Compose work inside the Codespace instead of relying only on
# the launcher's host-local lock.
bootstrap_lock="${credentials_dir}/bootstrap.lock"
bootstrap_lock_owner="${bootstrap_lock}/owner"
bootstrap_lock_deadline=$((SECONDS + 1200))
while ! mkdir "$bootstrap_lock" 2>/dev/null; do
  existing_owner="$(tr -d '\r\n' <"$bootstrap_lock_owner" 2>/dev/null || true)"
  if [[ "$existing_owner" =~ ^[0-9]+$ ]] && ! kill -0 "$existing_owner" 2>/dev/null; then
    rm -f "$bootstrap_lock_owner"
    rmdir "$bootstrap_lock" 2>/dev/null || true
    continue
  fi
  if [[ ! "$existing_owner" =~ ^[0-9]+$ ]]; then
    # Recover a lock whose owner died between mkdir and writing its PID. A
    # live owner completes those adjacent operations far faster than this
    # grace period; re-read before removing anything.
    sleep 1
    existing_owner="$(tr -d '\r\n' <"$bootstrap_lock_owner" 2>/dev/null || true)"
    if [[ ! "$existing_owner" =~ ^[0-9]+$ ]]; then
      rm -f "$bootstrap_lock_owner"
      rmdir "$bootstrap_lock" 2>/dev/null || true
      continue
    fi
  fi
  if ((SECONDS >= bootstrap_lock_deadline)); then
    echo "Timed out waiting for another Agor bootstrap" >&2
    exit 1
  fi
  sleep 1
done
printf '%s\n' "$$" >"$bootstrap_lock_owner"
release_bootstrap_lock() {
  local exit_status=$?
  trap - EXIT
  rm -f "$bootstrap_lock_owner" || true
  rmdir "$bootstrap_lock" 2>/dev/null || true
  exit "$exit_status"
}
trap release_bootstrap_lock EXIT

# The development image contains dependencies and entrypoints, while the
# checkout itself is bind-mounted. Fingerprint every file and build argument
# that determines that image, and embed the same fingerprint as an image label.
# Reuse is safe only when those values match exactly. A failed build leaves the
# old label in place, so its retry cannot accidentally accept a stale image.
shopt -s nullglob
development_image_input_files=(
  .dockerignore
  docker/Dockerfile
  docker/docker-entrypoint.sh
  docker/docker-entrypoint-postgres.sh
  docker/zellij-config.kdl
  docker-compose.yml
  docker-compose.override.yml
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  apps/*/package.json
  packages/*/package.json
  patches/*
)
development_image_fingerprint="$({
  printf 'UID=%s\nGID=%s\n' "$(id -u)" "$(id -g)"
  for development_image_input_file in "${development_image_input_files[@]}"; do
    if [[ ! -f "$development_image_input_file" ]]; then
      echo "Missing development image input: $development_image_input_file" >&2
      exit 1
    fi
    printf 'path=%s\n' "$development_image_input_file"
    if development_image_input_mode="$(stat -c '%a' "$development_image_input_file" 2>/dev/null)"; then
      :
    else
      development_image_input_mode="$(stat -f '%Lp' "$development_image_input_file")"
    fi
    printf 'mode=%s\n' "$development_image_input_mode"
    git hash-object -- "$development_image_input_file"
  done
} | git hash-object --stdin)"
existing_image_fingerprint="$(
  docker image inspect \
    --format '{{ index .Config.Labels "io.agor.dev-image-input-fingerprint" }}' \
    agor-dev:latest 2>/dev/null || true
)"
existing_image_id="$(
  docker image inspect --format '{{.Id}}' agor-dev:latest 2>/dev/null || true
)"
compose_container_id="$(
  docker compose -p agor-codespaces-sqlite ps -aq agor-dev
)"
compose_container_image_id=""
if [[ -n "$compose_container_id" ]]; then
  compose_container_image_id="$(
    docker inspect --format '{{.Image}}' "$compose_container_id" 2>/dev/null || true
  )"
fi

if [[ ! -s "$admin_password_file" ]]; then
  generated_password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  if [[ ! "$generated_password" =~ ^[a-f0-9]{48}$ ]]; then
    echo "Could not generate the Codespaces bootstrap admin password" >&2
    exit 1
  fi
  if (set -o noclobber; printf '%s\n' "$generated_password" >"$admin_password_file") 2>/dev/null; then
    chmod 600 "$admin_password_file"
  fi
  unset generated_password
fi
admin_password="$(tr -d '\r\n' <"$admin_password_file")"
if [[ ! "$admin_password" =~ ^[a-f0-9]{48}$ ]]; then
  echo "Invalid Codespaces bootstrap admin password file" >&2
  exit 1
fi

compose_needs_build=false
if [[ "${AGOR_FORCE_REBUILD:-false}" == "true" ]] ||
  [[ "$existing_image_fingerprint" != "$development_image_fingerprint" ]]; then
  compose_needs_build=true
  echo "[agor-codespaces] Building and starting the SQLite Compose stack..."
else
  echo "[agor-codespaces] Starting the SQLite Compose stack from the existing development image..."
fi
compose_needs_recreate="$compose_needs_build"
if [[ "${AGOR_FORCE_RECREATE:-false}" == "true" ]]; then
  compose_needs_recreate=true
fi
if [[ -n "$compose_container_id" ]]; then
  if [[ -z "$existing_image_id" ]] ||
    [[ -z "$compose_container_image_id" ]] ||
    [[ "$compose_container_image_id" != "$existing_image_id" ]]; then
    # A previous build may have updated the tag and then been interrupted before
    # Compose recreated the service. Its anonymous dependencies still came from
    # the old image, so remove that exact service container before starting.
    compose_needs_recreate=true
  fi
fi

# The nested Compose project owns a SQLite volume inside this Codespace. Ports
# begin GitHub-private. The launcher may publish them only after its SSH health
# probe succeeds, and repeats that reconciliation after every provider restart.
build_compose() {
  env \
    UID="$(id -u)" \
    GID="$(id -g)" \
    AGOR_DEV_IMAGE_INPUT_FINGERPRINT="$development_image_fingerprint" \
    docker compose -p agor-codespaces-sqlite build agor-dev
}
start_compose() {
  env \
    UID="$(id -u)" \
    GID="$(id -g)" \
    INSTANCE_LABEL="codespace-${CODESPACE_NAME}" \
    DAEMON_PORT=3000 \
    UI_PORT=5000 \
    AGOR_BASE_URL="$ui_url" \
    VITE_DAEMON_URL="$daemon_url" \
    CORS_ORIGIN="$ui_url" \
    AGOR_DEV_IMAGE_INPUT_FINGERPRINT="$development_image_fingerprint" \
    AGOR_ADMIN_PASSWORD="$admin_password" \
    AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN=false \
    AGOR_MIGRATION_OFFLINE_CUTOVER=true \
    SEED=false \
    docker compose -p agor-codespaces-sqlite up -d
}
if [[ "$compose_needs_build" == "true" ]]; then
  build_compose
  built_image_fingerprint="$(
    docker image inspect \
      --format '{{ index .Config.Labels "io.agor.dev-image-input-fingerprint" }}' \
      agor-dev:latest 2>/dev/null || true
  )"
  if [[ "$built_image_fingerprint" != "$development_image_fingerprint" ]]; then
    echo "Built development image did not retain the expected input fingerprint" >&2
    exit 1
  fi
fi
if [[ "$compose_needs_recreate" == "true" ]]; then
  # `compose rm -v` removes only anonymous dependency volumes; the named
  # ~/.agor data volume survives. This prevents each reconciliation from
  # stranding another multi-gigabyte node_modules volume set.
  docker compose -p agor-codespaces-sqlite rm -sfv agor-dev
fi
start_compose
unset admin_password

echo "[agor-codespaces] Compose launch finished. Current service state:"
docker compose -p agor-codespaces-sqlite ps
echo "[agor-codespaces] Bootstrap admin credential: $admin_password_file (mode 600; change it after first login)."
echo "[agor-codespaces] Bootstrap complete; the launcher is waiting for the remote /health endpoint."
