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

### Multiple Instances (Dev)

Run multiple dev instances with separate volumes:

```bash
# Instance 1
docker compose -p agor-worktree-1 up

# Instance 2 (different ports)
DAEMON_PORT=3031 UI_PORT=5174 docker compose -p agor-worktree-2 up
```

### SSH Key Authentication (Dev)

Mount SSH keys for git operations:

```yaml
volumes:
  - ~/.ssh:/home/agor/.ssh:ro
```

This is already configured in `docker-compose.yml` (commented out by default).

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

If you see permission errors:

```bash
# Fix permissions (runs automatically in entrypoint)
docker compose exec agor-dev sudo chown -R agor:agor /home/agor/.agor
```

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
