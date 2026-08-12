#!/bin/sh
set -eu

# The named Agor-home volume may outlive an image rebuild. Refresh the
# checked-in, non-secret HA configuration on every container start so the
# volume cannot retain an obsolete config. Atomic rename also makes concurrent
# migrate/daemon startup safe when they share the volume.
mkdir -p "$HOME/.agor"
config_tmp="$(mktemp "$HOME/.agor/.config.yaml.XXXXXX")"
trap 'rm -f "$config_tmp"' EXIT HUP INT TERM
cat /etc/agor/ha-config.yaml >"$config_tmp"
chmod 0444 "$config_tmp"
mv -f "$config_tmp" "$HOME/.agor/config.yaml"
trap - EXIT HUP INT TERM

exec "$@"
