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
  openssh-server \
  acl \
  && rm -rf /var/lib/apt/lists/*

# Configure SSH server for multi-user testing (used in postgres profile)
RUN mkdir -p /run/sshd && \
  # Enable password authentication
  sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
  # Disable root login
  sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config && \
  # Allow all users to login
  echo 'AllowUsers agor alice bob' >> /etc/ssh/sshd_config

# Install Zellij (terminal multiplexer)
# Pinned to v0.43.1 for reproducibility
RUN ZELLIJ_VERSION=0.43.1 && \
  curl -L "https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/zellij-x86_64-unknown-linux-musl.tar.gz" | \
  tar -xz -C /usr/local/bin && \
  chmod +x /usr/local/bin/zellij && \
  zellij --version

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
  @anthropic-ai/claude-code@2.1.29 \
  @google/gemini-cli@0.18.4 \
  @openai/codex@0.69.0 \
  opencode-ai@latest

# Arguments for matching host user UID/GID (default to 1000)
ARG UID=1000
ARG GID=1000

# Rename existing 'node' user to 'agor' and switch UID/GID to match host
# This is critical for bind mount permissions on Linux
RUN usermod -l agor -d /home/agor -m -u ${UID} node && \
    groupmod -n agor -g ${GID} node && \
    # Grant passwordless sudo for fixing volume permissions and executor spawning
    echo "agor ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agor && \
    chmod 0440 /etc/sudoers.d/agor && \
    # Create .agor directory for database and config (will be mounted as volume)
    mkdir -p /home/agor/.agor && \
    chown -R agor:agor /home/agor

# Create 'agor_executor' user (unprivileged user for isolated SDK execution)
# This user has no sudo privileges and limited permissions
RUN useradd -m -s /bin/bash agor_executor && \
    # Create home directory with restricted permissions
    mkdir -p /home/agor_executor/.agor && \
    chown -R agor_executor:agor_executor /home/agor_executor

# Copy Zellij config for both users
COPY docker/zellij-config.kdl /tmp/zellij-config.kdl
RUN mkdir -p /home/agor/.config/zellij && \
    mkdir -p /home/agor_executor/.config/zellij && \
    cp /tmp/zellij-config.kdl /home/agor/.config/zellij/config.kdl && \
    cp /tmp/zellij-config.kdl /home/agor_executor/.config/zellij/config.kdl && \
    chown -R agor:agor /home/agor/.config && \
    chown -R agor_executor:agor_executor /home/agor_executor/.config && \
    rm /tmp/zellij-config.kdl

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
COPY packages/executor/package.json ./packages/executor/

# Install dependencies as agor user (cached in Docker layer)
# This creates node_modules with correct platform binaries for container
# An anonymous volume at /app/node_modules shadows the bind mount, preserving these deps
RUN sudo chown -R agor:agor /app && \
    pnpm install --frozen-lockfile

# Copy entrypoint scripts
COPY docker/docker-entrypoint.sh /usr/local/bin/
COPY docker/docker-entrypoint-postgres.sh /usr/local/bin/
RUN sudo chmod +x /usr/local/bin/docker-entrypoint.sh && \
    sudo chmod +x /usr/local/bin/docker-entrypoint-postgres.sh && \
    sudo chown agor:agor /usr/local/bin/docker-entrypoint.sh && \
    sudo chown agor:agor /usr/local/bin/docker-entrypoint-postgres.sh

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
