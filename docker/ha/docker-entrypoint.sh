#!/bin/sh
set -eu

# The named Agor-home volume may outlive an image rebuild. Refresh the
# checked-in, non-secret HA configuration on every container start so the
# volume cannot retain an obsolete config. Atomic rename also makes concurrent
# migrate/daemon startup safe when they share the volume.
mkdir -p -m 0700 "$HOME/.agor"
config_tmp="$(mktemp "$HOME/.agor/.config.yaml.XXXXXX")"
trap 'rm -f "$config_tmp"' EXIT HUP INT TERM
public_origin="${AGOR_HA_PUBLIC_ORIGIN:?AGOR_HA_PUBLIC_ORIGIN is required}"
case "$public_origin" in
  http://*|https://*) ;;
  *) echo "AGOR_HA_PUBLIC_ORIGIN must be an http(s) URL" >&2; exit 1 ;;
esac
escaped_public_origin="$(printf '%s' "$public_origin" | sed 's/[\\&|]/\\&/g')"
sed "s|__AGOR_HA_PUBLIC_ORIGIN__|$escaped_public_origin|g" /etc/agor/ha-config.yaml >"$config_tmp"
if grep -q '__AGOR_HA_PUBLIC_ORIGIN__' "$config_tmp"; then
  echo "Failed to materialize HA public origin" >&2
  exit 1
fi
chmod 0444 "$config_tmp"
mv -f "$config_tmp" "$HOME/.agor/config.yaml"
trap - EXIT HUP INT TERM

exec "$@"
