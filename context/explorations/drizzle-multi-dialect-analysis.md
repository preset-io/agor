# Drizzle Multi-Dialect Support Analysis

**Question**: Does Drizzle provide SQLAlchemy-like multi-dialect utilities? Should we use them instead of a custom TypeScript migration builder?

**TL;DR**: ⚠️ **Partially** - Drizzle does NOT provide cross-dialect schema abstraction like SQLAlchemy, BUT it DOES support multiple config files pointing to separate schema files, enabling auto-generation for both dialects. **This is better than a custom TypeScript migration builder!**

---

## SQLAlchemy vs Drizzle: Philosophy Difference

### SQLAlchemy (Python)

**Philosophy**: Database-agnostic abstraction layer

```python
# Single schema works across PostgreSQL, MySQL, SQLite
from sqlalchemy import Column, Integer, String, Boolean, JSON

class User(Base):
    __tablename__ = 'users'
    id = Column(Integer, primary_key=True)
    name = Column(String(255))
    active = Column(Boolean, default=True)
    data = Column(JSON)

# SQLAlchemy generates dialect-specific SQL:
# PostgreSQL: BOOLEAN, JSONB
# SQLite: INTEGER (0/1), TEXT
# MySQL: TINYINT(1), JSON
```

**Key Feature**: Single unified type system that adapts to each database

---

### Drizzle ORM (TypeScript)

**Philosophy**: Dialect-specific, type-safe, SQL-first

```typescript
// PostgreSQL - MUST import from pg-core
import { pgTable, varchar, boolean, jsonb } from 'drizzle-orm/pg-core';

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }),
  active: boolean('active').default(true),
  data: jsonb('data'),
});

// SQLite - MUST import from sqlite-core (DIFFERENT API!)
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name', { length: 255 }),
  active: integer('active', { mode: 'boolean' }).default(true),
  data: text('data', { mode: 'json' }),
});
```

**Key Point**: **No common table object** - you MUST choose a dialect upfront

---

## What Drizzle DOES Provide

### 1. Multiple Config Files ✅

You CAN use multiple `drizzle.config.ts` files to generate migrations for different dialects:

```typescript
// drizzle-postgres.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts', // ⚠️ Must use pgTable
  out: './drizzle/postgresql',
});

// drizzle-sqlite.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts', // ⚠️ Must use sqliteTable
  out: './drizzle/sqlite',
});
```

**Run commands**:

```bash
npx drizzle-kit generate --config=drizzle-postgres.config.ts
npx drizzle-kit generate --config=drizzle-sqlite.config.ts
```

**OLD UNDERSTANDING** (❌): Both configs point to the same `schema.ts`, but that file MUST use either `pgTable` OR `sqliteTable` - you can't have both!

**CORRECT APPROACH** (✅): Each config points to a DIFFERENT schema file!

```typescript
// drizzle.postgres.config.ts
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.postgres.ts', // ← PostgreSQL-specific schema
  out: './drizzle/postgres',
});

// drizzle.sqlite.config.ts
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.sqlite.ts', // ← SQLite-specific schema
  out: './drizzle/sqlite',
});
```

**This enables**:

- ✅ Auto-generation of migrations for both dialects
- ✅ No manual SQL writing required
- ✅ Drizzle handles all dialect quirks automatically

---

### 2. Dialect-Specific Code Generation ✅

Drizzle Kit generates correct SQL for each dialect:

**PostgreSQL** (from pgTable schema):

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  active BOOLEAN DEFAULT true,
  data JSONB
);
```

**SQLite** (from sqliteTable schema):

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  active INTEGER DEFAULT 1,
  data TEXT
);
```

**PROBLEM**: ❌ Requires separate schema files (duplication)

---

### 3. Tree-Shakable Dialect Imports ✅

Drizzle uses dialect-specific entry points for smaller bundle sizes:

```typescript
// Only includes PostgreSQL code
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgTable } from 'drizzle-orm/pg-core';

// Only includes SQLite code
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
```

