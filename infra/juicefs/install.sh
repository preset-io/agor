#!/usr/bin/env bash
# Pinned official release; no remote shell execution.
set -euo pipefail
version=1.4.1
case "$(uname -m)" in
  x86_64) arch=amd64; sha=01ee09a21a9351a465e09906f113845e1c6a19bea70f530e5e2b2125b2dd3b82 ;;
  aarch64) arch=arm64; sha=1015ade83a7a93180a29f6c93ee5780a3eda52522331934ef2ef0cc0921995fd ;;
  *) echo 'This installer supports Linux amd64/arm64 only' >&2; exit 1 ;;
esac
[[ $(uname -s) == Linux ]]
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 "https://github.com/juicedata/juicefs/releases/download/v$version/juicefs-$version-linux-$arch.tar.gz" -o "$work/release.tar.gz"
printf '%s  %s\n' "$sha" "$work/release.tar.gz" | sha256sum --check
tar -xzf "$work/release.tar.gz" -C "$work" juicefs
install -m 0755 "$work/juicefs" /usr/local/bin/juicefs
/usr/local/bin/juicefs --version
