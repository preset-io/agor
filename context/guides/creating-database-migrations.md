# How to Create Database Migrations

**Status:** ✅ Guide
**Related:** [[database-migrations]], [[postgres-support]], [[architecture]]

---

## Overview

Agor uses **Drizzle ORM** to manage database schema migrations for both SQLite and PostgreSQL. This guide shows you how to create new migrations when you modify the database schema.

## Prerequisites

- Understanding of Drizzle ORM basics
- Familiarity with both `schema.sqlite.ts` and `schema.postgres.ts`
- Docker environment running (for generating migrations)

---

## The Dual-Schema Pattern

Agor maintains **two separate schema files** to support both SQLite and PostgreSQL:

```
packages/core/src/db/
├── schema.sqlite.ts    # SQLite-specific schema
├── schema.postgres.ts  # PostgreSQL-specific schema
└── schema-factory.ts   # (Dead code - kept for reference)
```

### Why Two Schemas?

TypeScript type inference doesn't work well with a factory pattern for Drizzle schemas. The `schema-factory.ts` file exists but is **not actually used** in production. Instead, both schemas define type helpers **inline**:

```typescript
// In both schema files:
const t = {
  timestamp: (name: string) => ...,  // Dialect-specific
  bool: (name: string) => ...,       // Dialect-specific
  json: <T>(name: string) => ...,    // Dialect-specific
} as const;
```

### Keeping Schemas in Sync

**The golden rule:** When you modify one schema, you must modify the other to match.

**Only 3 types differ between dialects:**
1. **Timestamps:** `integer` (SQLite) vs `timestamp` (Postgres)
2. **Booleans:** `integer` (SQLite) vs `boolean` (Postgres)
3. **JSON:** `text` (SQLite) vs `jsonb` (Postgres)

**Everything else is identical:**
- Table structure
- Column names
- Indexes
- Foreign keys
- Constraints

---

## Step-by-Step: Creating a Migration

### Step 1: Modify Both Schema Files

When adding/removing/changing columns, update **both** `schema.sqlite.ts` and `schema.postgres.ts`.

**Example:** Removing unused columns from `mcp_servers` table

```typescript
// schema.sqlite.ts
export const mcpServers = sqliteTable(
  'mcp_servers',
  {
    // ... other columns ...

    scope: text('scope', {
      enum: ['global', 'session'],  // ← Changed from 4 to 2 values
    }).notNull(),

    // Scope foreign key
    owner_user_id: text('owner_user_id', { length: 36 }),
    // ❌ REMOVED: team_id, repo_id, session_id

    // ... other columns ...
  },
  (table) => ({
    nameIdx: index('mcp_servers_name_idx').on(table.name),
    scopeIdx: index('mcp_servers_scope_idx').on(table.scope),
    ownerIdx: index('mcp_servers_owner_idx').on(table.owner_user_id),
    // ❌ REMOVED: teamIdx, repoIdx, sessionIdx
    enabledIdx: index('mcp_servers_enabled_idx').on(table.enabled),
  })
);
```

```typescript
// schema.postgres.ts
export const mcpServers = pgTable(
  'mcp_servers',
  {
    // ... other columns ...

    scope: text('scope', {
      enum: ['global', 'session'],  // ← Same change
    }).notNull(),

    // Scope foreign key
    owner_user_id: varchar('owner_user_id', { length: 36 }),
    // ❌ REMOVED: team_id, repo_id, session_id

    // ... other columns ...
  },
  (table) => ({
    nameIdx: index('mcp_servers_name_idx').on(table.name),
    scopeIdx: index('mcp_servers_scope_idx').on(table.scope),
    ownerIdx: index('mcp_servers_owner_idx').on(table.owner_user_id),
    // ❌ REMOVED: teamIdx, repoIdx, sessionIdx
    enabledIdx: index('mcp_servers_enabled_idx').on(table.enabled),
  })
);
```

**Notice:** The only difference is `text()` vs `varchar()` - everything else is identical.

### Step 2: Generate Migrations

Migrations must be generated **inside the Docker environment** where the dependencies are installed.

