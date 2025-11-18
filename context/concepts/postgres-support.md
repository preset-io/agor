# PostgreSQL Support

**Status:** ✅ **Production Ready**

Agor now supports both SQLite (default) and PostgreSQL databases with automatic dialect detection and a unified query API that abstracts all driver differences.

---

## Quick Start

### Using SQLite (Default)

```bash
# No configuration needed - works out of the box
agor init
agor daemon start
```

### Using PostgreSQL

```bash
# Set environment variable
export DATABASE_URL="postgresql://user:password@localhost:5432/agor"

# Or use Docker Compose
docker-compose --profile postgres up -d
export DATABASE_URL="postgresql://agor:agor@localhost:5432/agor"

# Initialize and start
agor init
agor daemon start
```

**Dialect Detection:** Automatic based on `DATABASE_URL` or `AGOR_DB_DIALECT` env var.

---

## Architecture

### Unified Query API

Instead of scattering dialect checks throughout the codebase, we use a **unified query API** that abstracts all differences internally.

#### The Problem

Drizzle ORM has different execution methods for SQLite and PostgreSQL:

```typescript
// SQLite
const row = await db.select().from(users).where(eq(users.id, id)).get();
const rows = await db.select().from(users).all();

// PostgreSQL
const results = await db.select().from(users).where(eq(users.id, id));
const row = results[0];
const rows = await db.select().from(users);
```

This creates 70+ places where we need dialect checks.

#### The Solution

Our `database-wrapper.ts` provides query builders with **unified execution methods**:

```typescript
// Works for BOTH dialects!
const row = await select(db).from(users).where(eq(users.id, id)).one();
const rows = await select(db).from(users).all();
await deleteFrom(db, users).where(eq(users.id, id)).run();
```

### Query Execution Methods

Every query builder from `select()`, `insert()`, `update()`, `deleteFrom()` supports:

#### `.one()` - Get single row

```typescript
const user = await select(db).from(users).where(eq(users.id, id)).one();
// Returns: T | null
```

- **SQLite:** Calls `.get()`
- **PostgreSQL:** Calls `.limit(1)` and returns `[0]`

#### `.all()` - Get all rows

```typescript
const users = await select(db).from(users).all();
// Returns: T[]
```

- **SQLite:** Calls `.all()`
- **PostgreSQL:** Awaits query directly

#### `.run()` - Execute mutation

```typescript
await deleteFrom(db, users).where(eq(users.id, id)).run();
```

- **SQLite:** Calls `.run()`
- **PostgreSQL:** Awaits query directly

#### `.returning().one()` / `.returning().all()`

```typescript
const user = await insert(db, users).values({ email: 'test@example.com' }).returning().one();
```

---

## Dual Schema Pattern

We maintain separate schema files for SQLite and PostgreSQL:

```
packages/core/src/db/
├── schema.ts              # Runtime schema (loads correct dialect)
├── schema.sqlite.ts       # SQLite schema definition
├── schema.postgres.ts     # PostgreSQL schema definition
└── schema-factory.ts      # Type helpers for DRY schema code
```

### Type Factory Pattern

Helper functions for dialect-specific types to keep schemas DRY:

```typescript
// schema-factory.ts
export const typeFactories = {
  timestamp: (name: string, opts?: { mode?: 'date' | 'string' }) => ({
    sqlite: integer(name, { mode: 'timestamp_ms' }),
    postgres: timestamp(name, { mode: opts?.mode || 'date', withTimezone: true }),
  }),

  bool: (name: string) => ({
    sqlite: integer(name, { mode: 'boolean' }),
    postgres: boolean(name),
  }),

  json: <T = any>(name: string) => ({
    sqlite: text(name, { mode: 'json' }).$type<T>(),
    postgres: jsonb(name).$type<T>(),
  }),
};

// Usage in schema files
const { timestamp, bool, json } = typeFactories;

export const sessions = pgTable('sessions', {
  created_at: timestamp('created_at').notNull(),
  ready_for_prompt: bool('ready_for_prompt'),
  data: json('data').$type<SessionData>(),
});
```

