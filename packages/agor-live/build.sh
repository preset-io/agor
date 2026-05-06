#!/bin/bash

# Build & Publish Script for agor-live + @agor-live/client
#
# Usage:
#   ./build.sh                    # Build only
#   ./build.sh --publish          # Build and publish both packages
#   ./build.sh --bump patch       # Bump version (patch/minor/major), build, and publish
#   ./build.sh --bump minor       # Bump to next minor version
#   ./build.sh --dry-run          # Show what would be published without actually publishing
#   ./build.sh --skip-install     # Skip pnpm install step
#   ./build.sh --with-sandpack    # Include self-hosted Sandpack bundler in build

set -e  # Exit on error

# Raise Node's heap ceiling so DTS generation in @agor/core (~3 GB peak) and
# vite/next bundle steps don't OOM on low-RAM hosts. User-set NODE_OPTIONS
# wins because Node honors the last `--max-old-space-size` it sees.
export NODE_OPTIONS="--max-old-space-size=4096 ${NODE_OPTIONS:-}"

# ── Parse flags ──────────────────────────────────────────────────────────────

PUBLISH=false
DRY_RUN=false
SKIP_INSTALL=false
WITH_SANDPACK=false
BUMP=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --publish)   PUBLISH=true; shift ;;
    --dry-run)   DRY_RUN=true; PUBLISH=true; shift ;;
    --bump)      BUMP="$2"; PUBLISH=true; shift 2 ;;
    --skip-install) SKIP_INSTALL=true; shift ;;
    --with-sandpack) WITH_SANDPACK=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -n "$BUMP" && "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Invalid bump type: $BUMP (must be patch, minor, or major)"
  exit 1
fi

# ── Setup paths ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLIENT_DIR="$REPO_ROOT/packages/client"

echo "🏗️  Building agor-live + @agor-live/client"
echo ""
echo "📍 Repository root: $REPO_ROOT"
echo "📦 agor-live:       $SCRIPT_DIR"
echo "📦 @agor-live/client: $CLIENT_DIR"
echo ""

# ── Version bump ─────────────────────────────────────────────────────────────

if [[ -n "$BUMP" ]]; then
  CURRENT_VERSION=$(node -p "require('$SCRIPT_DIR/package.json').version")
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

  case $BUMP in
    patch) PATCH=$((PATCH + 1)) ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  esac

  NEW_VERSION="$MAJOR.$MINOR.$PATCH"
  echo "📌 Version bump: $CURRENT_VERSION → $NEW_VERSION ($BUMP)"

  # Update both package.json files
  node -e "
    const fs = require('fs');
    for (const p of ['$SCRIPT_DIR/package.json', '$CLIENT_DIR/package.json']) {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      pkg.version = '$NEW_VERSION';
      fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
    }
  "
  echo "  ✓ Updated agor-live/package.json"
  echo "  ✓ Updated @agor-live/client/package.json"
  echo ""
else
  NEW_VERSION=$(node -p "require('$SCRIPT_DIR/package.json').version")

  # Sync client version to match agor-live (no bump, just align)
  CLIENT_VERSION=$(node -p "require('$CLIENT_DIR/package.json').version")
  if [[ "$CLIENT_VERSION" != "$NEW_VERSION" ]]; then
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$CLIENT_DIR/package.json', 'utf8'));
      pkg.version = '$NEW_VERSION';
      fs.writeFileSync('$CLIENT_DIR/package.json', JSON.stringify(pkg, null, 2) + '\n');
    "
    echo "📌 Synced @agor-live/client version: $CLIENT_VERSION → $NEW_VERSION"
    echo ""
  fi
fi

echo "📦 Version: $NEW_VERSION"
echo ""

# ── Install dependencies ─────────────────────────────────────────────────────

if [[ "$SKIP_INSTALL" == false ]]; then
  echo "📥 Installing dependencies..."
  cd "$REPO_ROOT"
  pnpm install
  echo ""
fi

# ── Verify dependency alignment ─────────────────────────────────────────────

echo "🔍 Verifying agor-live dependency alignment..."
cd "$REPO_ROOT"
pnpm check:agor-live-deps
echo ""

# ── Clean previous builds ────────────────────────────────────────────────────

echo "🧹 Cleaning previous builds..."
# Build into a staging directory, then swap atomically at the end.
# This keeps the existing dist/ available while rebuilding, so a running
# daemon/executor isn't knocked offline during the build window.
DIST_STAGE="$SCRIPT_DIR/dist.stage"
rm -rf "$DIST_STAGE"
rm -rf "$SCRIPT_DIR/node_modules/@agor"
rm -rf "$CLIENT_DIR/dist"
mkdir -p "$DIST_STAGE"

# ── Build all components ─────────────────────────────────────────────────────
#
# Use turbo to build everything in workspace-dependency order. turbo.json
# declares `"dependsOn": ["^build"]`, so e.g. @agor/cli (which imports types
# from @agor/daemon) waits for daemon's dist/index.d.ts before its own DTS
# step runs. Hand-ordering this sequence is fragile — every time someone
# adds a new cross-package import the wrong order silently passes locally
# (because of stale dist/) and explodes on a clean CI checkout.
#
# Excludes @agor/docs (Nextra docs site, not part of the published artifact).
# NODE_ENV=production matters for the UI's vite build; harmless for the rest.