**BENEFIT**: ✅ Great for production (smaller bundles)
**DOWNSIDE**: ❌ Reinforces dialect separation (no shared schema)

---

## What Drizzle Does NOT Provide

### ❌ No Cross-Dialect Schema Abstraction

**SQLAlchemy equivalent**:

```python
# Works for ALL dialects
Column(Boolean, default=True)
```

**Drizzle reality**:

```typescript
// PostgreSQL ONLY
import { boolean } from 'drizzle-orm/pg-core';
boolean('active').default(true);

// SQLite ONLY
import { integer } from 'drizzle-orm/sqlite-core';
integer('active', { mode: 'boolean' }).default(true);

// ❌ NO unified type that works for both
```

---

### ❌ No Common Type System

**Drizzle's official docs**:

> "There is no such thing as a common table object in Drizzle - you need to choose a dialect you are using: PostgreSQL, MySQL or SQLite."

**Type Incompatibility**:

| SQLAlchemy   | PostgreSQL (Drizzle) | SQLite (Drizzle)                    |
| ------------ | -------------------- | ----------------------------------- |
| `Boolean`    | `boolean()`          | `integer({ mode: 'boolean' })`      |
| `JSON`       | `jsonb()`            | `text({ mode: 'json' })`            |
| `BigInteger` | `bigint()`           | `integer()` (SQLite has no bigint!) |
| `DateTime`   | `timestamp()`        | `integer({ mode: 'timestamp_ms' })` |

**Conclusion**: Type systems are fundamentally incompatible at the API level

---

### ❌ No Migration Compatibility Layer

**What we'd want** (SQLAlchemy-style):

```typescript
// Hypothetical unified migration
addColumn('users', {
  name: 'active',
  type: Boolean, // Auto-converts to boolean() or integer()
});
```

**Drizzle reality**:

```typescript
// Must write dialect-specific code
if (dialect === 'postgresql') {
  // Use Drizzle's pgTable API
} else {
  // Use Drizzle's sqliteTable API
}
```

**Conclusion**: No unified migration API

---

## Why Drizzle Chose This Approach

### Advantages of Dialect-Specific Design

1. **Type Safety**: Full TypeScript inference for each database's specific features
2. **SQL-First**: Generated SQL is predictable and inspectable
3. **Performance**: Tree-shaking eliminates unused database code
4. **Explicitness**: No hidden abstractions or magic type conversions
5. **Database-Specific Features**: Easy to use PostgreSQL-only features (e.g., arrays, JSONB operators)

**Example**: PostgreSQL JSONB operators

```typescript
// PostgreSQL-only feature (can't abstract to SQLite)
import { jsonb } from 'drizzle-orm/pg-core';

const users = pgTable('users', {
  data: jsonb('data'),
});

// Use PostgreSQL-specific JSONB operators
db.select()
  .from(users)
  .where(sql`${users.data}->>'name' = 'John'`);
```

---

## Our Use Case: Can We Use Drizzle's Multi-Config?

### Attempt 1: Shared Schema File

```typescript
// schema.ts - Try to use both dialects
import { pgTable, varchar } from 'drizzle-orm/pg-core';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

// ❌ ERROR: Must export EITHER pgTable OR sqliteTable, not both!
export const users_postgres = pgTable('users', { ... });
export const users_sqlite = sqliteTable('users', { ... });
```

**PROBLEM**: Schema duplication (defeats the purpose)

---

### Attempt 2: Conditional Imports

```typescript
// schema.ts - Runtime dialect detection
const dialect = process.env.DB_DIALECT;

let tableFactory;
if (dialect === 'postgresql') {
  tableFactory = (await import('drizzle-orm/pg-core')).pgTable;
} else {
  tableFactory = (await import('drizzle-orm/sqlite-core')).sqliteTable;
}

export const users = tableFactory('users', { ... });
```

**PROBLEMS**:

