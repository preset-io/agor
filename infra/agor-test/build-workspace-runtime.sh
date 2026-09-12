#!/bin/bash
# Run through SSM on each worker with the immutable release id as $1.
set -euo pipefail
release=$1
[[ "$release" =~ ^[a-f0-9]{16,64}$ ]]
exec > >(tee -a /var/log/agor-workspace-build.log) 2>&1
mkdir -p "/opt/agor/releases/$release" /opt/agor/workspace /var/lib/agor
aws s3 cp "s3://agor-test-source-148253003792/workspace-releases/$release.tar.gz" "/opt/agor/releases/$release.tar.gz" --region ap-southeast-2
tar -xzf "/opt/agor/releases/$release.tar.gz" -C "/opt/agor/releases/$release"
docker build --target production-source --build-arg "AGOR_BUILD_SHA=workspace-$release" -t "agor-workspace:$release" -f "/opt/agor/releases/$release/docker/Dockerfile" "/opt/agor/releases/$release"
echo "WORKSPACE_IMAGE_READY=$release"
