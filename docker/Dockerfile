# Multi-Stage Dockerfile for Agor
# Use build targets to create dev and prod images from shared base
#
# Build commands:
#   Development: docker build --target development -t agor:dev -f docker/Dockerfile .
#   Production:  docker build --target production -t agor:prod -f docker/Dockerfile .
#
# Or use docker-compose which automatically selects the right target

# ============================================================================
# Stage 0: Security-pinned bubblewrap
# ============================================================================
# Debian stable currently ships an older bubblewrap. Build the upstream 0.12
# release because Agor needs both --bind-fd (TOCTOU-safe credential projection)
# and the GHSA-pxhw-h44j-8pfx setup-path fix. Keep build tooling out of the
# runtime image and verify the immutable release asset before compiling it.
FROM node:22-slim AS bubblewrap-builder

ARG BUBBLEWRAP_VERSION=0.12.0
ARG BUBBLEWRAP_SHA256=9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314

RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  curl \
  libcap-dev \
  meson \
  ninja-build \
  pkg-config \
  xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL \
    "https://github.com/containers/bubblewrap/releases/download/v${BUBBLEWRAP_VERSION}/bubblewrap-${BUBBLEWRAP_VERSION}.tar.xz" \
    -o /tmp/bubblewrap.tar.xz \
  && echo "${BUBBLEWRAP_SHA256}  /tmp/bubblewrap.tar.xz" | sha256sum -c - \
  && mkdir /tmp/bubblewrap \
  && tar -xJf /tmp/bubblewrap.tar.xz -C /tmp/bubblewrap --strip-components=1 \
  && meson setup /tmp/bubblewrap/_build /tmp/bubblewrap \
    --buildtype=release \
    --prefix=/usr/local \
    -Dbash_completion=disabled \
    -Dman=disabled \
    -Dselinux=disabled \
    -Dtests=false \
    -Dzsh_completion=disabled \
  && meson compile -C /tmp/bubblewrap/_build \
  && DESTDIR=/tmp/bubblewrap-install meson install -C /tmp/bubblewrap/_build

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
  openssh-client \
  ripgrep \
  libcap2 \
  util-linux \
  && rm -rf /var/lib/apt/lists/*
COPY --from=bubblewrap-builder /tmp/bubblewrap-install/usr/local/bin/bwrap /usr/local/bin/bwrap
RUN bwrap --version | grep -F 'bubblewrap 0.12.0' \
  && bwrap --help | grep -F -- '--bind-fd'
# bubblewrap: filesystem-only executor sandbox, pinned above to the minimum
# secure release. util-linux supplies the kernel flock holder used by HA Codex
# credential mutations.

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

# Install only the workspace package manager in the shared image. Agentic-tool
# runtimes are not part of production unless explicitly installed through Agor.
RUN npm install -g pnpm@11.17.0

# Arguments for matching host user UID/GID (default to 1000)
ARG UID=1000
ARG GID=1000

# Rename existing 'node' user to 'agor' and switch UID/GID to match host.
# This is critical for bind mount permissions on Linux.
#
# The GID may already be taken by another group in the base image (e.g. a
# macOS host GID of 20 collides with the base image's 'dialout' group). When
# that happens, rename the existing group to 'agor' instead of failing —
# everything downstream (and the entrypoint) chowns against the 'agor' name.
RUN set -eux; \
    usermod -l agor -d /home/agor -m -u "${UID}" node; \
    if getent group "${GID}" >/dev/null; then \
      groupmod -n agor "$(getent group "${GID}" | cut -d: -f1)"; \
    else \
      groupmod -n agor -g "${GID}" node; \
    fi; \
    usermod -g agor agor; \
    # Development image only: allow the entrypoint to repair bind-mount ownership.
    echo "agor ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agor; \
    chmod 0440 /etc/sudoers.d/agor; \
    # Create .agor directory for database and config (will be mounted as volume)
    mkdir -p -m 0700 /home/agor/.agor; \
    chown -R agor:agor /home/agor

# Copy Zellij config for the daemon user.
COPY docker/zellij-config.kdl /tmp/zellij-config.kdl
RUN mkdir -p /home/agor/.config/zellij && \
    cp /tmp/zellij-config.kdl /home/agor/.config/zellij/config.kdl && \
    chown -R agor:agor /home/agor/.config && \
    rm /tmp/zellij-config.kdl

# Set working directory
WORKDIR /app

# Switch to agor user
USER agor

# ============================================================================
# Stage 2: Development (hot-reload for daemon and UI)
# ============================================================================
FROM base AS development

# Source mode resolves OpenCode from PATH; keep its exact development runtime
# out of the shared production base.
RUN sudo npm install -g opencode-ai@1.14.33

# Copy package files for dependency installation (as root, then chown)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agor-daemon/package.json ./apps/agor-daemon/
COPY apps/agor-cli/package.json ./apps/agor-cli/
COPY apps/agor-ui/package.json ./apps/agor-ui/
COPY packages/git/package.json ./packages/git/
COPY packages/core/package.json ./packages/core/
COPY packages/agentic-tool-opencode/package.json ./packages/agentic-tool-opencode/
COPY packages/agentic-tools/package.json ./packages/agentic-tools/
COPY packages/executor/package.json ./packages/executor/
COPY packages/client/package.json ./packages/client/
COPY patches/streamdown@2.5.0.patch ./patches/streamdown@2.5.0.patch

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

# Install agor-live globally from npm.
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
# immutable release tarballs, then installs those tarballs into an isolated
# global prefix with lifecycle scripts disabled. The runtime therefore uses the
# same scriptless artifact that npm users and release CI exercise.
FROM base AS source-builder

USER root
WORKDIR /app

# Full monorepo source. .dockerignore keeps node_modules/, dist/ and .git out.
COPY . .

# Real commit SHA for the in-app build banner. .git is dockerignored, so the
# daemon's stamp-build-info.mjs can't run `git rev-parse` — it reads
# AGOR_BUILD_SHA instead and writes dist/.build-info, which loadBuildInfo()
# surfaces at startup. CI passes --build-arg AGOR_BUILD_SHA=<github.sha>; left
# empty (local builds) the stamp falls back to the 'dev' sentinel.
ARG AGOR_BUILD_SHA=""
ENV AGOR_BUILD_SHA=${AGOR_BUILD_SHA}

# Install workspace deps (dev deps needed for the turbo build), build the exact
# release artifacts, then perform a script-disabled install. Supplying the
# locally packed client alongside agor-live keeps this pre-publication build
# independent of registry publication order.
RUN pnpm install --frozen-lockfile \
  && bash packages/agor-live/build.sh --skip-install \
  && npm install -g --prefix /opt/agor-runtime --ignore-scripts --no-audit --no-fund \
       packages/agor-live/release/agor-live-client-*.tgz \
       packages/agor-live/release/agor-live-[0-9]*.tgz \
  && test -d /opt/agor-runtime/lib/node_modules/agor-live/node_modules/@agor/core \
  && test -d /opt/agor-runtime/lib/node_modules/agor-live/node_modules/@agor/git

# ============================================================================
# Stage 4b: Production from source (slim runtime — pinned to its git SHA)
# ============================================================================
# Same runtime shape as `production` (inherits the shared base with Zellij and
# gh, but no agentic-tool runtimes), while shipping agor-live built from source
# instead of `npm install -g agor-live@latest`. Only the deployed artifact is
# copied in — the multi-GB builder (source + dev deps + store) is left behind.
#
#   docker build --target production-source -t agor:<sha> -f docker/Dockerfile .
FROM base AS production-source

USER root

# The one thing we keep from the builder: the isolated global npm prefix.
COPY --chown=agor:agor --from=source-builder /opt/agor-runtime /opt/agor-runtime

# Put the npm-generated global bins on PATH. They resolve dependencies and the
# bundled internal modules entirely within /opt/agor-runtime.
RUN ln -sf /opt/agor-runtime/bin/agor /usr/local/bin/agor \
  && ln -sf /opt/agor-runtime/bin/agor-daemon /usr/local/bin/agor-daemon \
  && chmod a+rx \
       /opt/agor-runtime/lib/node_modules/agor-live/bin/agor.js \
       /opt/agor-runtime/lib/node_modules/agor-live/bin/agor-daemon.js

# Reuse the production entrypoint (agor init → db migrate → exec agor-daemon).
COPY docker/docker-entrypoint-prod.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint-prod.sh

# Drop back to the unprivileged runtime user.
USER agor

EXPOSE ${DAEMON_PORT:-3030}
ENTRYPOINT ["docker-entrypoint-prod.sh"]

# ============================================================================
# Stage 4c: Production-from-source HA smoke runtime
# ============================================================================
# Branch worktrees can be protected by host ACLs that the container's `agor`
# user cannot read through a bind mount. Bake the non-secret HA configuration
# into the image instead, then materialize it atomically into the shared Agor
# home at container startup. Secrets remain runtime environment variables.
FROM production-source AS production-source-ha

USER root
COPY docker/ha/config.yaml /tmp/agor-ha-config.yaml
COPY docker/ha/docker-entrypoint.sh /tmp/agor-ha-entrypoint
# COPY can preserve restrictive worktree ACLs, including on an implicitly
# created parent directory. `install` creates clean files and permissions.
RUN install -d -o root -g root -m 0755 /etc/agor \
  && install -o root -g root -m 0444 /tmp/agor-ha-config.yaml /etc/agor/ha-config.yaml \
  && install -o root -g root -m 0555 /tmp/agor-ha-entrypoint /usr/local/bin/agor-ha-entrypoint \
  && rm /tmp/agor-ha-config.yaml /tmp/agor-ha-entrypoint
USER agor

ENTRYPOINT ["/usr/local/bin/agor-ha-entrypoint"]