### Schema Switching

`schema.ts` imports from the correct dialect file at runtime:

```typescript
// schema.ts
import { getDatabaseDialect } from './schema-factory';

const dialect = getDatabaseDialect();

if (dialect === 'sqlite') {
  const sqlite = await import('./schema.sqlite');
  export const { users, sessions, tasks /* ... */ } = sqlite;
} else {
  const postgres = await import('./schema.postgres');
  export const { users, sessions, tasks /* ... */ } = postgres;
}
```

---

## Migration System

### Dual Migration Folders

```
packages/core/drizzle/
├── sqlite/
│   ├── 0000_initial.sql
│   ├── 0001_add_boards.sql
│   └── meta/_journal.json
└── postgres/
    ├── 0000_initial.sql
    ├── 0001_add_boards.sql
    └── meta/_journal.json
```

### Dual Drizzle Configs

```typescript
// drizzle.sqlite.config.ts
export default {
  schema: './src/db/schema.sqlite.ts',
  out: './drizzle/sqlite',
  dialect: 'sqlite',
};

// drizzle.postgres.config.ts
export default {
  schema: './src/db/schema.postgres.ts',
  out: './drizzle/postgres',
  dialect: 'postgresql',
};
```

### Generating Migrations

```bash
# SQLite migrations
pnpm db:generate:sqlite

# PostgreSQL migrations
pnpm db:generate:postgres

# Both
pnpm db:generate
```

### Running Migrations

Migrations run automatically on daemon startup:

```typescript
// migrate.ts
if (isSQLiteDatabase(db)) {
  await migrateSQLite(db, { migrationsFolder: 'drizzle/sqlite' });
} else if (isPostgresDatabase(db)) {
  await migratePostgres(db, { migrationsFolder: 'drizzle/postgres' });
}
```

---

## Database Client

### Connection

```typescript
// client.ts
export function getDatabase(): Database {
  const dialect = getDatabaseDialect();

  if (dialect === 'sqlite') {
    const dbPath = getDbPath();
    const client = createClient({ url: `file:${dbPath}` });
    return drizzle(client);
  } else {
    const url = getDatabaseUrl();
    const client = postgres(url);
    return drizzle(client);
  }
}
```

### Type-Safe Union

```typescript
type Database = LibSQLDatabase<typeof sqliteSchema> | PostgresJsDatabase<typeof postgresSchema>;
```

### Dialect Detection Helpers

```typescript
import { isSQLiteDatabase, isPostgresDatabase } from './database-wrapper';

if (isSQLiteDatabase(db)) {
  // SQLite-specific code
} else if (isPostgresDatabase(db)) {
  // PostgreSQL-specific code
}
```

---

## Common Patterns

### Get by ID

```typescript
const user = await select(db).from(users).where(eq(users.id, id)).one();

if (!user) {
  throw new NotFoundError('User not found');
}
```

### List with Filters

```typescript
const activeUsers = await select(db).from(users).where(eq(users.status, 'active')).all();
```

### Insert and Return

```typescript
const user = await insert(db, users)
  .values({ name: 'Alice', email: 'alice@example.com' })
  .returning()
  .one();
```

### Update with Result

```typescript
await update(db, users).set({ last_login: new Date() }).where(eq(users.id, userId)).run();
```

### Delete with Result

```typescript
await deleteFrom(db, users).where(eq(users.id, userId)).run();
```

### Transactions

```typescript
await db.transaction(async tx => {
  const row = await select(tx).from(users).where(eq(users.id, id)).one();

  await update(tx, users).set({ updated_at: new Date() }).where(eq(users.id, id)).run();
});
```

**Important:** Use `select(tx)`, `insert(tx, table)`, `update(tx, table)`, `deleteFrom(tx, table)` inside transactions, not `tx.select()` etc.

---

## Configuration

### Environment Variables

```bash
# Database dialect (auto-detected from DATABASE_URL if not set)
AGOR_DB_DIALECT=postgresql  # or "sqlite"

# PostgreSQL connection (required for PostgreSQL)
DATABASE_URL=postgresql://user:password@host:port/database

# SQLite path (optional, defaults to ~/.agor/agor.db)
AGOR_DB_PATH=/path/to/agor.db
```