echo ""
echo "📦 Building all workspace packages (turbo, dep-ordered)..."
cd "$REPO_ROOT"
NODE_ENV=production pnpm exec turbo run build --filter='!@agor/docs'

echo ""
echo "🔍 Verifying @agor-live/client pack..."
cd "$CLIENT_DIR"
pnpm check:pack

# ── Build self-hosted Sandpack bundler (optional) ────────────────────────────

if [[ "$WITH_SANDPACK" == true ]]; then
  echo ""
  echo "🧩 Building self-hosted Sandpack bundler..."
  # IMPORTANT: Clone OUTSIDE the monorepo. sandpack-bundler uses yarn, but yarn
  # walks up from CWD looking for package.json and will find the monorepo root's
  # "packageManager": "pnpm@..." field and refuse to run. Keeping it outside the
  # repo avoids the collision entirely.
  SANDPACK_DIR="${AGOR_SANDPACK_DIR:-$HOME/.cache/agor/sandpack-bundler}"
  if [[ ! -d "$SANDPACK_DIR" ]]; then
    echo "  → Cloning sandpack-bundler to $SANDPACK_DIR..."
    mkdir -p "$(dirname "$SANDPACK_DIR")"
    git clone --depth 1 https://github.com/codesandbox/sandpack-bundler.git "$SANDPACK_DIR"
  fi
  cd "$SANDPACK_DIR"
  echo "  → Installing dependencies..."
  yarn install --frozen-lockfile 2>/dev/null || yarn install
  echo "  → Patching build script for relative asset paths..."
  # sandpack-bundler's build script chains `parcel build ... && cp ...`, so we
  # can't override via `yarn build` args (they'd land on cp). Patch the script
  # in package.json to force `--public-url ./`, which makes Parcel emit relative
  # asset paths that work when served from /static/sandpack/ (Parcel's default
  # is `/`, which bakes absolute paths into index.html and breaks subpath mounts).
  node -e "
    const fs = require('fs');
    const path = 'package.json';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (pkg.scripts && pkg.scripts.build) {
      const before = pkg.scripts.build;
      let after;
      if (/--public-url\s+\S+/.test(before)) {
        // Replace existing flag value
        after = before.replace(/--public-url\s+\S+/g, '--public-url ./');
      } else {
        // Insert flag right after 'parcel build <entry>'
        after = before.replace(
          /(parcel\s+build\s+\S+)/,
          '\$1 --public-url ./'
        );
      }
      if (after !== before) {
        pkg.scripts.build = after;
        fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
        console.log('    patched: ' + after);
      } else {
        console.log('    WARNING: could not find parcel build command to patch');
      }
    }
  "
  echo "  → Building..."
  yarn build
  echo "  ✓ Sandpack bundler built"
fi

# ── Copy artifacts to agor-live ──────────────────────────────────────────────

echo ""
echo "📋 Copying build artifacts to agor-live..."

echo "  → Copying core..."
mkdir -p "$DIST_STAGE/core"
cp -r "$REPO_ROOT/packages/core/dist/"* "$DIST_STAGE/core/"

echo "  → Creating package.json for bundled @agor/core..."
jq '
  def strip_dist: gsub("\\./dist/"; "./");
  {
    name: "@agor/core",
    version: "0.1.0",
    type: "module",
    main: "./index.js",
    types: "./index.d.ts",
    exports: (.exports | walk(if type == "string" then strip_dist else . end))
  }
' "$REPO_ROOT/packages/core/package.json" > "$DIST_STAGE/core/package.json"

echo "  → Copying CLI..."
mkdir -p "$DIST_STAGE/cli"
cp -r "$REPO_ROOT/apps/agor-cli/dist/"* "$DIST_STAGE/cli/"

echo "  → Copying daemon..."
mkdir -p "$DIST_STAGE/daemon"
# .build-info (sha + builtAt) is stamped into apps/agor-daemon/dist by the
# daemon's own build script (apps/agor-daemon/scripts/stamp-build-info.mjs)
# and gets carried along by this cp -r. loadBuildInfo() reads it at boot.
cp -r "$REPO_ROOT/apps/agor-daemon/dist/"* "$DIST_STAGE/daemon/"

echo "  → Copying executor..."
mkdir -p "$DIST_STAGE/executor"
cp -r "$REPO_ROOT/packages/executor/dist/"* "$DIST_STAGE/executor/"

echo "  → Copying UI..."
mkdir -p "$DIST_STAGE/ui"
cp -r "$REPO_ROOT/apps/agor-ui/dist/"* "$DIST_STAGE/ui/"

