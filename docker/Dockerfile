# Multi-Stage Dockerfile for Agor
# Use build targets to create dev and prod images from shared base
#
# Build commands:
#   Development: docker build --target development -t agor:dev -f docker/Dockerfile .
#   Production:  docker build --target production -t agor:prod -f docker/Dockerfile .
#
# Or use docker-compose which automatically selects the right target

# ============================================================================
# Stage 1: Shared Base (dev and prod both use this)
# ============================================================================
FROM node:20-slim AS base

# Install system dependencies (including git for repo cloning)
RUN apt-get update && apt-get install -y \
  sqlite3 \
  git \
  curl \
  sudo \
  tmux \
  vim \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (gh) - download pre-built binary
RUN curl -fsSL "$(curl -s https://api.github.com/repos/cli/cli/releases/latest | grep 'browser_download_url.*linux_amd64.tar.gz"' | cut -d'"' -f4)" | \
  tar -xz -C /tmp && \
  mv /tmp/gh_*/bin/gh /usr/local/bin/ && \
  rm -rf /tmp/gh_*

# Install pnpm and AI coding agent CLIs
# Pinned versions for reproducibility across dev and prod
# NOTE: Update these versions when upgrading Agor SDKs (see packages/core/package.json)
RUN npm install -g \
  pnpm@9.15.1 \
  @anthropic-ai/claude-code@2.0.42 \
  @google/gemini-cli@0.15.1 \
  @openai/codex@0.58.0

# Create non-root 'agor' user
RUN useradd -m -s /bin/bash agor && \
    # Grant passwordless sudo for fixing volume permissions
    echo "agor ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agor && \
    chmod 0440 /etc/sudoers.d/agor && \
    # Create .agor directory for database and config (will be mounted as volume)
    mkdir -p /home/agor/.agor && \
    chown -R agor:agor /home/agor

# Set working directory
WORKDIR /app

# Switch to agor user
USER agor

# ============================================================================
# Stage 2: Development (hot-reload for daemon and UI)
# ============================================================================
FROM base AS development

# Copy package files for dependency installation (as root, then chown)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agor-daemon/package.json ./apps/agor-daemon/
COPY apps/agor-cli/package.json ./apps/agor-cli/
COPY apps/agor-ui/package.json ./apps/agor-ui/
COPY packages/core/package.json ./packages/core/

# Install dependencies as agor user (cached in Docker layer)
# This creates node_modules with correct platform binaries for container
RUN sudo chown -R agor:agor /app && \
    pnpm install --frozen-lockfile

# Copy entrypoint script
COPY docker/docker-entrypoint.sh /usr/local/bin/
RUN sudo chmod +x /usr/local/bin/docker-entrypoint.sh && \
    sudo chown agor:agor /usr/local/bin/docker-entrypoint.sh

# Expose UI port only (daemon is internal)
EXPOSE ${VITE_PORT:-5173}

# Use entrypoint script to start both processes
ENTRYPOINT ["docker-entrypoint.sh"]

# ============================================================================
# Stage 3: Production (installs agor-live from npm)
# ============================================================================
FROM base AS production

# Switch back to root to install global npm packages
USER root

# Install agor-live globally from npm
# This installs both the CLI and daemon binaries
RUN npm install -g agor-live@latest

# Switch back to agor user
USER agor

# Copy production entrypoint script
COPY docker/docker-entrypoint-prod.sh /usr/local/bin/
RUN sudo chmod +x /usr/local/bin/docker-entrypoint-prod.sh && \
    sudo chown agor:agor /usr/local/bin/docker-entrypoint-prod.sh

# Expose daemon port (UI will be served via static files by daemon)
EXPOSE ${DAEMON_PORT:-3030}

# Use production entrypoint script
ENTRYPOINT ["docker-entrypoint-prod.sh"]
