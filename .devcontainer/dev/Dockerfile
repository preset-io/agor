FROM mcr.microsoft.com/devcontainers/typescript-node:20

# Install system dependencies (matches Dockerfile.dev)
RUN apt-get update && apt-get install -y \
    sqlite3 \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (gh) - download pre-built binary
RUN curl -fsSL "$(curl -s https://api.github.com/repos/cli/cli/releases/latest | grep 'browser_download_url.*linux_amd64.tar.gz"' | cut -d'"' -f4)" | \
    tar -xz -C /tmp && \
    mv /tmp/gh_*/bin/gh /usr/local/bin/ && \
    rm -rf /tmp/gh_*

# Install pnpm and AI coding agent CLIs (always get latest versions)
RUN npm install -g pnpm@latest @anthropic-ai/claude-code@latest @google/gemini-cli@latest @openai/codex@latest

# Set working directory
WORKDIR /workspace

# Run as root in sandbox (simpler for Codespaces dev environment)
# Docker-in-Docker works better with root, no permission issues