```bash
# Generate SQLite migration
docker exec <container-name> sh -c "cd /app/packages/core && pnpm db:generate:sqlite"

# Generate PostgreSQL migration
docker exec <container-name> sh -c "cd /app/packages/core && pnpm db:generate:postgres"
```

**Example output:**
```
[✓] Your SQL migration file ➜ drizzle/sqlite/0014_graceful_ben_grimm.sql 🚀
[✓] Your SQL migration file ➜ drizzle/postgres/0004_nervous_imperial_guard.sql 🚀
```

### Step 3: Copy Migrations to Host

The migration files are generated inside Docker. Copy them to your host filesystem:

```bash
# Copy SQLite migration
docker cp <container-name>:/app/packages/core/drizzle/sqlite/0014_*.sql \
  packages/core/drizzle/sqlite/

# Copy Postgres migration
docker cp <container-name>:/app/packages/core/drizzle/postgres/0004_*.sql \
  packages/core/drizzle/postgres/

# Copy updated metadata (important!)
docker cp <container-name>:/app/packages/core/drizzle/sqlite/meta/ \
  packages/core/drizzle/sqlite/

docker cp <container-name>:/app/packages/core/drizzle/postgres/meta/ \
  packages/core/drizzle/postgres/
```

### Step 4: Review Generated SQL

**Always review the generated migrations** before committing!

```bash
# Review SQLite migration
cat packages/core/drizzle/sqlite/0014_graceful_ben_grimm.sql

# Review Postgres migration
cat packages/core/drizzle/postgres/0004_nervous_imperial_guard.sql
```

**Common patterns to look for:**
- **Column additions:** Should use `ALTER TABLE ADD COLUMN`
- **Column removals:** SQLite recreates table, Postgres drops column
- **Type changes:** SQLite recreates table, Postgres alters type
- **Index changes:** Dropped before table changes, recreated after

### Step 5: Test in Docker Environment

Restart the Docker environment to apply migrations:

```bash
# Via Agor MCP
mcp__agor__agor_environment_stop(worktreeId)
mcp__agor__agor_environment_start(worktreeId)

# Or via docker compose
docker compose -p <project-name> restart
```

**Check the logs** to verify migrations ran successfully:

```bash
docker compose -p <project-name> logs | grep -i migration
```

Expected output:
```
✅ Migrations complete
✅ Database is up to date
```

### Step 6: Verify Schema in Database

Connect to the Docker database and verify the schema changes:

```bash
# SQLite
docker exec <container-name> sqlite3 /home/agor/.agor/agor.db \
  "PRAGMA table_info(mcp_servers);"

# Postgres (if using Postgres)
docker exec <container-name> psql $DATABASE_URL \
  -c "\d mcp_servers"
```

### Step 7: Commit to Git

Once verified, commit the migration files:

```bash
git add packages/core/drizzle/sqlite/0014_*.sql
git add packages/core/drizzle/sqlite/meta/
git add packages/core/drizzle/postgres/0004_*.sql
git add packages/core/drizzle/postgres/meta/
git add packages/core/src/db/schema.sqlite.ts
git add packages/core/src/db/schema.postgres.ts

git commit -m "feat: remove unused MCP server scope columns

- Simplified MCPScope from 4 values to 2 (global, session)
- Removed team_id, repo_id, session_id columns from mcp_servers
- Removed corresponding foreign keys and indexes
- Generated migrations for both SQLite (0014) and Postgres (0004)"
```

---

## Common Migration Scenarios

### Adding a New Column

**1. Update both schemas:**

```typescript
// schema.sqlite.ts
export const myTable = sqliteTable('my_table', {
  // ... existing columns ...
  new_column: text('new_column'),  // ← Add new column
});

// schema.postgres.ts
export const myTable = pgTable('my_table', {
  // ... existing columns ...
  new_column: text('new_column'),  // ← Same change
});
```

**2. Generate migrations** (as described above)

**Result:**
```sql
-- SQLite
ALTER TABLE `my_table` ADD `new_column` text;

-- Postgres
ALTER TABLE "my_table" ADD COLUMN "new_column" text;
```

