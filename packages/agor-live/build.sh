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

echo "🔍 Verifying agor-live dependency alignment..."
cd "$REPO_ROOT"
pnpm check:agor-live-deps
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
NODE_ENV=production pnpm build

# Copy built artifacts to agor-live package
echo ""
echo "📋 Copying build artifacts..."

# Copy core
echo "  → Copying core..."
mkdir -p "$SCRIPT_DIR/dist/core"
cp -r "$REPO_ROOT/packages/core/dist/"* "$SCRIPT_DIR/dist/core/"

# Create package.json for @agor/core in dist/core by copying exports from source
echo "  → Creating package.json for bundled @agor/core..."
# Use jq to extract exports from source package.json and strip "dist/" prefix from paths
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
' "$REPO_ROOT/packages/core/package.json" > "$SCRIPT_DIR/dist/core/package.json"

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
