FROM mcr.microsoft.com/devcontainers/typescript-node:20

# Install system dependencies
RUN apt-get update && apt-get install -y \
    sqlite3 \
    git \
    curl \
    vim \
    procps \
    htop \
    lsof \
    net-tools \
    iputils-ping \
    wget \
    jq \
    less \
    tree \
    && rm -rf /var/lib/apt/lists/*

# Install Zellij (terminal multiplexer)
RUN ZELLIJ_VERSION=0.43.1 && \
    curl -L "https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/zellij-x86_64-unknown-linux-musl.tar.gz" | \
    tar -xz -C /usr/local/bin && \
    chmod +x /usr/local/bin/zellij && \
    zellij --version

# Install GitHub CLI (gh)
RUN curl -fsSL "$(curl -s https://api.github.com/repos/cli/cli/releases/latest | grep 'browser_download_url.*linux_amd64.tar.gz"' | cut -d'"' -f4)" | \
    tar -xz -C /tmp && \
    mv /tmp/gh_*/bin/gh /usr/local/bin/ && \
    rm -rf /tmp/gh_*

# Install pnpm (for developers who want to build from source)
# and agor-live from npm for quick start
RUN npm install -g pnpm@latest agor-live@latest @anthropic-ai/claude-code@latest @google/gemini-cli@latest @openai/codex@latest @opencode-ai/cli@latest

WORKDIR /workspaces

# Note: Source code is available in /workspaces/agor for development
# To develop on Agor itself: cd /workspaces/agor && pnpm install && pnpm build
# Otherwise, the globally installed agor-live is used
