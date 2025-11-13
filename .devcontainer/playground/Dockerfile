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
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

# Install foundation packages one at a time (more robust against npm hiccups)
RUN npm install -g @anthropic-ai/claude-code@latest && \
    npm install -g @google/gemini-cli@latest && \
    npm install -g @openai/codex@latest

# Copy package.json as cache-buster for agor-live (rebuilds only when version changes)
COPY packages/agor-live/package.json /tmp/agor-live-package.json

# Install agor-live (rebuilds when package.json changes)
RUN npm install -g agor-live@latest

WORKDIR /workspaces

# Create non-root 'agor' user for development
RUN useradd -m -s /bin/bash agor && \
    # Grant sudoers access without password (needed for some development tasks)
    echo "agor ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/agor && \
    # Ensure agor owns the workspace
    chown -R agor:agor /workspaces

# Set agor as the default user
USER agor
