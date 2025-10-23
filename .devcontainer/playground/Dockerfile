FROM mcr.microsoft.com/devcontainers/typescript-node:20 AS builder

# Install system dependencies for build
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

# Install pnpm (use latest)
RUN npm install -g pnpm@latest

# Set working directory for build
WORKDIR /build

# Copy entire repository
COPY . .

# Install and build - verbose for debugging
# Note: We exclude agor-ui since this is a backend-focused playground
RUN echo "=== Starting pnpm install ===" && \
    pnpm install && \
    echo "=== Install complete, starting build ===" && \
    echo "=== Building @agor/core first (required by other packages) ===" && \
    pnpm --filter @agor/core build && \
    echo "=== Building daemon ===" && \
    pnpm --filter @agor/daemon build && \
    echo "=== Build complete ===" && \
    echo "=== Verifying builds ===" && \
    ls -la /build/packages/core/dist/ && \
    ls -la /build/apps/agor-daemon/dist/ && \
    echo "=== Build verification complete ==="

# Production stage
FROM mcr.microsoft.com/devcontainers/typescript-node:20

# Install runtime dependencies
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

# Install pnpm and AI CLIs in production stage (always get latest versions)
RUN npm install -g pnpm@latest @anthropic-ai/claude-code@latest @google/gemini-cli@latest @openai/codex@latest

# Copy built application from builder
WORKDIR /workspaces/agor
COPY --from=builder /build /workspaces/agor

# Run as root for simplified sandbox