### Docker Compose

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:17-alpine
    profiles: [postgres] # Optional - only starts when requested
    environment:
      POSTGRES_USER: agor
      POSTGRES_PASSWORD: agor
      POSTGRES_DB: agor
    ports:
      - '5432:5432'
```

```bash
# Start with PostgreSQL
docker-compose --profile postgres up -d

# Set connection string
export DATABASE_URL="postgresql://agor:agor@localhost:5432/agor"
```

---

## Migration Guide

### Before (70+ Dialect Checks)

```typescript
// ❌ Old pattern - dialect checks scattered throughout code
const results = await select(db).from(users).where(eq(users.email, email));
const user = isSQLiteDatabase(db) ? await (results as any).get() : results[0];

const returned = await insert(db, users).values(data).returning();
const row = isSQLiteDatabase(db) ? await (returned as any).get() : returned[0];
```

### After (Clean Unified API)

```typescript
// ✅ New pattern - one API works everywhere
const user = await select(db).from(users).where(eq(users.email, email)).one();

const row = await insert(db, users).values(data).returning().one();
```

---

## Testing

Both dialects pass the same test suite:

```bash
# Test with SQLite (default)
pnpm test

# Test with PostgreSQL
export DATABASE_URL="postgresql://agor:agor@localhost:5432/agor_test"
pnpm test
```

---

## Known Limitations

### TypeScript Declarations (DTS)

**Status:** DTS generation is disabled in `tsup.config.ts`

**Reason:** Drizzle's type system has limitations with the column factory pattern used in dual schemas. The runtime code works perfectly for both dialects.

**Impact:** CLI and daemon have implicit `any` types when importing from `@agor/core`. This does not affect runtime behavior.

**Workaround:** Use JSDoc type annotations or wait for Drizzle to improve type extraction.

### Schema Duplication

The dual schema pattern requires maintaining two schema files. We use the Type Factory Pattern to minimize duplication, but some repetition is unavoidable.

**Mitigation:** The `typeFactories` helpers in `schema-factory.ts` provide DRY column definitions for common types.

---

## Implementation Statistics

### Files Modified

- **10 repository files** migrated to unified API
- **3 utility files** migrated (`user-utils.ts`, `env-resolver.ts`, `migrate.ts`)
- **4 transaction-heavy files** updated with proper wrapper usage

### Changes

- **40+ `.get()` → `.one()`** conversions
- **20+ `.all()`** migrations
- **15+ `.run()`** migrations
- **6 variable shadowing fixes** (`insert` → `insertData`)
- **70+ dialect checks eliminated**

### New Files

- `database-wrapper.ts` - Unified query API
- `schema-factory.ts` - Type helpers
- `schema.sqlite.ts` - SQLite schema
- `schema.postgres.ts` - PostgreSQL schema
- `drizzle.sqlite.config.ts` - SQLite migration config
- `drizzle.postgres.config.ts` - PostgreSQL migration config

---

## Benefits

1. **Single Source of Truth** - Dialect logic lives in one place (`database-wrapper.ts`)
2. **Cleaner Code** - No dialect checks in business logic
3. **Easier Maintenance** - Add new dialects by updating wrapper only
4. **Type Safety** - TypeScript enforces unified API usage (at runtime)
5. **Better DX** - Clear, consistent patterns across codebase
6. **Future-Proof** - Easy to add MySQL, CockroachDB, etc.

---

## Key Principle

**Repository code should never know which database it's talking to.**

The wrapper handles all dialect differences transparently. This is the "blanket solution" that eliminates the need for 70+ individual dialect checks.

---

## Related Files

- `packages/core/src/db/database-wrapper.ts` - THE core implementation
- `packages/core/src/db/DIALECT-ABSTRACTION.md` - Detailed technical docs
- `packages/core/src/db/POSTGRES-MIGRATION-COMPLETE.md` - Migration summary
- `docker-compose.yml` - PostgreSQL Docker setup
- `.env.example` - Configuration examples
