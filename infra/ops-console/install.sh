#!/bin/bash
set -euo pipefail
# Run from this release directory after installing the secret config separately.
test -s /etc/agor-ops.json
install -d -m 700 /opt/agor-ops /var/lib/agor-ops
install -m 600 server.py index.html app.js style.css /opt/agor-ops/
cat > /etc/systemd/system/agor-ops.service <<'UNIT'
[Unit]
Description=Agor operations console
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/agor-ops/server.py
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/agor-ops
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now agor-ops
systemctl restart agor-ops
curl --fail --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:8790/ops/health