### Removing a Column

**1. Update both schemas** (remove the column)

**2. Generate migrations**

**Result:**
```sql
-- SQLite (recreates table)
CREATE TABLE `__new_my_table` (...);  -- Without removed column
INSERT INTO `__new_my_table` SELECT ... FROM `my_table`;
DROP TABLE `my_table`;
ALTER TABLE `__new_my_table` RENAME TO `my_table`;

-- Postgres (direct drop)
ALTER TABLE "my_table" DROP COLUMN "old_column";
```

### Changing a Column Type

**1. Update both schemas** (change the type)

**2. Generate migrations**

**Result:**
- **SQLite:** Recreates table with new type
- **Postgres:** Uses `ALTER COLUMN ... TYPE`

### Adding an Index

**1. Update both schemas** (add to the index section)

```typescript
(table) => ({
  // ... existing indexes ...
  newIdx: index('my_table_new_idx').on(table.new_column),
})
```

**2. Generate migrations**

**Result:**
```sql
CREATE INDEX "my_table_new_idx" ON "my_table" ("new_column");
```

---

## Migration File Structure

### Drizzle Migration Folders

```
packages/core/drizzle/
├── sqlite/
│   ├── 0000_pretty_mac_gargan.sql      # Baseline
│   ├── 0001_organic_stick.sql
│   ├── ...
│   ├── 0014_graceful_ben_grimm.sql     # Your new migration
│   └── meta/
│       ├── _journal.json                # Migration manifest
│       ├── 0000_snapshot.json           # Schema snapshots
│       └── 0014_snapshot.json
└── postgres/
    ├── 0000_loud_loki.sql
    ├── ...
    ├── 0004_nervous_imperial_guard.sql  # Your new migration
    └── meta/
        ├── _journal.json
        └── 0004_snapshot.json
```

### Journal File Format

`drizzle/sqlite/meta/_journal.json`:

```json
{
  "version": "7",
  "dialect": "sqlite",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": 1234567890,
      "tag": "0000_pretty_mac_gargan",
      "breakpoints": false
    },
    {
      "idx": 14,
      "version": "7",
      "when": 1732590180,
      "tag": "0014_graceful_ben_grimm",
      "breakpoints": true
    }
  ]
}
```

---

## Troubleshooting

### "drizzle-kit: not found"

**Problem:** drizzle-kit is not installed in your host environment

**Solution:** Always generate migrations **inside Docker** where dependencies are installed

```bash
docker exec <container-name> sh -c "cd /app/packages/core && pnpm db:generate:sqlite"
```

### "No schema changes, nothing to migrate"

**Problem:** The schema file wasn't updated, or changes were already migrated

**Solutions:**
1. Verify you updated **both** schema files
2. Check if a migration already exists for your changes
3. Ensure Docker picked up your schema changes (rebuild if needed)

### Migration Fails to Apply

**Problem:** SQL syntax error or constraint violation

**Steps:**
1. Review the generated SQL in `drizzle/*/XXXX.sql`
2. Check for breaking changes (e.g., removing a column with data)
3. Test the SQL manually in a test database
4. Consider a data migration script if needed

### Schemas Out of Sync

**Problem:** SQLite and Postgres schemas have different structures

**Prevention:**
- Always update both schemas together
- Use the same column names and types (except for the 3 dialect-specific types)
- Generate migrations for both dialects

**Detection:**
```bash
# Compare table definitions
docker exec <container-name> sqlite3 /home/agor/.agor/agor.db ".schema mcp_servers"
docker exec <container-name> psql $DATABASE_URL -c "\d mcp_servers"
```

---

## Best Practices

### ✅ Do:

- **Always update both schemas** - Never update just SQLite or Postgres alone
- **Generate both migrations** - Even if you're only using one database now
- **Review generated SQL** - Drizzle usually gets it right, but verify
- **Test in Docker first** - Don't apply migrations to production databases directly
- **Commit migrations with code** - Schema and code should be in sync
- **Use meaningful commit messages** - Explain what changed and why

### ❌ Don't:

