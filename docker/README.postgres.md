# PostgreSQL + RBAC Testing Environment

This Docker Compose profile provides a complete environment for testing Agor's RBAC and Unix integration features.

## Quick Start

```bash
# Option 1: Use .env.postgres file (recommended)
docker compose --env-file .env.postgres up

# Option 2: Copy to .env
cp .env.postgres .env
docker compose up
```

**Notes:**
- The `--profile postgres` flag is not needed because `.env.postgres` already sets `COMPOSE_PROFILES=postgres`.
- **First-time setup:** If you see a schema error about missing RBAC columns, drop the PostgreSQL volume and start fresh (see Troubleshooting section).

## What's Included

### Users

- **admin@agor.live** (password: `admin`)
  - Role: Admin
  - Default system administrator

- **alice@agor.live** (password: `admin`)
  - Unix user: `alice`
  - Role: Member
  - Owns: `alice-private` (full access)
  - Owns: `team-shared` (full access)

- **bob@agor.live** (password: `admin`)
  - Unix user: `bob`
  - Role: Member
  - Owns: `bob-private` (full access)
  - Access: `team-shared` (prompt permission - not yet fully implemented)

### Worktrees

- **alice-private** - Alice's private worktree (only alice has access)
- **bob-private** - Bob's private worktree (only bob has access)
- **team-shared** - Shared worktree (alice owns, bob can prompt)

### Features Enabled

- ✅ PostgreSQL database (multi-user capable)
- ✅ RBAC feature flag (`execution.worktree_rbac: true`)
- ✅ Unix integration (`execution.unix_user_mode: insulated`)
- ✅ SSH server (port 2222)
- ✅ Test users with Unix accounts
- ✅ Test worktrees with ownership

## Ports

