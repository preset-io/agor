# Docker Setup for Agor

Agor provides both **development** and **production** Docker configurations with a shared base image to keep things DRY and maintainable.

## Architecture

```
docker/
├── Dockerfile.dev               # Dev build (multi-stage: base + dev dependencies)
├── Dockerfile.prod              # Prod build (multi-stage: base + npm agor-live)
├── docker-entrypoint.sh         # Dev startup (pnpm dev for daemon + UI)
├── docker-entrypoint-prod.sh    # Prod startup (agor daemon only)
└── .env.prod.example            # Production environment template
```

Both Dockerfiles use multi-stage builds with a shared base stage:

- **Base stage**: System deps, Node 20, pnpm, AI CLIs, user setup (~500MB)
- **Dev stage**: Copies monorepo source, installs dev dependencies (~1.5GB)
- **Prod stage**: Installs `agor-live` from npm globally (~600MB)

## Quick Start

### Development Mode

```bash
# Build and start (daemon + UI with hot-reload)
docker compose up

# Access UI
open http://localhost:5173

# Access daemon API
curl http://localhost:3030/health
```

### Production Mode

```bash
# Build and start (daemon only, installs from npm)
docker compose -f docker-compose.prod.yml up

# Access UI (served by daemon)
open http://localhost:3030

# Access API
curl http://localhost:3030/health
```

## Configuration

### Development Environment Variables

Create a `.env` file:

```bash
# Daemon configuration
DAEMON_PORT=3030
CORS_ORIGIN=*

# UI configuration
UI_PORT=5173

# Seed test data (optional)
SEED=false

# API keys (optional)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
```

### Production Environment Variables

Create a `.env.prod` file:

```bash
# Daemon configuration
DAEMON_PORT=3030
DAEMON_HOST=0.0.0.0
CORS_ORIGIN=*

# API keys (required for agent features)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
```

Then run:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up
```

## Data Persistence

Both dev and prod use Docker volumes for data persistence:

```bash
# List volumes
docker volume ls | grep agor

# Inspect volume
docker volume inspect agor_agor-home

# Backup volume
docker run --rm -v agor_agor-home:/data -v $(pwd):/backup \
  alpine tar czf /backup/agor-backup.tar.gz -C /data .

# Restore volume
docker run --rm -v agor_agor-home:/data -v $(pwd):/backup \
  alpine tar xzf /backup/agor-backup.tar.gz -C /data
```

## Default Credentials (Production)

On first startup, production mode creates a default admin user:

```
Email:    admin@agor.live
Password: admin
```

**IMPORTANT:** Change this password immediately after first login!

```bash
# From inside the container
docker compose -f docker-compose.prod.yml exec agor-prod \
  agor user update admin@agor.live --password <new-password>
```

## Building Images

### Build Base Image Only

```bash
docker compose build agor-base
```

### Build Development Image

```bash
docker compose build agor-dev
```

### Build Production Image

```bash
docker compose -f docker-compose.prod.yml build agor-prod
```

### Build All Images

```bash
# Build base first, then dev
docker compose build

# Build base first, then prod
docker compose -f docker-compose.prod.yml build
```

## Advanced Usage

### Multiple Worktrees (Dev)

Each git worktree can run its own isolated Docker environment with:

- **Separate images** (tagged per project name)
- **Separate volumes** (node_modules, database, config)
- **Separate ports** (using unique_id offset)
- **Automatic dependency sync** (based on each worktree's pnpm-lock.yaml)

This is configured in `.agor.yml`:

```yaml
environment:
  start: DAEMON_PORT={{add 3000 worktree.unique_id}} UI_PORT={{add 5000 worktree.unique_id}} docker compose -p agor-{{worktree.name}} up -d
  stop: docker compose -p agor-{{worktree.name}} down
```

Manual example:

```bash
# Worktree 1 (postgres-support branch)
cd ~/.agor/worktrees/preset-io/agor/postgres-support
DAEMON_PORT=3001 UI_PORT=5001 docker compose -p agor-postgres-support up -d

