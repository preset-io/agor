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
FROM node:22-slim AS base

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
  ripgrep \
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
  @anthropic-ai/claude-code@2.1.197 \
  @google/gemini-cli@0.31.0 \
  @openai/codex@0.141.0 \
  opencode-ai@1.2.15

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
COPY packages/git/package.json ./packages/git/
COPY packages/core/package.json ./packages/core/
COPY packages/executor/package.json ./packages/executor/
COPY packages/client/package.json ./packages/client/

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

# ============================================================================
# Stage 4a: Source builder (heavy; discarded — never shipped)
# ============================================================================
# Builds agor-live from THIS checkout via packages/agor-live/build.sh (turbo
# build → copies each package's dist/ into agor-live/dist/{core,git,cli,daemon,
# executor,ui} — the exact layout the npm package ships), then produces a
# self-contained prod deployment with `pnpm deploy`: agor-live's bin/ + dist/ +
# prod-only node_modules, with no monorepo source, dev deps, or pnpm store.
FROM base AS source-builder

USER root
WORKDIR /app

# Native-module toolchain (node-pty etc.) for the deploy step's install
# lifecycle. Confined to this throwaway builder — never in the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

# Full monorepo source. .dockerignore keeps node_modules/, dist/ and .git out.
COPY . .

# Real commit SHA for the in-app build banner. .git is dockerignored, so the
# daemon's stamp-build-info.mjs can't run `git rev-parse` — it reads
# AGOR_BUILD_SHA instead and writes dist/.build-info, which loadBuildInfo()
# surfaces at startup. CI passes --build-arg AGOR_BUILD_SHA=<github.sha>; left
# empty (local builds) the stamp falls back to the 'dev' sentinel.
ARG AGOR_BUILD_SHA=""
ENV AGOR_BUILD_SHA=${AGOR_BUILD_SHA}

# Install workspace deps (dev deps needed for the turbo build), build agor-live
# from source, then deploy a prod-only, self-contained tree to /opt/agor-live.
# build.sh --skip-install avoids a redundant install; it also runs
# check:agor-live-deps and check:pack, which gate the build. dist/ is in the
# package's `files` allowlist, so `pnpm deploy` carries it into the output, and
# agor-live's postinstall re-creates the @agor/{core,git} → dist symlinks there.
RUN pnpm install --frozen-lockfile \
  && bash packages/agor-live/build.sh --skip-install \
  && pnpm --filter=agor-live deploy --prod /opt/agor-live

# `pnpm deploy` runs agor-live's postinstall against the workspace copy, not the
# deploy output — so the @agor/{core,git} → dist symlinks it creates never land
# in /opt/agor-live. Re-run the packaged postinstall (shipped via the package's
# `files` allowlist) against the deployed tree so the symlink layout stays
# defined in exactly one place. The script warns instead of failing, so assert
# the links resolve — a broken image must fail the build, not the smoke test.
RUN node /opt/agor-live/scripts/postinstall.js \
  && test -e /opt/agor-live/node_modules/@agor/core \
  && test -e /opt/agor-live/node_modules/@agor/git

# ============================================================================
# Stage 4b: Production from source (slim runtime — pinned to its git SHA)
# ============================================================================
# Same runtime shape as `production` (inherits base: Zellij, gh, and the
# Claude/Codex/Gemini/OpenCode CLIs), but ships agor-live built from source
# instead of `npm install -g agor-live@latest`. Only the deployed artifact is
# copied in — the multi-GB builder (source + dev deps + store) is left behind.
#
#   docker build --target production-source -t agor:<sha> -f docker/Dockerfile .
FROM base AS production-source

USER root

# The one thing we keep from the builder: the self-contained agor-live tree.
# Copied to the SAME path so its internal (relative) symlinks stay valid.
COPY --from=source-builder /opt/agor-live /opt/agor-live

# Put the bins on PATH (shebang: #!/usr/bin/env node); they resolve deps + dist
# entirely within /opt/agor-live.
RUN ln -sf /opt/agor-live/bin/agor.js /usr/local/bin/agor \
  && ln -sf /opt/agor-live/bin/agor-daemon.js /usr/local/bin/agor-daemon \
  && chmod +x /opt/agor-live/bin/agor.js /opt/agor-live/bin/agor-daemon.js

# Reuse the production entrypoint (agor init → db migrate → exec agor-daemon).
COPY docker/docker-entrypoint-prod.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint-prod.sh

# Drop back to the unprivileged runtime user.
USER agor

EXPOSE ${DAEMON_PORT:-3030}
ENTRYPOINT ["docker-entrypoint-prod.sh"]
