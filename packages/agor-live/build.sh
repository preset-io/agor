#!/bin/bash

# Build Script for agor-live Package
# Builds all components and bundles them into a single npm package

set -e  # Exit on error

echo "🏗️  Building agor-live package..."
echo ""

# Get script directory (packages/agor-live)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "📍 Repository root: $REPO_ROOT"
echo "📦 Package directory: $SCRIPT_DIR"
echo ""

# Clean previous build
echo "🧹 Cleaning previous build..."
rm -rf "$SCRIPT_DIR/dist"
rm -rf "$SCRIPT_DIR/node_modules/@agor"
mkdir -p "$SCRIPT_DIR/dist"

# Build @agor/core
echo ""
echo "📦 Building @agor/core..."
cd "$REPO_ROOT/packages/core"
pnpm build

# Build CLI
echo ""
echo "🖥️  Building CLI..."
cd "$REPO_ROOT/apps/agor-cli"
pnpm build

# Build Daemon
echo ""
echo "⚙️  Building Daemon..."
cd "$REPO_ROOT/apps/agor-daemon"
pnpm build

# Build UI
echo ""
echo "🎨 Building UI..."
cd "$REPO_ROOT/apps/agor-ui"
pnpm build

# Copy built artifacts to agor-live package
echo ""
echo "📋 Copying build artifacts..."

# Copy core
echo "  → Copying core..."
mkdir -p "$SCRIPT_DIR/dist/core"
cp -r "$REPO_ROOT/packages/core/dist/"* "$SCRIPT_DIR/dist/core/"

# Create package.json for @agor/core in dist/core with corrected paths
echo "  → Creating package.json for bundled @agor/core..."
cat > "$SCRIPT_DIR/dist/core/package.json" << 'PKGJSON'
{
  "name": "@agor/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.js",
  "types": "./index.d.ts",
  "exports": {
    ".": {
      "types": "./index.d.ts",
      "import": "./index.js",
      "require": "./index.cjs"
    },
    "./types": {
      "types": "./types/index.d.ts",
      "import": "./types/index.js",
      "require": "./types/index.cjs"
    },
    "./db": {
      "types": "./db/index.d.ts",
      "import": "./db/index.js",
      "require": "./db/index.cjs"
    },
    "./git": {
      "types": "./git/index.d.ts",
      "import": "./git/index.js",
      "require": "./git/index.cjs"
    },
    "./api": {
      "types": "./api/index.d.ts",
      "import": "./api/index.js",
      "require": "./api/index.cjs"
    },
    "./claude": {
      "types": "./claude/index.d.ts",
      "import": "./claude/index.js",
      "require": "./claude/index.cjs"
    },
    "./config": {
      "types": "./config/index.d.ts",
      "import": "./config/index.js",
      "require": "./config/index.cjs"
    },
    "./config/browser": {
      "types": "./config/browser.d.ts",
      "import": "./config/browser.js",
      "require": "./config/browser.cjs"
    },
    "./tools": {
      "types": "./tools/index.d.ts",
      "import": "./tools/index.js",
      "require": "./tools/index.cjs"
    },
    "./tools/models": {
      "types": "./tools/models.d.ts",
      "import": "./tools/models.js",
      "require": "./tools/models.cjs"
    },
    "./tools/claude/models": {
      "types": "./tools/claude/models.d.ts",
      "import": "./tools/claude/models.js",
      "require": "./tools/claude/models.cjs"
    },
    "./permissions": {
      "types": "./permissions/index.d.ts",
      "import": "./permissions/index.js",
      "require": "./permissions/index.cjs"
    },
    "./feathers": {
      "types": "./feathers/index.d.ts",
      "import": "./feathers/index.js",
      "require": "./feathers/index.cjs"
    },
    "./templates/handlebars-helpers": {
      "types": "./templates/handlebars-helpers.d.ts",
      "import": "./templates/handlebars-helpers.js",
      "require": "./templates/handlebars-helpers.cjs"
    },
    "./environment/variable-resolver": {
      "types": "./environment/variable-resolver.d.ts",
      "import": "./environment/variable-resolver.js",
      "require": "./environment/variable-resolver.cjs"
    },
    "./utils/pricing": {
      "types": "./utils/pricing.d.ts",
      "import": "./utils/pricing.js",
      "require": "./utils/pricing.cjs"
    },
    "./utils/url": {
      "types": "./utils/url.d.ts",
      "import": "./utils/url.js",
      "require": "./utils/url.cjs"
    },
    "./utils/permission-mode-mapper": {
      "types": "./utils/permission-mode-mapper.d.ts",
      "import": "./utils/permission-mode-mapper.js",
      "require": "./utils/permission-mode-mapper.cjs"
    },
    "./utils/cron": {
      "types": "./utils/cron.d.ts",
      "import": "./utils/cron.js",
      "require": "./utils/cron.cjs"
    },
    "./utils/errors": {
      "types": "./utils/errors.d.ts",
      "import": "./utils/errors.js",
      "require": "./utils/errors.cjs"
    }
  }
}
PKGJSON

# Copy CLI
echo "  → Copying CLI..."
mkdir -p "$SCRIPT_DIR/dist/cli"
cp -r "$REPO_ROOT/apps/agor-cli/dist/"* "$SCRIPT_DIR/dist/cli/"

# Copy Daemon
echo "  → Copying daemon..."
mkdir -p "$SCRIPT_DIR/dist/daemon"
cp -r "$REPO_ROOT/apps/agor-daemon/dist/"* "$SCRIPT_DIR/dist/daemon/"

# Copy UI
echo "  → Copying UI..."
mkdir -p "$SCRIPT_DIR/dist/ui"
cp -r "$REPO_ROOT/apps/agor-ui/dist/"* "$SCRIPT_DIR/dist/ui/"

# Create node_modules/@agor/core as symlink to dist/core for local development
echo ""
echo "📦 Setting up @agor/core symlink for local development..."
mkdir -p "$SCRIPT_DIR/node_modules/@agor"
rm -f "$SCRIPT_DIR/node_modules/@agor/core"
ln -s "../../dist/core" "$SCRIPT_DIR/node_modules/@agor/core"

# Calculate package size
echo ""
echo "📊 Package size:"
du -sh "$SCRIPT_DIR/dist" | awk '{print "  Total: " $1}'
echo ""
du -sh "$SCRIPT_DIR/dist/core" | awk '{print "  Core:   " $1}'
du -sh "$SCRIPT_DIR/dist/cli" | awk '{print "  CLI:    " $1}'
du -sh "$SCRIPT_DIR/dist/daemon" | awk '{print "  Daemon: " $1}'
du -sh "$SCRIPT_DIR/dist/ui" | awk '{print "  UI:     " $1}'

echo ""
echo "✅ Build complete!"
echo ""
echo "📦 Package structure:"
tree -L 2 -d "$SCRIPT_DIR/dist" 2>/dev/null || find "$SCRIPT_DIR/dist" -type d -maxdepth 2 | sed 's|^|  |'

echo ""
echo "🚀 Next steps:"
echo "  1. Test local installation:"
echo "     npm install -g $SCRIPT_DIR"
echo ""
echo "  2. Or publish to npm:"
echo "     cd $SCRIPT_DIR && npm publish"
echo ""