# Worktree 2 (main branch)
cd ~/.agor/worktrees/preset-io/agor/main
DAEMON_PORT=3002 UI_PORT=5002 docker compose -p agor-main up -d
```

**How it works:**

1. **Image isolation**: `${COMPOSE_PROJECT_NAME}-agor-dev` means each `-p` project builds its own image
2. **Volume isolation**: Docker Compose creates separate volumes per project (named volumes + anonymous volumes for node_modules)
3. **Dependency sync**: Entrypoint runs `pnpm install` on startup, syncing to the mounted worktree's `pnpm-lock.yaml`
4. **No conflicts**: Worktree A with PostgreSQL deps won't conflict with Worktree B without them

**Benefits:**

- Work on multiple branches simultaneously
- Each worktree has correct dependencies (even if branches diverge)
- No manual dependency management needed
- Clean separation of databases and configs

### SSH Key Authentication (Dev)

Mount SSH keys for git operations:

```yaml
volumes:
  - ~/.ssh:/home/agor/.ssh:ro
```

This is already configured in `docker-compose.yml`.

### Host UID/GID Mapping (Linux)

On Linux, you can run the container as your host user to avoid permission issues entirely:

```bash
# Create .env file with your UID/GID
printf "UID=%s\nGID=%s\n" "$(id -u)" "$(id -g)" > .env

# Create docker-compose.override.yml
cat > docker-compose.override.yml <<'EOF'
services:
  agor-dev:
    user: "${UID:-1000}:${GID:-1000}"
EOF

# Start normally
docker compose up
```

**When to use this:**

- You're on Linux and want to avoid the automatic `chown` on startup
- You want container-created files to match your host user ownership

**Note:** On macOS/Windows, Docker Desktop handles UID mapping automatically - this override is unnecessary.

### Custom agor-live Version (Prod)

Pin to a specific version:

```dockerfile
# In docker/Dockerfile.prod, change:
RUN npm install -g agor-live@latest

# To:
RUN npm install -g agor-live@0.7.11
```

## Troubleshooting

### Port Already in Use

```bash
# Find process using port 3030
lsof -ti:3030 | xargs kill -9

# Or use different port
DAEMON_PORT=3031 docker compose up
```

### Volume Permission Issues

The entrypoint script automatically fixes permissions on bind-mounted directories during startup. This resolves issues where host-mounted files have different ownership than the container user.

**If you still see `EACCES: permission denied` errors:**

```bash
# Manually fix permissions (already runs automatically in entrypoint)
docker compose exec agor-dev sudo chown -R agor:agor /app

# Or restart container (permissions are fixed on startup)
docker compose restart agor-dev
```

**Note for Linux users:** On Linux, bind mounts preserve exact host UID/GID. If you prefer to avoid the automatic permission fix and match your host user, use the UID/GID override (see Advanced Usage below).

### Rebuild from Scratch

```bash
# Development
docker compose down -v
docker compose build --no-cache
docker compose up

# Production
docker compose -f docker-compose.prod.yml down -v
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up
```

### View Logs

```bash
# Development
docker compose logs -f agor-dev

# Production
docker compose -f docker-compose.prod.yml logs -f agor-prod
```

### Shell Access

```bash
# Development
docker compose exec agor-dev bash

# Production
docker compose -f docker-compose.prod.yml exec agor-prod bash
```

## Image Sizes

Expected image sizes:

- `agor-base`: ~500MB (Node 20 + system deps + AI CLIs)
- `agor-dev`: ~1.5GB (base + monorepo dependencies)
- `agor-prod`: ~600MB (base + npm agor-live package)

## Next Steps

- **Development**: Edit code in your editor, changes hot-reload automatically
- **Production**: Deploy to your server, configure reverse proxy (nginx/caddy)
- **Security**: Change default admin password, configure HTTPS, set CORS_ORIGIN
- **Monitoring**: Check `/health` endpoint, monitor logs, set up alerts

## Architecture Notes

### Why Shared Base Image?

**Benefits:**

- DRY: System dependencies defined once
- Faster builds: Base layer cached and reused
- Consistency: Dev and prod use same base environment
- Maintainable: Update system deps in one place

### Why Separate Entrypoints?

**Development** (`docker-entrypoint.sh`):

- Installs dependencies from monorepo
- Builds `@agor/core`
- Runs `pnpm dev` for daemon + UI (hot-reload)
- Seeds test data (optional)

**Production** (`docker-entrypoint-prod.sh`):

- Installs `agor-live` from npm (global)
- Runs `agor init --skip-if-exists`
- Creates admin user
- Starts `agor-daemon` only (UI served as static files)

### Why npm Global Install for Production?

- **Simplicity**: Single package, single install
- **Official**: Uses published `agor-live` package
- **Tested**: Same package users install locally
- **No build step**: Pre-built binaries included

## References

- Main README: `README.md`
- Development docs: `CLAUDE.md`
- Context docs: `context/README.md`