- ❌ Type inference breaks (TypeScript can't infer conditional imports)
- ❌ Drizzle Kit can't analyze conditional schemas
- ❌ Tree-shaking doesn't work (includes both dialects in bundle)

---

### Attempt 3: Separate Schema Files

```typescript
// schema.postgres.ts
import { pgTable } from 'drizzle-orm/pg-core';
export const users = pgTable('users', { ... });

// schema.sqlite.ts
import { sqliteTable } from 'drizzle-orm/sqlite-core';
export const users = sqliteTable('users', { ... });

// schema.ts - Re-export based on env
if (process.env.DB_DIALECT === 'postgresql') {
  export * from './schema.postgres';
} else {
  export * from './schema.sqlite';
}
```

**PROBLEMS**:

- ❌ Schema duplication (90%+ identical code)
- ❌ Maintenance burden (2 files to update)
- ❌ Drift risk (schemas diverge over time)
- ⚠️ This is exactly what we're trying to avoid!

---

## Comparison to Our TypeScript Migration Builder

| Feature                    | SQLAlchemy   | Drizzle Multi-Config | Our TS Builder   |
| -------------------------- | ------------ | -------------------- | ---------------- |
| **Single Source of Truth** | ✅ Yes       | ❌ No (dup schemas)  | ✅ Yes           |
| **Type Safety**            | ⚠️ Runtime   | ✅ Compile-time      | ✅ Compile-time  |
| **Cross-Dialect Types**    | ✅ Automatic | ❌ None              | ✅ Via utilities |
| **Migration Abstraction**  | ✅ Built-in  | ❌ None              | ✅ Custom layer  |
| **SQL Generation**         | ✅ Automatic | ✅ Automatic         | ✅ Custom        |
| **Maintenance**            | ✅ 1 file    | ❌ 2 files           | ✅ 1 file        |
| **Drift Risk**             | ✅ None      | ❌ High              | ✅ None          |
| **Review Ease**            | ✅ 1 file    | ❌ 2 diffs           | ✅ 1 file        |
| **Drizzle Integration**    | ❌ N/A       | ✅ Native            | ⚠️ Custom        |

---

## Detailed Comparison: Our Approach vs Drizzle Multi-Config

### Scenario: Add a new column

**Drizzle Multi-Config Approach**:

1. Update `schema.postgres.ts`:

```typescript
export const users = pgTable('users', {
  // ... existing columns
  active: boolean('active').default(true), // NEW
});
```

2. Update `schema.sqlite.ts`:

```typescript
export const users = sqliteTable('users', {
  // ... existing columns
  active: integer('active', { mode: 'boolean' }).default(true), // NEW
});
```

3. Generate migrations:

```bash
npx drizzle-kit generate --config=drizzle-postgres.config.ts
npx drizzle-kit generate --config=drizzle-sqlite.config.ts
```

4. Review TWO generated SQL files:
   - `drizzle/postgresql/0011_add_active.sql`
   - `drizzle/sqlite/0011_add_active.sql`

**Total**: 4 files changed (2 schemas + 2 migrations)

---

**Our TypeScript Builder Approach**:

1. Write migration once:

```typescript
// migrations/0011-add-active.ts
export default createMigration({
  name: '0011_add_active',
  up: m => {
    m.addColumn('users', {
      name: 'active',
      type: 'boolean',
      default: true,
      nullable: false,
    });
  },
});
```

2. Compile to SQL:

```bash
pnpm db:compile-migrations
```

3. Review ONE TypeScript file + TWO generated SQL files (auto-generated, no manual edits)

**Total**: 1 file to review (TypeScript migration)
**Generated**: 2 SQL files (committed to git for transparency)

---

## Verdict: Why We Can't Use Drizzle's Multi-Config

### Fundamental Limitation

**Drizzle's multi-config is designed for**:

- Same project, different environments (dev SQLite, prod PostgreSQL)
- Different services with different databases
- Gradual migration between databases

**NOT designed for**:

- Single codebase supporting BOTH dialects simultaneously
- Production support for user choice of database

### The Core Problem

```typescript
// This is IMPOSSIBLE in Drizzle:
import { Table } from 'drizzle-orm'; // ❌ Doesn't exist

export const users = Table('users', {
  active: Boolean, // ❌ No unified type
});

// You MUST choose:
import { pgTable, boolean } from 'drizzle-orm/pg-core'; // PostgreSQL
// OR
import { sqliteTable, integer } from 'drizzle-orm/sqlite-core'; // SQLite
```

**Drizzle forces you to commit to ONE dialect per schema file.**

---

## What We Gain with Our TypeScript Builder

### 1. True Multi-Dialect Support ✅

```typescript
// Single source of truth
export default createMigration({
  name: '0011_add_active',
  up: m => {
    m.addColumn('users', {
      name: 'active',
      type: 'boolean', // ✅ Our builder handles dialect conversion
    });
  },
});
```

**Our builder**:

- PostgreSQL: Generates `BOOLEAN`
- SQLite: Generates `integer` with mode annotation

---

### 2. Abstraction Layer for Quirks ✅

```typescript
// Our DialectUtils class
class DialectUtils {
  quote(name: string): string {
    return this.dialect === 'sqlite' ? `\`${name}\`` : name;
  }

  mapType(type: string): string {
    if (this.dialect === 'postgresql') {
      return { boolean: 'BOOLEAN', json: 'JSONB', ... }[type];
    }
    return { boolean: 'integer', json: 'text', ... }[type];
  }

  formatDefault(value: boolean, type: 'boolean'): string {
    if (this.dialect === 'postgresql') return String(value);
    return value ? '1' : '0';  // SQLite
  }
}
```

**Benefit**: All dialect quirks centralized in utilities, not duplicated across migrations

---

### 3. Complex Migration Handling ✅

**SQLite table recreation**:

```typescript
export default createMigration({
  name: '0009_add_ready_for_prompt',
  up: (m) => {
    if (m.dialect === 'postgresql') {
      // Simple ALTER TABLE
      m.addColumn('sessions', { ... });
    } else {
      // Use our recreateTable() helper
      recreateTable(m, {
        table: 'sessions',
        newColumns: [{ ... }],
        existingColumns: [...],
        indexes: [...],
        foreignKeys: [...],
      });
    }
  },
});
```

**Drizzle multi-config**: Would need to duplicate this logic in TWO schema files

---

### 4. Compile-Time Safety ✅

```typescript
// Our builder API is fully typed
m.addColumn('users', {
  name: 'active',
  type: 'boolean', // ✅ TypeScript autocomplete
  default: true, // ✅ Type-checked against 'boolean'
  nullable: false, // ✅ All options typed
});