- **4091** - Daemon API (http://localhost:4091)
- **6091** - UI (http://localhost:6091)
- **2222** - SSH (for multi-user testing)
- **5432** - PostgreSQL (internal, not exposed by default)

*Note: Different ports than default (3030/5173) to allow running alongside SQLite mode*

---

## Testing Scenarios

### 1. SSH Access Test

Test that alice and bob can SSH in with proper isolation:

```bash
# SSH as alice
ssh alice@localhost -p 2222  # password: admin

# Check worktree access
ls -la ~/agor/worktrees/
# Expected: alice-private, team-shared (both writable)

# Create file in alice-private
cd ~/agor/worktrees/alice-private
touch test.txt  # Should succeed

# Check filesystem permissions
ls -la test.txt
# Expected: -rw-r--r-- alice agor-wt-<worktree-id>
```

```bash
# SSH as bob
ssh bob@localhost -p 2222  # password: admin

# Check worktree access
ls -la ~/agor/worktrees/
# Expected: Only bob-private visible

# Try to access alice-private
ls /var/agor/worktrees/alice-private 2>&1
# Expected: Permission denied

# Check bob-private is writable
cd ~/agor/worktrees/bob-private
touch test.txt  # Should succeed
```

### 2. API Permission Test

Test RBAC enforcement via API:

```bash
# Get session tokens
ALICE_TOKEN=$(docker exec agor-unix-user-always-agor-dev-1 \
  pnpm agor session-token create alice@agor.live --json | jq -r '.token')

BOB_TOKEN=$(docker exec agor-unix-user-always-agor-dev-1 \
  pnpm agor session-token create bob@agor.live --json | jq -r '.token')

# List worktrees as alice
curl -H "Authorization: Bearer $ALICE_TOKEN" http://localhost:4091/worktrees
# Expected: alice-private, team-shared, (and any worktrees she has permission to)

# List worktrees as bob
curl -H "Authorization: Bearer $BOB_TOKEN" http://localhost:4091/worktrees
# Expected: bob-private, (and any worktrees he has permission to)

# Try to access alice-private as bob (should fail)
ALICE_PRIVATE_ID=$(docker exec agor-unix-user-always-agor-dev-1 \
  pnpm agor worktree list --json | jq -r '.[] | select(.name=="alice-private") | .worktree_id')

curl -H "Authorization: Bearer $BOB_TOKEN" \
  http://localhost:4091/worktrees/$ALICE_PRIVATE_ID
# Expected: 403 Forbidden
```

### 3. Unix Group Verification

Check that Unix groups are created and users are added correctly:

```bash
# List all agor worktree groups
docker exec agor-unix-user-always-agor-dev-1 getent group | grep agor-wt-

# Check alice's group membership
docker exec agor-unix-user-always-agor-dev-1 groups alice
# Expected: alice agor-wt-<alice-private-id> agor-wt-<team-shared-id>

# Check bob's group membership
docker exec agor-unix-user-always-agor-dev-1 groups bob
# Expected: bob agor-wt-<bob-private-id>
# Note: bob NOT in team-shared group (has 'prompt' permission, not 'all')
```

### 4. Filesystem Permissions Check

Verify that filesystem permissions match RBAC policies:

```bash
# Check alice-private worktree permissions
docker exec agor-unix-user-always-agor-dev-1 \
  ls -la /var/agor/worktrees/ | grep alice-private
# Expected: drwxrwx--- alice agor-wt-<worktree-id>

# Check that group members can write
docker exec agor-unix-user-always-agor-dev-1 \
  su alice -c 'touch /var/agor/worktrees/<alice-private-path>/test.txt'
# Expected: Success

# Check that non-members cannot read
docker exec agor-unix-user-always-agor-dev-1 \
  su bob -c 'ls /var/agor/worktrees/<alice-private-path>/ 2>&1'
# Expected: Permission denied
```

### 5. Web UI Test

Test RBAC in the web interface:

1. Open http://localhost:6091
2. Login as `alice@agor.live` / `admin`
3. Verify alice-private and team-shared worktrees are visible
4. Open alice-private worktree modal
5. Check "Owners & Permissions" section shows:
   - Owners: alice
   - Others can: (default setting)
6. Logout and login as `bob@agor.live` / `admin`
7. Verify bob-private is visible
8. Verify alice-private is NOT visible (bob has no permission)
9. Verify team-shared is visible (if bob has 'view' or 'prompt' permission)

---

## Configuration

The PostgreSQL environment uses these config overrides:

```yaml
# From .env.postgres
AGOR_DB_DIALECT=postgresql
DATABASE_URL=postgresql://agor:agor_dev_secret@postgres:5432/agor
AGOR_RBAC_ENABLED=true
AGOR_UNIX_USER_MODE=insulated
CREATE_RBAC_TEST_USERS=true
SEED=true
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGOR_RBAC_ENABLED` | `true` | Enable RBAC feature flag |
| `AGOR_UNIX_USER_MODE` | `insulated` | Unix integration mode (simple/insulated/opportunistic/strict) |
| `CREATE_RBAC_TEST_USERS` | `true` | Create alice & bob on startup |
| `SSH_PORT` | `2222` | Host port for SSH access |
| `DAEMON_PORT` | `4091` | Daemon API port |
| `UI_PORT` | `6091` | UI development server port |

### Unix User Modes

| Mode | Unix Groups | Filesystem Perms | Process Impersonation | Use Case |
|------|-------------|------------------|----------------------|----------|
| `simple` | ❌ | ❌ | ❌ | Testing RBAC without Unix integration |
| `insulated` | ✅ | ✅ | ❌ | **Default** - Filesystem isolation via groups |
| `opportunistic` | ✅ | ✅ | ✅ (best effort) | Audit trails + graceful degradation |
| `strict` | ✅ | ✅ | ✅ (required) | Compliance environments |

---

## Troubleshooting

### SSH Connection Refused

```bash
# Check if SSH server is running
docker exec agor-unix-user-always-agor-dev-1 pgrep sshd
# If empty, SSH server didn't start

# Check SSH server logs
docker logs agor-unix-user-always-agor-dev-1 | grep ssh

# Restart container
docker compose --profile postgres restart
```

### Permission Denied on Worktree Access

```bash
# Verify user is in correct groups
docker exec agor-unix-user-always-agor-dev-1 groups alice

# Check worktree ownership
docker exec agor-unix-user-always-agor-dev-1 \
  pnpm agor worktree owners list <worktree-id>

# Verify filesystem permissions
docker exec agor-unix-user-always-agor-dev-1 \
  ls -la /var/agor/worktrees/ | grep <worktree-name>
```

### Database Schema Error: Missing RBAC Columns

**Error:** `PostgresError: column "others_can" of relation "worktrees" does not exist`

**Cause:** Using an existing PostgreSQL volume from before RBAC migrations were added.

**Solution:** Drop the PostgreSQL volume and recreate:

```bash
# Stop containers
docker compose --env-file .env.postgres down

# Remove PostgreSQL volume (this will delete all data!)
docker volume rm agor-unix-user-always_postgres-data

# Start fresh
docker compose --env-file .env.postgres up
```

**Why this happens:** The PostgreSQL database was created before migrations 0006-0007 (RBAC columns) were added. When you start the environment, the seed script tries to create worktrees but the RBAC columns don't exist yet.

**Alternative (if you have data to preserve):**

```bash
# Manually run migrations
docker exec agor-unix-user-always-agor-dev-1 pnpm agor db migrate --yes
```

### Test Users Not Created

```bash
# Check if script ran
docker logs agor-unix-user-always-agor-dev-1 | grep "Creating RBAC test users"

# Manually run script
docker exec agor-unix-user-always-agor-dev-1 \
  pnpm tsx scripts/create-rbac-test-users.ts

# Verify users exist in database
docker exec agor-unix-user-always-agor-dev-1 \
  pnpm agor user list
```

### Unix Groups Not Created

Unix group creation is not yet fully implemented. The current setup:
- ✅ Creates Unix users (alice, bob)
- ✅ Creates Agor app users
- ✅ Creates worktrees with ownership in database
- ❌ Unix group creation (planned)
- ❌ Filesystem permission sync (planned)
- ❌ Symlink creation in `~/agor/worktrees/` (planned)

**Next steps for full Unix integration:**
1. Implement Unix group creation in `UnixIntegrationService`
2. Hook into worktree creation/ownership changes
3. Sync filesystem permissions based on RBAC
4. Create/update symlinks in user home directories

---

## Database Access

```bash
# Connect to PostgreSQL
docker exec -it agor-unix-user-always-postgres-1 \
  psql -U agor -d agor

# Useful queries
-- List all users
SELECT email, name, role FROM users;

-- List all worktrees with owners
SELECT w.name, u.email as owner
FROM worktrees w
JOIN worktree_owners wo ON w.worktree_id = wo.worktree_id
JOIN users u ON wo.user_id = u.user_id;

-- Check user permissions on worktree
SELECT u.email, w.name
FROM worktree_owners wo
JOIN users u ON wo.user_id = u.user_id
JOIN worktrees w ON wo.worktree_id = w.worktree_id
WHERE w.name = 'team-shared';
```

---

## Cleanup

```bash
# Stop containers
docker compose --profile postgres down

# Remove volumes (clears database and config)
docker compose --profile postgres down -v

# Remove images
docker compose --profile postgres down --rmi all

# Full cleanup (containers + volumes + images + networks)
docker compose --profile postgres down -v --rmi all --remove-orphans
```

---

## Comparison with SQLite Mode

| Feature | SQLite (default) | PostgreSQL + RBAC |
|---------|------------------|-------------------|
| **Database** | SQLite file | PostgreSQL server |
| **Users** | admin only | admin, alice, bob |
| **RBAC** | Disabled | Enabled |
| **Unix Integration** | No | Yes (insulated mode) |
| **SSH Access** | No | Yes (port 2222) |
| **Multi-user** | No | Yes |
| **Ports** | 3030 (daemon), 5173 (UI) | 4091 (daemon), 6091 (UI) |
| **Use Case** | Solo development | RBAC testing, multi-user |

---

## Related Documentation

- **`context/guides/rbac-and-unix-isolation.md`** - Complete RBAC + Unix integration guide
- **`context/explorations/unix-user-modes.md`** - Unix user mode design
- **`CLAUDE.md`** - Feature flags and configuration reference
- **`docker-compose.yml`** - Base Docker Compose configuration
- **`.env.postgres`** - PostgreSQL + RBAC environment variables

---

## Support

For issues or questions:
- Check logs: `docker logs agor-unix-user-always-agor-dev-1`
- GitHub Issues: https://github.com/preset-io/agor/issues
- Documentation: https://agor.live