if [[ "$WITH_SANDPACK" == true ]]; then
  # sandpack-bundler outputs to www/ or dist/ depending on version
  SANDPACK_OUT=""
  if [[ -d "$SANDPACK_DIR/www" ]]; then SANDPACK_OUT="$SANDPACK_DIR/www"; fi
  if [[ -d "$SANDPACK_DIR/dist" ]]; then SANDPACK_OUT="$SANDPACK_DIR/dist"; fi
  if [[ -n "$SANDPACK_OUT" ]]; then
    echo "  → Copying Sandpack bundler..."
    mkdir -p "$DIST_STAGE/static/sandpack"
    cp -r "$SANDPACK_OUT/"* "$DIST_STAGE/static/sandpack/"
  else
    echo "  ⚠️  Sandpack bundler build output not found, skipping"
  fi
fi

# ── Atomic swap: stage → dist ───────────────────────────────────────────────
# Swap the old dist with the new one in two fast renames. The running daemon
# only loses its backing files for the instant between mv commands (~ms).

echo ""
echo "🔄 Swapping dist (atomic-ish)..."
rm -rf "$SCRIPT_DIR/dist.old"
if [[ -d "$SCRIPT_DIR/dist" ]]; then
  mv "$SCRIPT_DIR/dist" "$SCRIPT_DIR/dist.old"
fi
if ! mv "$DIST_STAGE" "$SCRIPT_DIR/dist"; then
  echo "  ✗ Failed to move dist.stage into place"
  if [[ -d "$SCRIPT_DIR/dist.old" ]]; then
    echo "  ↺ Restoring previous dist..."
    mv "$SCRIPT_DIR/dist.old" "$SCRIPT_DIR/dist" || true
  fi
  exit 1
fi
rm -rf "$SCRIPT_DIR/dist.old"

echo ""
echo "📦 Setting up @agor/core symlink for local development..."
mkdir -p "$SCRIPT_DIR/node_modules/@agor"
rm -f "$SCRIPT_DIR/node_modules/@agor/core"
ln -s "../../dist/core" "$SCRIPT_DIR/node_modules/@agor/core"

# ── Package sizes ────────────────────────────────────────────────────────────

echo ""
echo "📊 Package sizes:"
du -sh "$SCRIPT_DIR/dist" | awk '{print "  agor-live total: " $1}'
du -sh "$SCRIPT_DIR/dist/core" | awk '{print "    Core:     " $1}'
du -sh "$SCRIPT_DIR/dist/cli" | awk '{print "    CLI:      " $1}'
du -sh "$SCRIPT_DIR/dist/daemon" | awk '{print "    Daemon:   " $1}'
du -sh "$SCRIPT_DIR/dist/executor" | awk '{print "    Executor: " $1}'
du -sh "$SCRIPT_DIR/dist/ui" | awk '{print "    UI:       " $1}'
if [[ -d "$SCRIPT_DIR/dist/static/sandpack" ]]; then
  du -sh "$SCRIPT_DIR/dist/static/sandpack" | awk '{print "    Sandpack: " $1}'
fi
du -sh "$CLIENT_DIR/dist" | awk '{print "  @agor-live/client: " $1}'

echo ""
echo "✅ Build complete!"

# ── Publish ──────────────────────────────────────────────────────────────────

if [[ "$PUBLISH" == true ]]; then
  echo ""

  if [[ "$DRY_RUN" == true ]]; then
    echo "🧪 Dry run — showing what would be published..."
    echo ""
    echo "── agor-live@$NEW_VERSION ──"
    cd "$SCRIPT_DIR" && pnpm publish --dry-run --no-git-checks 2>&1 | tail -20
    echo ""
    echo "── @agor-live/client@$NEW_VERSION ──"
    cd "$CLIENT_DIR" && pnpm publish --access public --dry-run --no-git-checks 2>&1 | tail -20
  else
    echo "🚀 Publishing packages..."
    echo ""
    # IMPORTANT: use `pnpm publish` (not `npm publish`). pnpm transforms
    # `workspace:*` into a concrete semver range when packing the tarball;
    # plain `npm publish` leaves the protocol verbatim and breaks consumers.
    # `--no-git-checks` skips pnpm's "branch must be main / clean tree" guard
    # since this script runs from feature/release branches with dist/ artifacts.
    echo "── Publishing agor-live@$NEW_VERSION ──"
    cd "$SCRIPT_DIR" && npm whoami >/dev/null 2>&1 || npm login
    cd "$SCRIPT_DIR" && pnpm publish --no-git-checks
    echo ""
    echo "── Publishing @agor-live/client@$NEW_VERSION ──"
    cd "$CLIENT_DIR" && pnpm publish --access public --no-git-checks
    echo ""
    echo "✅ Both packages published!"
    echo "  npm i agor-live@$NEW_VERSION"
    echo "  npm i @agor-live/client@$NEW_VERSION"
  fi
else
  echo ""
  echo "📦 Package structure:"
  tree -L 2 -d "$SCRIPT_DIR/dist" 2>/dev/null || find "$SCRIPT_DIR/dist" -type d -maxdepth 2 | sed 's|^|  |'

  echo ""
  echo "🚀 Next steps:"
  echo "  ./build.sh --dry-run         # Preview publish"
  echo "  ./build.sh --publish          # Publish current version ($NEW_VERSION)"
  echo "  ./build.sh --bump patch       # Bump + publish"
fi