- **Don't skip Postgres** - Even if you only use SQLite today, maintain both
- **Don't edit migrations manually** - Let Drizzle generate them (unless absolutely necessary)
- **Don't run migrations on production without backup** - Always backup first
- **Don't bypass migrations** - Use `drizzle-kit push` only for local development
- **Don't forget metadata** - Always copy the `meta/` folder along with SQL files

---

## Reference

### Drizzle Kit Commands

```bash
# Generate migration from schema diff
pnpm db:generate:sqlite
pnpm db:generate:postgres

# Push schema directly (dev only - skips migrations)
pnpm db:push:sqlite
pnpm db:push:postgres

# View pending migrations
agor db status

# Apply pending migrations
agor db migrate
```

### File Locations

- **Schemas:** `packages/core/src/db/schema.{sqlite,postgres}.ts`
- **Migrations:** `packages/core/drizzle/{sqlite,postgres}/`
- **Configs:** `packages/core/drizzle.{sqlite,postgres}.config.ts`
- **Runtime:** `packages/core/src/db/migrate.ts`

### Related Documentation

- [[database-migrations]] - Architecture overview
- [[postgres-support]] - Dual-dialect support
- [[architecture]] - System design
- [Drizzle Migrations Docs](https://orm.drizzle.team/docs/migrations)

---

## Real Example: MCP Server Scope Simplification

This guide was created while implementing the MCP server scoping fix. Here's the full workflow that was followed:

### Changes Made

**Goal:** Remove unused `team`, `repo` scopes and their associated columns

**Files Modified:**
1. `packages/core/src/db/schema.sqlite.ts` - Updated `mcpServers` table
2. `packages/core/src/db/schema.postgres.ts` - Updated `mcpServers` table
3. `packages/core/src/types/mcp.ts` - Updated `MCPScope` type
4. `packages/core/src/db/repositories/mcp-servers.ts` - Removed scope logic

**Schema Changes:**
- Changed `scope` enum from `['global', 'team', 'repo', 'session']` to `['global', 'session']`
- Removed columns: `team_id`, `repo_id`, `session_id`
- Removed foreign key references
- Removed indexes: `teamIdx`, `repoIdx`, `sessionIdx`

**Commands Run:**

```bash
# 1. Generate migrations
docker exec agor-session-scoped-mcp2-agor-dev-1 sh -c \
  "cd /app/packages/core && pnpm db:generate:sqlite"

docker exec agor-session-scoped-mcp2-agor-dev-1 sh -c \
  "cd /app/packages/core && pnpm db:generate:postgres"

# 2. Copy to host
docker cp agor-session-scoped-mcp2-agor-dev-1:/app/packages/core/drizzle/sqlite/0014_graceful_ben_grimm.sql \
  packages/core/drizzle/sqlite/

docker cp agor-session-scoped-mcp2-agor-dev-1:/app/packages/core/drizzle/postgres/0004_nervous_imperial_guard.sql \
  packages/core/drizzle/postgres/

docker cp agor-session-scoped-mcp2-agor-dev-1:/app/packages/core/drizzle/sqlite/meta/ \
  packages/core/drizzle/sqlite/

docker cp agor-session-scoped-mcp2-agor-dev-1:/app/packages/core/drizzle/postgres/meta/ \
  packages/core/drizzle/postgres/

# 3. Restart Docker to apply
mcp__agor__agor_environment_stop("586d2110-0ec0-436d-86f9-b6c9a8ebcfe9")
mcp__agor__agor_environment_start("586d2110-0ec0-436d-86f9-b6c9a8ebcfe9")

# 4. Verify
docker exec agor-session-scoped-mcp2-agor-dev-1 \
  sqlite3 /home/agor/.agor/agor.db "PRAGMA table_info(mcp_servers);"
```

**Result:**
- ✅ SQLite migration: 0014_graceful_ben_grimm.sql (recreates table)
- ✅ Postgres migration: 0004_nervous_imperial_guard.sql (drops columns/indexes)
- ✅ Both applied successfully in Docker environment
- ✅ Schema validated - unused columns removed

---

*This guide was created on 2025-11-26 during the MCP scoping fix implementation.*
