FROM mcr.microsoft.com/devcontainers/typescript-node:20

# Install system dependencies
RUN apt-get update && apt-get install -y \
    sqlite3 \
    git \
    curl \
    tmux \
    vim \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (gh)
RUN curl -fsSL "$(curl -s https://api.github.com/repos/cli/cli/releases/latest | grep 'browser_download_url.*linux_amd64.tar.gz"' | cut -d'"' -f4)" | \
    tar -xz -C /tmp && \
    mv /tmp/gh_*/bin/gh /usr/local/bin/ && \
    rm -rf /tmp/gh_*

# Install pnpm (for developers who want to build from source)
# and agor-live from npm for quick start
RUN npm install -g pnpm@latest agor-live@latest @anthropic-ai/claude-code@latest @google/gemini-cli@latest @openai/codex@latest

WORKDIR /workspaces

# Note: Source code is available in /workspaces/agor for development
# To develop on Agor itself: cd /workspaces/agor && pnpm install && pnpm build
# Otherwise, the globally installed agor-live is used
