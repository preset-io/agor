# Test Plan: Multi-Environment Setup Validation

Test all 4 development environments to catch regressions.

## Environments

1. **agor-live** - Published npm package
2. **Codespaces** - Cloud development
3. **Local Dev** - Host machine (pnpm dev)
4. **Docker Compose** - Containerized

---

## Quick Smoke Tests

### All Environments

- [ ] Database initializes without errors
- [ ] Default board exists (check: `sqlite3 ~/.agor/agor.db "SELECT name FROM boards"`)
- [ ] Daemon starts on correct port (curl health check)
- [ ] UI loads at correct port
- [ ] Can create a session via API
- [ ] Admin user exists and can login

### agor-live (npm package)

```bash
npm install -g agor-live@latest
agor init --skip-if-exists
agor config list
agor user list
```

**Expected:** No errors, config visible, admin user exists

### Codespaces

- [ ] Clone repo
- [ ] Open in Codespaces
- [ ] `pnpm install` completes (no platform binary mismatches)
- [ ] `pnpm dev` starts daemon + UI
- [ ] Claude Code agents run at normal speed (not 10x slow)
- [ ] `bypassPermissions` setting respected (check query-builder doesn't override)
- [ ] Database lock timeout respected (5-second WAL mode pragma)

**Key fix validation:**

- SQLite WAL mode prevents SQLITE_BUSY errors under concurrent SDK calls
- bypassPermissions not forced to 'default' for root user

### Local Dev (Host)

```bash
cd /Users/max/code/agor
pnpm install
cd apps/agor-daemon && pnpm dev  # Terminal 1
cd apps/agor-ui && pnpm dev      # Terminal 2 (or pnpm dev from root)
```

**Expected:**

- [ ] Daemon starts, listens on :3030
- [ ] UI starts, listens on :5173
- [ ] Hot reload works (edit file, see changes instantly)
- [ ] `git commit` works (Husky hooks pass with macOS binaries)
- [ ] Pre-commit typecheck + lint runs
- [ ] No turbo binary errors

### Docker Compose

```bash
cd /Users/max/code/agor
docker compose up
```

**Expected:**

- [ ] `pnpm install` completes with progress output (yes | pipe)
- [ ] Migrations run (no "Can't find meta/\_journal.json")
- [ ] Database initializes (agor init --skip-if-exists)
- [ ] Config always set to multiplayer mode (requireAuth: true)
- [ ] Admin user exists
- [ ] UI loads at :5173, daemon at :3030
- [ ] Docker restarts don't reset database (--skip-if-exists works)

**Git workflow in Docker:**

- [ ] `docker exec agor-agor-dev-1 git add . && docker exec agor-agor-dev-1 git commit -m "test"` works
- [ ] Hooks run inside container with Linux binaries
- [ ] Clean exit, no lingering processes

---

## Regression Tests

### Critical Fixes

**1. SQLite Concurrency (packages/core/src/db/client.ts)**

- [ ] Multiple concurrent SDK calls don't cause SQLITE_BUSY
- [ ] WAL mode enabled: `sqlite3 ~/.agor/agor.db "PRAGMA journal_mode"`
- [ ] Busy timeout set: `sqlite3 ~/.agor/agor.db "PRAGMA busy_timeout"`

**2. bypassPermissions in Root Context (packages/core/src/tools/claude/query-builder.ts)**

- [ ] Codespaces: Set permission mode to "bypassPermissions"
- [ ] Verify SDK init shows correct mode (not forced to 'default')
- [ ] Agents run without approval prompts

**3. Migration Path Resolution (packages/core/src/db/migrate.ts)**

- [ ] Dev (tsx): migrations load correctly
- [ ] Production (dist): migrations load correctly
- [ ] Docker: migrations apply on startup

**4. Safe Initialization (apps/agor-cli/src/commands/init.ts)**

- [ ] First run: `agor init --skip-if-exists` creates ~/.agor/
- [ ] Restart: `agor init --skip-if-exists` skips silently (no re-init)
- [ ] `--force` still works for explicit resets

**5. Docker Startup Script (docker-entrypoint.sh)**

- [ ] `pnpm install` runs with progress (not stuck)
- [ ] Config written to /root/.agor/config.yaml every startup
- [ ] Admin user created with --force flag
- [ ] Multiple container restarts don't break data

---

## Cross-Environment Tests

**Run in each environment:**

```bash
# Create a test session
curl -X POST http://localhost:3030/sessions \
  -H "Content-Type: application/json" \
  -d '{"name":"test"}'

# Query database
sqlite3 ~/.agor/agor.db "SELECT COUNT(*) FROM sessions"

# Test CLI
agor session list
agor repo list
```

**Expected:** All environments return same results

---

## Known Issues to Watch

| Issue                    | Environment            | Solution                              | Status             |
| ------------------------ | ---------------------- | ------------------------------------- | ------------------ |
| Platform binary mismatch | Host after Docker      | `rm -rf node_modules && pnpm install` | ✅ Documented      |
| Git hooks fail on host   | Host (after Docker)    | Reinstall or commit in Docker         | ✅ Documented      |
| Slow Claude SDK          | Codespaces (old)       | WAL mode + busy timeout               | ✅ Fixed in v0.6.5 |
| bypassPermissions reset  | Codespaces (root user) | Removed root restriction              | ✅ Fixed in v0.6.5 |
| Migrations not found     | Docker startup         | Smart path detection                  | ✅ Fixed in v0.6.5 |
| Init resets data         | Docker restart         | Added --skip-if-exists                | ✅ Fixed in v0.6.5 |

---

## Test Coverage Checklist

- [ ] agor-live installs and runs
- [ ] Codespaces: Fast SDK execution, correct permissions
- [ ] Local: Hot reload, git hooks, no binary conflicts
- [ ] Docker: Idempotent startup, container restarts safe
- [ ] All environments can create/list sessions
- [ ] SQLite concurrency handling works
- [ ] Database migrations apply correctly in all contexts
- [ ] Git commit workflow documented and tested
- [ ] Admin user always exists
- [ ] Config always in multiplayer mode (Docker)

**Estimated time:** 30-45 minutes per full test cycle