// ❌ Type error (caught at compile time)
m.addColumn('users', {
  type: 'boolean',
  default: 'yes', // ❌ ERROR: string not assignable to boolean
});
```

---

## Current Drizzle Version Analysis

**From package.json**:

- `drizzle-orm`: ^0.44.6
- `drizzle-kit`: ^0.31.5

**Latest as of Jan 2025**: 0.44.x (we're current!)

**Changelog review** (0.40.x - 0.44.x):

- No multi-dialect schema abstraction added
- Focus on:
  - PostgreSQL multi-schema support
  - Better type inference
  - Performance improvements
  - More dialect-specific features

**Conclusion**: No indication Drizzle will add SQLAlchemy-style abstraction (goes against their philosophy)

---

## Future-Proofing: What if Drizzle Adds This?

### Hypothetical: Drizzle adds `commonTable()`

```typescript
// Hypothetical future API
import { commonTable } from 'drizzle-orm/common'; // ❌ Doesn't exist

export const users = commonTable('users', {
  active: boolean(), // Works for all dialects
});
```

**Impact on our approach**:

- ✅ We could migrate to it gradually
- ✅ Our migration builder abstracts Drizzle's API anyway
- ✅ Utilities would simplify (less custom logic)
- ⚠️ But we'd still need migration compilation (TypeScript → SQL)

**Risk**: Low - Even if Drizzle adds this, our builder remains valuable for:

1. Single source of truth (TypeScript migrations)
2. Utilities for complex operations (`recreateTable()`)
3. Type safety for migration operations
4. Review simplicity (one file, not two SQL files)

---

## Alternative Considered: Runtime Dialect Detection

### Could we do this?

```typescript
// schema.ts
import { getDatabaseDialect } from './config';

