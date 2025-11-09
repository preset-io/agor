# Production Dockerfile for Agor
# Multi-stage build optimized for Kubernetes deployment

# Node.js version (should match .nvmrc)
# Override at build time: docker build --build-arg NODE_VERSION=24 .
ARG NODE_VERSION=24

# ==========================================
# Stage 1: Base with pnpm
# ==========================================
FROM node:${NODE_VERSION}-slim AS base

# Install pnpm globally
RUN npm install -g pnpm@9.15.1

# ==========================================
# Stage 2: Dependencies
# ==========================================
FROM base AS deps

WORKDIR /app

# Copy workspace configuration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy all package.json files for workspace
COPY apps/agor-daemon/package.json ./apps/agor-daemon/
COPY apps/agor-cli/package.json ./apps/agor-cli/
COPY apps/agor-ui/package.json ./apps/agor-ui/
COPY packages/core/package.json ./packages/core/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# ==========================================
# Stage 3: Builder
# ==========================================
FROM base AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/agor-daemon/node_modules ./apps/agor-daemon/node_modules
COPY --from=deps /app/apps/agor-cli/node_modules ./apps/agor-cli/node_modules
COPY --from=deps /app/apps/agor-ui/node_modules ./apps/agor-ui/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules

# Copy source code
COPY . .

# Build all packages using turbo
RUN pnpm build

# ==========================================
# Stage 4: Production runtime
# ==========================================
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS runtime

# Install system dependencies
RUN apt-get update && apt-get install -y \
    sqlite3 \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (gh) for git operations
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm@9.15.1

# Create non-root user
RUN useradd -m -s /bin/bash agor && \
    mkdir -p /home/agor/.agor && \
    chown -R agor:agor /home/agor

WORKDIR /app

# Copy workspace configuration
COPY package.json pnpm-workspace.yaml ./

# Copy production dependencies only
# Re-install with --prod flag to get only production dependencies
COPY apps/agor-daemon/package.json ./apps/agor-daemon/
COPY apps/agor-cli/package.json ./apps/agor-cli/
COPY apps/agor-ui/package.json ./apps/agor-ui/
COPY packages/core/package.json ./packages/core/

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Copy built artifacts from builder stage
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/apps/agor-daemon/dist ./apps/agor-daemon/dist
COPY --from=builder /app/apps/agor-cli/dist ./apps/agor-cli/dist
COPY --from=builder /app/apps/agor-ui/dist ./apps/agor-ui/dist

# Copy CLI bin directory
COPY --from=builder /app/apps/agor-cli/bin ./apps/agor-cli/bin

# Copy necessary source files for runtime
COPY packages/core/package.json ./packages/core/

# Copy scripts that may be needed at runtime
COPY scripts ./scripts

# Copy production entrypoint script
COPY docker-entrypoint-prod.sh /app/docker-entrypoint-prod.sh

# Set proper ownership and permissions
RUN chown -R agor:agor /app

# Switch to non-root user
USER agor

# Expose daemon port (serves both API and UI)
EXPOSE 3030
CMD ["pnpm", "--workspace", "agor-daemon", "start"]