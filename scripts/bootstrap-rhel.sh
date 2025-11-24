#!/bin/bash
#
# Bootstrap script for RHEL/CentOS/Fedora systems
# Installs dependencies needed to run Agor
#

set -e  # Exit on error

echo "🚀 Bootstrapping Agor on RHEL/CentOS/Fedora..."

# Detect package manager (dnf for newer RHEL8+/Fedora, yum for older)
if command -v dnf &> /dev/null; then
    PKG_MGR="dnf"
else
    PKG_MGR="yum"
fi

echo "📦 Using package manager: $PKG_MGR"

# Update package lists
echo "📋 Updating package lists..."
sudo $PKG_MGR update -y

# Install system dependencies
echo "🔧 Installing system dependencies..."
sudo $PKG_MGR install -y \
    git \
    curl \
    vim \
    sqlite \
    tar \
    gzip

# Install Zellij (terminal multiplexer)
echo "💻 Installing Zellij..."
if ! command -v zellij &> /dev/null; then
    ZELLIJ_VERSION=0.43.1
    curl -L "https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/zellij-x86_64-unknown-linux-musl.tar.gz" | \
        sudo tar -xz -C /usr/local/bin
    sudo chmod +x /usr/local/bin/zellij
    echo "✓ Zellij $(zellij --version) installed"
else
    echo "✓ Zellij already installed"
fi

# Install Node.js 20.x (LTS) from NodeSource
echo "📦 Installing Node.js 20.x..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'v' -f2 | cut -d'.' -f1) -lt 20 ]]; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo $PKG_MGR install -y nodejs
else
    echo "✓ Node.js $(node -v) already installed"
fi

# Install GitHub CLI
echo "🐙 Installing GitHub CLI..."
if ! command -v gh &> /dev/null; then
    sudo $PKG_MGR install -y 'dnf-command(config-manager)' || sudo $PKG_MGR install -y yum-utils
    sudo $PKG_MGR config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
    sudo $PKG_MGR install -y gh
else
    echo "✓ GitHub CLI already installed"
fi

# Install global npm packages
echo "📦 Installing global npm packages..."
sudo npm install -g \
    pnpm@latest \
    agor-live@latest \
    @anthropic-ai/claude-code@latest \
    @google/gemini-cli@latest \
    @openai/codex@latest

echo ""
echo "✅ Bootstrap complete!"
echo ""
echo "Next steps:"
echo "  1. agor init        # Initialize Agor"
echo "  2. agor daemon start # Start the daemon"
echo "  3. agor open        # Open the UI"
echo ""
echo "For more info: https://agor.live/guide/getting-started"
