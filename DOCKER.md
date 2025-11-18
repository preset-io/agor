# Docker Development Guide

Agor supports both **SQLite** (default) and **PostgreSQL** databases via Docker Compose profiles.

## Quick Start

### SQLite Mode (Default)

Lightweight, file-based database - perfect for single-user development:

```bash
docker-compose up
```

**What runs:**

- ✅ Agor daemon + UI
- ❌ PostgreSQL (not needed)

**Database location:** `~/.agor/agor.db` (inside `agor-home` volume)

---

### PostgreSQL Mode

Multi-user capable database - better for production-like testing:

```bash
docker-compose --profile postgres up
```

**What runs:**

- ✅ Agor daemon + UI
- ✅ PostgreSQL 16 (Alpine)

**Database location:** `postgres-data` volume

---

## Configuration

### Using .env File

```bash
# Copy example configuration
cp .env.example .env

# Edit .env and set:
COMPOSE_PROFILES=postgres
AGOR_DB_DIALECT=postgresql

# Now just run:
docker-compose up
```

### Environment Variables

**Database:**

- `AGOR_DB_DIALECT` - `sqlite` (default) or `postgresql`
- `DATABASE_URL` - Full PostgreSQL URL (auto-generated if not set)
- `POSTGRES_DB` - Database name (default: `agor`)
- `POSTGRES_USER` - Database user (default: `agor`)
- `POSTGRES_PASSWORD` - Database password (default: `agor_dev_secret`)
- `POSTGRES_PORT` - Host port mapping (default: `5432`)

**Ports:**

- `DAEMON_PORT` - API server port (default: `3030`)
- `UI_PORT` - UI dev server port (default: `5173`)

**Development:**

- `SEED` - Populate test data on startup (default: `false`)
- `CORS_ORIGIN` - Allowed origins (default: permissive dev mode)

---

## PostgreSQL Connection Details

When using `--profile postgres`, the daemon auto-connects to:

```
postgresql://agor:agor_dev_secret@postgres:5432/agor
```

**From host machine** (for tools like pgAdmin, psql):

```bash
psql postgresql://agor:agor_dev_secret@localhost:5432/agor
```

---

## Switching Between Modes

### SQLite → PostgreSQL

```bash
# Stop current setup
docker-compose down

# Start with PostgreSQL
docker-compose --profile postgres up

# Set dialect in .env or via environment
export AGOR_DB_DIALECT=postgresql
```

### PostgreSQL → SQLite

```bash
# Stop current setup
docker-compose down

# Start without profile
docker-compose up

# Ensure dialect is set (or omit to use default)
export AGOR_DB_DIALECT=sqlite
```

**Note:** Databases are in separate volumes - switching modes doesn't migrate data.

---

## Volume Management

### View Volumes

```bash
docker volume ls | grep agor
```

**Volumes:**

- `agor_agor-home` - User data (config, SQLite DB, auth tokens)
- `agor_postgres-data` - PostgreSQL database (only with postgres profile)

### Reset Database

**SQLite:**

```bash
docker-compose down -v  # Removes agor-home volume
docker-compose up
```

**PostgreSQL:**

```bash
docker-compose --profile postgres down -v  # Removes both volumes
docker-compose --profile postgres up
```

---

## Running Migrations

### Automatic (on startup)

Migrations run automatically when the daemon starts.

### Manual

```bash
# Inside container
docker-compose exec agor-dev pnpm -w agor migrate

# Or from host
docker-compose exec agor-dev sh -c "cd /app && pnpm -w agor migrate"
```

---

## Troubleshooting

### PostgreSQL won't start

```bash
# Check logs
docker-compose --profile postgres logs postgres

# Ensure port 5432 isn't in use
lsof -i :5432

# Reset postgres volume
docker-compose --profile postgres down -v
docker-compose --profile postgres up
```

### Can't connect to PostgreSQL

1. Verify profile is active:

   ```bash
   docker-compose --profile postgres ps
   # Should show both agor-dev AND postgres
   ```

2. Check DATABASE_URL:

   ```bash
   docker-compose --profile postgres exec agor-dev env | grep DATABASE_URL
   # Should be: postgresql://agor:agor_dev_secret@postgres:5432/agor
   ```

3. Wait for health check:
   ```bash
   docker-compose --profile postgres ps
   # postgres should show (healthy)
   ```

### Database is empty after restart

Ensure you're not using `-v` flag when restarting:

```bash
# ❌ Wrong - removes volumes
docker-compose down -v

# ✅ Right - preserves data
docker-compose down
docker-compose up
```

---

## Production Considerations

For production deployments:

1. **Change PostgreSQL password:**

   ```bash
   # In .env
   POSTGRES_PASSWORD=your-strong-password-here
   ```

2. **Use persistent volumes:**
   - Map postgres-data to host directory for backups
   - Or use managed PostgreSQL (AWS RDS, etc.)

3. **Set AGOR_DB_DIALECT explicitly:**

   ```bash
   # In production .env
   AGOR_DB_DIALECT=postgresql
   DATABASE_URL=postgresql://user:pass@prod-db:5432/agor
   ```

4. **Don't expose PostgreSQL port:**
   ```yaml
   # Remove or comment out in docker-compose.yml
   # ports:
   #   - "5432:5432"
   ```

---

## Architecture

```
┌─────────────────────────────────────────┐
│         Docker Compose                  │
│                                         │
│  ┌──────────────┐                      │
│  │  agor-dev    │                      │
│  │              │                      │
│  │  - Daemon    │──┐                   │
│  │  - UI        │  │                   │
│  └──────────────┘  │                   │
│         │          │                   │
│         │          │                   │
│    ┌────▼─────┐    │  ┌─────────────┐ │
│    │ SQLite   │    └──│  postgres   │ │
│    │  (file)  │       │  (profile)  │ │
│    └──────────┘       └─────────────┘ │
│    agor-home           postgres-data  │
│    volume              volume         │
└─────────────────────────────────────────┘
```

**Key points:**

- Both databases can coexist (different volumes)
- Only one is used at runtime (controlled by `AGOR_DB_DIALECT`)
- PostgreSQL container only runs when `postgres` profile is active