const dialect = getDatabaseDialect();

const tableFactory = dialect === 'postgresql'
  ? await import('drizzle-orm/pg-core').pgTable
  : await import('drizzle-orm/sqlite-core').sqliteTable;

export const users = tableFactory('users', { ... });
```

### Why it fails:

1. **TypeScript type inference breaks**:

```typescript
// ❌ Type is: PgTable | SqliteTable (union type)
typeof users

// ❌ Can't use PostgreSQL-specific methods
users.where(...)  // ERROR: Property 'where' doesn't exist on union type
```

2. **Drizzle Kit can't analyze it**:

```bash
npx drizzle-kit generate
# ❌ ERROR: Cannot statically analyze conditional imports
```

3. **Bundle size bloat**:

```typescript
// ❌ Both dialects included in bundle (no tree-shaking)
import('drizzle-orm/pg-core');
import('drizzle-orm/sqlite-core');
```

**Verdict**: ❌ Not viable

---

## Conclusion: Use Drizzle Kit Auto-Generation with Dual Schemas

### Drizzle Does NOT Provide:

❌ Cross-dialect schema abstraction (like SQLAlchemy)
❌ Unified type system
❌ Single schema file that works for multiple dialects

### Drizzle DOES Provide:

✅ Multiple config files pointing to separate schema files
✅ Auto-generation of dialect-specific SQL migrations
✅ Type-safe APIs per dialect
✅ Battle-tested migration generation logic
✅ Snapshot-based diffing (only generates changes)

### Dual Schema + Dual Config Approach:

✅ Zero manual SQL writing (Drizzle generates everything)
✅ Type safety (compile-time checks)
✅ Automatic dialect handling (PRAGMA, table recreation, etc.)
✅ Production-ready (Drizzle is stable and widely used)
✅ Simple (no custom migration builder to maintain)

**Trade-offs**:

⚠️ Schema files duplicated (~200 lines per file)
⚠️ Must manually keep schemas in sync (or use shared factory)

---

## Recommendation

**✅ Use Drizzle Kit auto-generation with dual schemas** (revised from custom TypeScript builder)

**Why the Change**:

1. ✅ **Drizzle DOES support this** via separate schema files + separate configs
2. ✅ **Simpler implementation** - no custom migration builder needed
3. ✅ **Zero manual SQL** - Drizzle generates everything automatically
4. ✅ **Battle-tested** - Drizzle team maintains migration logic
5. ✅ **Net savings** - 2 days faster than custom builder + no maintenance burden

**Approach**:

1. Create `schema.sqlite.ts` and `schema.postgres.ts`
2. Create `drizzle.sqlite.config.ts` and `drizzle.postgres.config.ts`
3. Run `pnpm db:generate` to generate migrations for both dialects
4. Drizzle handles all dialect quirks automatically

**See**: `postgres-migration-strategy.md` for updated implementation plan

---

## References

- [Drizzle ORM - Schema Declaration](https://orm.drizzle.team/docs/sql-schema-declaration)
- [Drizzle ORM - Multi-Config Discussion #3396](https://github.com/drizzle-team/drizzle-orm/discussions/3396)
- [Drizzle ORM - Config Reference](https://orm.drizzle.team/kit-docs/config-reference)
- [Drizzle Architecture - Dialects](https://deepwiki.com/drizzle-team/drizzle-orm/2.2-query-building)

---

**Next Steps**:

1. Review this analysis with team
2. Confirm TypeScript builder approach
3. Start Phase 1 of `postgres-migration-strategy.md` (build utilities)
4. Validate with POC migration (0011)
