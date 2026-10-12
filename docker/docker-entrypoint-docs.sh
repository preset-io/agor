#!/bin/sh
set -eu
if [ "$(id -u)" = 0 ]; then
  mkdir -p /home/agor/.agor
  chown agor:agor /home/agor/.agor
  exec gosu agor "$0" "$@"
fi
mkdir -p /home/agor/.agor/runtime-docs
# Own this cache until the server exits; no concurrent source writers.
exec 9>/home/agor/.agor/runtime-docs/start.lock
flock -n 9 || { echo 'Another docs preview owns this volume'; exit 1; }
exec node /usr/local/lib/agor/runtime-docs.mjs "$@"
