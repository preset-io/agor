# Database Dialect Abstraction

## The Blanket Solution: Unified Query API

Instead of sprinkling dialect checks (`isSQLiteDatabase()`, `isPostgresDatabase()`) throughout repository code, we use a **unified query API** that abstracts all dialect differences internally.

## Problem

Drizzle ORM has different execution methods for SQLite and PostgreSQL:

```typescript
// SQLite
const row = await db.select().from(users).where(eq(users.id, id)).get();
const rows = await db.select().from(users).all();
await db.delete(users).where(eq(users.id, id)).run();

// PostgreSQL
const results = await db.select().from(users).where(eq(users.id, id));
const row = results[0];
const rows = await db.select().from(users);
await db.delete(users).where(eq(users.id, id));
```

This creates 70+ places in the codebase where we need dialect checks.

## Solution

Our `database-wrapper.ts` provides query builders that return **augmented queries** with unified execution methods:

```typescript
// Works for BOTH dialects!
const row = await select(db).from(users).where(eq(users.id, id)).one();
const rows = await select(db).from(users).all();
await deleteFrom(db, users).where(eq(users.id, id)).run();
```

## Unified API Reference

### Query Execution Methods

Every query builder from `select()`, `insert()`, `update()`, `deleteFrom()` supports:

#### `.one()` - Get single row

```typescript
const user = await select(db).from(users).where(eq(users.id, id)).one();
// Returns: T | null
```

- **SQLite:** Calls `.get()`
- **PostgreSQL:** Calls `.limit(1)` and returns `[0]`
- **Returns:** Single row or `null`

#### `.all()` - Get all rows

```typescript
const users = await select(db).from(users).all();
// Returns: T[]
```

- **SQLite:** Calls `.all()`
- **PostgreSQL:** Awaits query directly
- **Returns:** Array of rows

#### `.run()` - Execute mutation

```typescript
const result = await deleteFrom(db, users).where(eq(users.id, id)).run();
// Returns: execution result
```

- **SQLite:** Calls `.run()`
- **PostgreSQL:** Awaits query directly
- **Returns:** Execution metadata

#### `.returning().one()` - Get first returned row

```typescript
const user = await insert(db, users).values({ email: 'test@example.com' }).returning().one();
// Returns: T
```

- **SQLite:** Calls `.returning().get()`
- **PostgreSQL:** Awaits `.returning()` and returns `[0]`

#### `.returning().all()` - Get all returned rows

```typescript
const users = await insert(db, users)
  .values([...multipleUsers])
  .returning()
  .all();
// Returns: T[]
```

## Migration Guide

### Before (Dialect Checks Everywhere)

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

## Common Patterns

### Check if entity exists

```typescript
const exists = !!(await select(db).from(users).where(eq(users.email, email)).one());
```

### Get by ID with null handling

```typescript
const user = await select(db).from(users).where(eq(users.id, id)).one();

if (!user) {
  throw new NotFoundError('User not found');
}
```

### Insert and return created entity

```typescript
const user = await insert(db, users)
  .values({ name: 'Alice', email: 'alice@example.com' })
  .returning()
  .one();

console.log(user.id); // Auto-generated ID
```

### List all with filters

```typescript
const activeUsers = await select(db).from(users).where(eq(users.status, 'active')).all();
```

### Update with result

```typescript
const result = await update(db, users)
  .set({ last_login: new Date() })
  .where(eq(users.id, userId))
  .run();
```

### Delete with result

```typescript
const result = await deleteFrom(db, users).where(eq(users.id, userId)).run();
```

## Implementation Details

The wrapper uses TypeScript proxies to preserve Drizzle's chainable API while injecting unified execution methods at the end of each chain.

### How it works

1. **Query Building:** All chainable methods (`.where()`, `.limit()`, `.orderBy()`, etc.) are preserved
2. **Execution:** Terminal methods (`.one()`, `.all()`, `.run()`) detect dialect and call appropriate driver methods
3. **Type Safety:** TypeScript sees the augmented interface with unified methods

### Internal Flow

```typescript
select(db)                    // Wrap initial query
  .from(users)                // Preserve .from() chain
  .where(eq(users.id, id))    // Preserve .where() chain
  .one()                      // Unified execution
    ↓
  isSQLiteDatabase(db)
    ? await query.get()
    : (await query.limit(1))[0]
```

## Remaining Work

The unified API is implemented in `database-wrapper.ts`. Migration progress:

- ✅ **Core wrapper:** Implemented with `.one()`, `.all()`, `.run()`, `.returning()`
- ✅ **Critical files:** `user-utils.ts`, `env-resolver.ts`, `migrate.ts` migrated
- ⏳ **Repository files:** 10 repository files still use old patterns (70+ occurrences)

### Files needing migration:

- `repositories/boards.ts` (15+ occurrences)
- `repositories/repos.ts` (12+ occurrences)
- `repositories/sessions.ts` (10+ occurrences)
- `repositories/tasks.ts` (10+ occurrences)
- `repositories/board-comments.ts` (8+ occurrences)
- `repositories/mcp-servers.ts` (6+ occurrences)
- `repositories/board-objects.ts` (6+ occurrences)
- `repositories/session-mcp-servers.ts` (3+ occurrences)
- `repositories/worktrees.ts` (2+ occurrences)

These can be migrated incrementally without breaking existing functionality.

## Testing

The unified API works with both dialects:

```bash
# Test with SQLite (default)
AGOR_DB_DIALECT=sqlite pnpm test

# Test with PostgreSQL
AGOR_DB_DIALECT=postgresql DATABASE_URL=postgresql://... pnpm test
```

Both should pass the same test suite without any code changes.

## Benefits

1. **Single Source of Truth:** Dialect logic lives in one place (`database-wrapper.ts`)
2. **Cleaner Code:** No dialect checks in business logic
3. **Easier Maintenance:** Add new dialects by updating wrapper only
4. **Type Safety:** TypeScript enforces unified API usage
5. **Better DX:** Clear, consistent patterns across codebase
6. **Future-Proof:** Easy to add MySQL, CockroachDB, etc.

---

**Key Principle:** Repository code should never know which database it's talking to. The wrapper handles all dialect differences transparently.
