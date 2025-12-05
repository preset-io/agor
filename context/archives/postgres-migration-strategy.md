# PostgreSQL Migration Strategy: Drizzle Kit Auto-Generation

**Status**: ✅ Recommended Approach
**Decision**: Use Drizzle Kit to auto-generate migrations for both dialects
**Related**: postgres-support.md, drizzle-multi-dialect-analysis.md

---

## Executive Summary

**Recommendation**: Use **dual schema files + Drizzle Kit auto-generation** rather than custom migration builder or manual SQL duplication.

**Rationale**:

- ✅ Drizzle Kit auto-generates dialect-specific SQL migrations from schemas
- ✅ Battle-tested migration logic from Drizzle team (handles all quirks)
- ✅ No manual SQL writing required (huge time savings)
- ✅ Type-safe schema definitions catch errors at compile time
- ✅ Snapshot-based diffing (only generates what changed)
- ✅ Simpler implementation (no custom migration builder needed)
- ✅ Separate migration folders keep dialects isolated (`drizzle/sqlite/`, `drizzle/postgres/`)

**Trade-off**: Schema definitions must be maintained in two files (`schema.sqlite.ts` and `schema.postgres.ts`), but this is minimal duplication compared to maintaining migrations manually.

---

## Current Migration Patterns Analysis

### Migration Types by Complexity

| Migration | Type                      | Lines | Complexity                     |
| --------- | ------------------------- | ----- | ------------------------------ |
| 0000      | Initial schema            | 196   | High (11 tables, indexes, FKs) |
| 0001      | Add column                | 1     | Trivial                        |
| 0002      | Add columns + indexes     | 9     | Simple                         |
| 0003      | Table recreation (SQLite) | 37    | Medium (PRAGMA, temp table)    |
| 0004      | Table recreation (SQLite) | 64    | Medium (PRAGMA, temp table)    |
| 0005      | Add columns + index       | 3     | Simple                         |
| 0008      | Add column                | 1     | Trivial                        |
| 0009      | Table recreation (SQLite) | 112   | High (2 tables, PRAGMA)        |
| 0010      | Add columns               | 6     | Simple                         |

**Breakdown**:

- 50% trivial/simple (just `ALTER TABLE ADD COLUMN`)
- 30% table recreation (SQLite-specific, PostgreSQL uses `ALTER TABLE`)
- 20% initial schema (CREATE TABLE)

### Dialect Differences Catalog

#### 1. **Backticks vs No Backticks**

**SQLite**:

```sql
ALTER TABLE `sessions` ADD `ready_for_prompt` integer DEFAULT 0 NOT NULL;
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);
```

**PostgreSQL**:

```sql
ALTER TABLE sessions ADD ready_for_prompt BOOLEAN DEFAULT false NOT NULL;
CREATE INDEX sessions_status_idx ON sessions (status);
```

**Difference**: SQLite uses backticks for identifiers, PostgreSQL uses plain identifiers.

---

#### 2. **Boolean Type**

**SQLite**:

```sql
`resolved` integer DEFAULT false NOT NULL
```

**PostgreSQL**:

```sql
resolved BOOLEAN DEFAULT false NOT NULL
```

**Difference**: SQLite uses `integer` with mode, PostgreSQL has native `BOOLEAN`.

---

#### 3. **Timestamp Type**

**SQLite**:

```sql
`created_at` integer NOT NULL  -- milliseconds since epoch
```

**PostgreSQL**:

```sql
created_at BIGINT NOT NULL  -- milliseconds since epoch (for compatibility)
-- OR
created_at TIMESTAMP WITH TIME ZONE NOT NULL  -- native timestamp
```

**Difference**: Both can use integers for Unix timestamps, or PostgreSQL can use native `TIMESTAMP`.

**Decision**: Use `BIGINT` for PostgreSQL to maintain compatibility with existing data.

---

#### 4. **JSON Type**

**SQLite**:

```sql
`data` text NOT NULL
`reactions` text DEFAULT '[]' NOT NULL
```

**PostgreSQL**:

```sql
data JSONB NOT NULL
reactions JSONB DEFAULT '[]' NOT NULL
```

**Difference**: SQLite uses `text`, PostgreSQL uses `JSONB` (binary JSON).

---

#### 5. **Text/Varchar Type**

**SQLite**:

```sql
`session_id` text(36) PRIMARY KEY NOT NULL
`content` text NOT NULL
```

**PostgreSQL**:

```sql
session_id VARCHAR(36) PRIMARY KEY NOT NULL
content TEXT NOT NULL
```

**Difference**: SQLite uses `text(length)`, PostgreSQL uses `VARCHAR(length)` for limited, `TEXT` for unlimited.

---

#### 6. **Foreign Keys**

**SQLite**:

```sql
FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade
```

**PostgreSQL**:

```sql
FOREIGN KEY (board_id) REFERENCES boards(board_id) ON UPDATE NO ACTION ON DELETE CASCADE
```

**Difference**: Casing (`no action` vs `NO ACTION`) and backticks.

---

#### 7. **PRAGMA Statements**

**SQLite**:

```sql
PRAGMA foreign_keys=OFF;
-- ... table recreation
PRAGMA foreign_keys=ON;
```

**PostgreSQL**:

```sql
-- Not needed (transactional DDL)
```

**Difference**: SQLite requires PRAGMA for safe table recreation, PostgreSQL doesn't.

---

#### 8. **Table Recreation (ALTER COLUMN)**

**SQLite** (no ALTER COLUMN support):

```sql
PRAGMA foreign_keys=OFF;

CREATE TABLE sessions_new (
  session_id text(36) PRIMARY KEY NOT NULL,
  -- ... all columns with new schema
);

INSERT INTO sessions_new (session_id, ...)
SELECT session_id, ... FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

PRAGMA foreign_keys=ON;

-- Recreate indexes
CREATE INDEX sessions_status_idx ON sessions (status);
```

**PostgreSQL**:

```sql
ALTER TABLE sessions ADD COLUMN ready_for_prompt BOOLEAN DEFAULT false NOT NULL;
-- No table recreation needed
```

**Difference**: Massive (37-112 lines for SQLite vs 1 line for PostgreSQL).

---

#### 9. **Default Values**

**SQLite**:

```sql
`created_by` text(36) DEFAULT 'anonymous' NOT NULL
`enabled` integer DEFAULT true NOT NULL  -- boolean as integer
```

**PostgreSQL**:

```sql
created_by VARCHAR(36) DEFAULT 'anonymous' NOT NULL
enabled BOOLEAN DEFAULT true NOT NULL
```

**Difference**: Boolean defaults are `true`/`false` in PostgreSQL vs `integer` in SQLite.

---

#### 10. **Auto-increment**

**SQLite**:

```sql
CREATE TABLE __drizzle_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

**PostgreSQL**:

```sql
CREATE TABLE __drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
```

**Difference**: `AUTOINCREMENT` vs `SERIAL`.

---

## Migration Patterns by Category

### Category A: Simple ADD COLUMN (50% of migrations)

**Examples**: 0001, 0002, 0005, 0008, 0010

**SQLite**:

```sql
ALTER TABLE `messages` ADD `parent_tool_use_id` text;
ALTER TABLE `sessions` ADD `scheduled_run_at` integer;
```

**PostgreSQL**:

```sql
ALTER TABLE messages ADD parent_tool_use_id TEXT;
ALTER TABLE sessions ADD scheduled_run_at BIGINT;
```

**Differences**:

- ✅ Backticks removal (easy)
- ✅ Type mapping (`integer` → `BIGINT`, `text` → `TEXT/VARCHAR`)
- ✅ Identical structure

**Complexity**: Low (mechanical transformation)

---

### Category B: CREATE INDEX (20% of migrations)

**SQLite**:

```sql
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);
CREATE INDEX `worktrees_board_schedule_idx` ON `worktrees` (`board_id`,`schedule_enabled`);
```

**PostgreSQL**:

```sql
CREATE INDEX sessions_status_idx ON sessions (status);
CREATE INDEX worktrees_board_schedule_idx ON worktrees (board_id, schedule_enabled);
```

**Differences**:

- ✅ Backticks removal
- ✅ Identical structure

**Complexity**: Low (mechanical transformation)

---

### Category C: CREATE TABLE (20% of migrations)

**SQLite** (from 0000):

```sql
CREATE TABLE `sessions` (
	`session_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`status` text NOT NULL,
	`ready_for_prompt` integer DEFAULT false NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade
);
```

**PostgreSQL**:

```sql
CREATE TABLE sessions (
	session_id VARCHAR(36) PRIMARY KEY NOT NULL,
	created_at BIGINT NOT NULL,
	status TEXT NOT NULL,
	ready_for_prompt BOOLEAN DEFAULT false NOT NULL,
	data JSONB NOT NULL,
	FOREIGN KEY (worktree_id) REFERENCES worktrees(worktree_id) ON UPDATE NO ACTION ON DELETE CASCADE
);
```

**Differences**:

- ✅ Backticks removal
- ✅ Type mapping (`integer` → `BIGINT`, `text` → `TEXT/VARCHAR/JSONB`, `integer DEFAULT false` → `BOOLEAN DEFAULT false`)
- ✅ FK casing (`no action` → `NO ACTION`)
- ✅ Identical structure

**Complexity**: Medium (type mapping required)

---

### Category D: Table Recreation (10% of migrations, SQLite-only)

**Examples**: 0003, 0004, 0009

**SQLite** (from 0009):

```sql
PRAGMA foreign_keys=OFF;

CREATE TABLE `sessions_new` (
  `session_id` text(36) PRIMARY KEY NOT NULL,
  -- ... 20+ columns
  FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade
);

INSERT INTO `sessions_new` (session_id, created_at, ...)
SELECT session_id, created_at, ... FROM `sessions`;

DROP TABLE `sessions`;
ALTER TABLE `sessions_new` RENAME TO `sessions`;

PRAGMA foreign_keys=ON;

CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);
-- ... 5+ more indexes
```

**PostgreSQL** (equivalent):

```sql
ALTER TABLE sessions ADD COLUMN ready_for_prompt BOOLEAN DEFAULT false NOT NULL;
```

**Differences**:

- 🔴 **Completely different approach**
- SQLite: 37-112 lines of table recreation
- PostgreSQL: 1-5 lines of `ALTER TABLE`

**Complexity**: High (requires migration template logic)

---

## Design Options

### Option 1: Duplicate SQL Files (Status Quo)

**Structure**:

```
packages/core/
├── drizzle.sqlite/
│   ├── 0000_pretty_mac_gargan.sql (196 lines)
│   ├── 0001_organic_stick.sql (1 line)
│   └── meta/
└── drizzle.postgresql/
    ├── 0000_initial_schema.sql (196 lines, 90% identical)
    ├── 0001_add_parent_tool_use_id.sql (1 line, 90% identical)
    └── meta/
```

**Pros**:

- ✅ Simple (Drizzle's native approach)
- ✅ No custom tooling needed
- ✅ SQL is directly inspectable

**Cons**:

- ❌ Massive duplication (90%+ identical code)
- ❌ Double maintenance burden (change = 2 PRs)
- ❌ Drift risk (SQLite gets fix, PostgreSQL doesn't)
- ❌ Harder to review (need to diff both files)
- ❌ No type safety (SQL strings)

**Verdict**: ❌ **Rejected** - violates DRY, high maintenance burden

---

### Option 2: Template SQL Files

**Structure**:

```
packages/core/
├── drizzle.templates/
│   ├── 0000_initial_schema.sql.hbs
│   └── 0001_add_column.sql.hbs
├── scripts/
│   └── generate-migrations.ts
└── drizzle.sqlite/     # Generated
└── drizzle.postgresql/ # Generated
```

**Example template**:

```sql
-- 0001_add_column.sql.hbs
ALTER TABLE {{#if postgres}}sessions{{else}}`sessions`{{/if}}
ADD {{#if postgres}}parent_tool_use_id TEXT{{else}}`parent_tool_use_id` text{{/if}};
```

**Pros**:

- ✅ Single source of truth
- ✅ No duplication

**Cons**:

- ❌ Handlebars in SQL (ugly, hard to read)
- ❌ Complex templates for table recreation
- ❌ No type safety
- ❌ Hard to debug generated SQL
- ❌ Extra build step

**Verdict**: ❌ **Rejected** - templates too complex for SQL

---

### Option 3: TypeScript Migration Builder (Recommended)

**Structure**:

```
packages/core/
├── src/db/migrations/
│   ├── 0000-initial-schema.ts
│   ├── 0001-add-parent-tool-use-id.ts
│   ├── utils/
│   │   ├── migration-builder.ts
│   │   ├── types.ts
│   │   └── dialect-utils.ts
│   └── index.ts
├── scripts/
│   └── compile-migrations.ts
└── drizzle.sqlite/     # Generated from TS
└── drizzle.postgresql/ # Generated from TS
```

**Example migration (TypeScript)**:

```typescript
// 0001-add-parent-tool-use-id.ts
import { createMigration } from './utils/migration-builder';

export default createMigration({
  name: '0001_add_parent_tool_use_id',
  up: m => {
    m.addColumn('messages', {
      name: 'parent_tool_use_id',
      type: 'text',
      nullable: true,
    });
  },
});
```

**Generated SQLite**:

```sql
ALTER TABLE `messages` ADD `parent_tool_use_id` text;
```

**Generated PostgreSQL**:

```sql
ALTER TABLE messages ADD parent_tool_use_id TEXT;
```

**Pros**:

- ✅ Single source of truth (TypeScript)
- ✅ Type safety (catches errors at compile time)
- ✅ DRY utilities abstract dialect quirks
- ✅ Easy to review (one file, not two)
- ✅ Programmatic (can generate complex migrations)
- ✅ Testable (unit tests for migration logic)

**Cons**:

- ⚠️ Custom tooling (migration builder)
- ⚠️ Extra compile step (but automated)
- ⚠️ Learning curve (new API)

**Verdict**: ✅ **RECOMMENDED** - best balance of DRY + type safety

---

### Option 4: Drizzle Schema-Based (Future)

**Approach**: Let Drizzle generate migrations from schema changes

**Pros**:

- ✅ No manual migrations
- ✅ Drizzle handles dialect differences

**Cons**:

- ❌ Not ready for production (Drizzle's diffing is experimental)
- ❌ Can't handle data migrations
- ❌ Lost in complex scenarios (table recreation)

**Verdict**: ⏸️ **Deferred** - wait for Drizzle maturity

---

## Recommended Approach: Drizzle Kit Auto-Generation with Dual Schemas

### Why Drizzle Kit Auto-Generation?

After analyzing the options (duplicate SQL, custom TypeScript builder, template SQL), **Drizzle Kit's native multi-config support** emerged as the best solution:

**Advantages**:

1. ✅ **Battle-tested** - Drizzle team maintains migration generation logic
2. ✅ **Zero manual SQL** - Schema changes → automatic migration generation
3. ✅ **Handles all dialect quirks** automatically:
   - SQLite: PRAGMA statements, table recreation for ALTER COLUMN, backticks
   - PostgreSQL: Simple ALTER TABLE, no PRAGMA, plain identifiers
4. ✅ **Snapshot-based** - Only generates diffs (what actually changed)
5. ✅ **Type-safe** - Schema errors caught at compile time
6. ✅ **Simple** - No custom migration builder to maintain

**Trade-off**: Need to maintain dual schema files, but this is minimal compared to maintaining complex migration builder.

---

### Architecture

```
packages/core/
├── src/db/
│   ├── schema.ts              # Runtime re-export (based on config dialect)
│   ├── schema.sqlite.ts       # SQLite schema (sqliteTable)
│   ├── schema.postgres.ts     # PostgreSQL schema (pgTable)
│   └── schema-factory.ts      # Shared column definitions (optional DRY helper)
│
├── drizzle/
│   ├── sqlite/
│   │   ├── 0000_initial_schema.sql
│   │   ├── 0001_add_parent_tool_use_id.sql
│   │   └── meta/
│   │       ├── _journal.json
│   │       └── 0000_snapshot.json
│   └── postgres/
│       ├── 0000_initial_schema.sql
│       ├── 0001_add_parent_tool_use_id.sql
│       └── meta/
│           ├── _journal.json
│           └── 0000_snapshot.json
│
├── drizzle.sqlite.config.ts   # Drizzle Kit config for SQLite
└── drizzle.postgres.config.ts # Drizzle Kit config for PostgreSQL
```

---

### Dual Schema Files

**SQLite Schema**:

```typescript
// packages/core/src/db/schema.sqlite.ts

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable(
  'sessions',
  {
    session_id: text('session_id', { length: 36 }).primaryKey(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    status: text('status', { enum: ['idle', 'running', 'completed', 'failed'] }).notNull(),
    ready_for_prompt: integer('ready_for_prompt', { mode: 'boolean' }).notNull().default(false),
    data: text('data', { mode: 'json' }).$type<SessionData>().notNull(),
    // ... rest of columns
  },
  table => ({
    statusIdx: index('sessions_status_idx').on(table.status),
    // ... indexes
  })
);

// ... all other tables
```

**PostgreSQL Schema**:

```typescript
// packages/core/src/db/schema.postgres.ts

import { pgTable, text, bigint, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const sessions = pgTable(
  'sessions',
  {
    session_id: text('session_id', { length: 36 }).primaryKey(),
    created_at: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    status: text('status', { enum: ['idle', 'running', 'completed', 'failed'] }).notNull(),
    ready_for_prompt: boolean('ready_for_prompt').notNull().default(false),
    data: jsonb('data').$type<SessionData>().notNull(),
    // ... rest of columns
  },
  table => ({
    statusIdx: index('sessions_status_idx').on(table.status),
    // ... indexes
  })
);

// ... all other tables
```

**Shared Factory** (optional, to reduce duplication):

```typescript
// packages/core/src/db/schema-factory.ts

export const sessionsColumns = {
  session_id: { type: 'id', primaryKey: true },
  created_at: { type: 'timestamp', notNull: true },
  status: { type: 'enum', enum: ['idle', 'running', 'completed', 'failed'], notNull: true },
  ready_for_prompt: { type: 'boolean', notNull: true, default: false },
  data: { type: 'json', notNull: true },
  // ... rest of columns
};

// Use this as reference when creating both schema files
```

---

### Drizzle Configs

**SQLite Config**:

```typescript
// packages/core/drizzle.sqlite.config.ts

import { defineConfig } from 'drizzle-kit';
import { expandPath } from './dist/utils/path.js';

export default defineConfig({
  schema: './src/db/schema.sqlite.ts',
  out: './drizzle/sqlite',
  dialect: 'sqlite',
  dbCredentials: {
    url: expandPath(process.env.AGOR_DB_PATH || 'file:~/.agor/agor.db'),
  },
});
```

**PostgreSQL Config**:

```typescript
// packages/core/drizzle.postgres.config.ts

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.postgres.ts',
  out: './drizzle/postgres',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://agor:secret@localhost:5432/agor',
  },
});
```

---

### Migration Generation Workflow

**Step 1: Edit both schema files**

```bash
# Edit SQLite schema
vim packages/core/src/db/schema.sqlite.ts

# Edit PostgreSQL schema (mirror changes)
vim packages/core/src/db/schema.postgres.ts
```

**Step 2: Generate migrations for both dialects**

```bash
# Generate SQLite migrations
pnpm drizzle-kit generate --config=drizzle.sqlite.config.ts

# Generate PostgreSQL migrations
pnpm drizzle-kit generate --config=drizzle.postgres.config.ts

# Or use convenience script
pnpm db:generate
```

**Package.json scripts**:

```json
{
  "scripts": {
    "db:generate": "pnpm db:generate:sqlite && pnpm db:generate:postgres",
    "db:generate:sqlite": "drizzle-kit generate --config=drizzle.sqlite.config.ts",
    "db:generate:postgres": "drizzle-kit generate --config=drizzle.postgres.config.ts"
  }
}
```

**Step 3: Review generated SQL**

```bash
# Review SQLite migrations
git diff drizzle/sqlite/

# Review PostgreSQL migrations
git diff drizzle/postgres/

# Example output:
# drizzle/sqlite/0011_add_thinking_support.sql
# ALTER TABLE `messages` ADD `thinking_content` text;

# drizzle/postgres/0011_add_thinking_support.sql
# ALTER TABLE messages ADD thinking_content TEXT;
```

**Step 4: Commit both migrations**

```bash
git add drizzle/sqlite/ drizzle/postgres/
git commit -m "Add thinking support to messages"
```

---

### Example: Generated Migrations

**Simple Column Addition**:

_After adding `thinking_content` column to both schemas:_

**drizzle/sqlite/0011_add_thinking.sql**:

```sql
ALTER TABLE `messages` ADD `thinking_content` text;
```

**drizzle/postgres/0011_add_thinking.sql**:

```sql
ALTER TABLE messages ADD thinking_content TEXT;
```

**Complex Schema Change** (ALTER COLUMN):

_After changing `ready_for_prompt` from nullable to NOT NULL:_

**drizzle/sqlite/0012_alter_ready_for_prompt.sql** (37+ lines):

```sql
PRAGMA foreign_keys=OFF;

CREATE TABLE `sessions_new` (
  `session_id` text(36) PRIMARY KEY NOT NULL,
  `created_at` integer NOT NULL,
  `status` text NOT NULL,
  `ready_for_prompt` integer DEFAULT 0 NOT NULL,
  -- ... all columns
);

INSERT INTO `sessions_new` SELECT * FROM `sessions`;
DROP TABLE `sessions`;
ALTER TABLE `sessions_new` RENAME TO `sessions`;

PRAGMA foreign_keys=ON;

CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);
-- ... recreate all indexes
```

**drizzle/postgres/0012_alter_ready_for_prompt.sql** (1 line):

```sql
ALTER TABLE sessions ALTER COLUMN ready_for_prompt SET NOT NULL;
```

**Why This Is Great**:

- ✅ Drizzle Kit handles SQLite table recreation automatically
- ✅ Drizzle Kit handles PostgreSQL simple ALTER TABLE automatically
- ✅ No custom migration builder needed
- ✅ No manual SQL writing
- ✅ All dialect quirks handled by battle-tested Drizzle code

---

## Decision Matrix

| Criteria               | Duplicate SQL  | Template SQL | TypeScript Builder | Drizzle Auto-Gen |
| ---------------------- | -------------- | ------------ | ------------------ | ---------------- |
| **DRY**                | ❌ 0%          | ✅ 100%      | ✅ 100%            | ⚠️ 90%\*         |
| **Type Safety**        | ❌ No          | ❌ No        | ✅ Yes             | ✅ Yes           |
| **Readability**        | ✅ High        | ⚠️ Medium    | ✅ High            | ✅ High          |
| **Maintenance**        | ❌ 2x effort   | ✅ 1x effort | ⚠️ Custom code     | ✅ Minimal       |
| **Tooling Complexity** | ✅ None        | ⚠️ Medium    | ⚠️ High            | ✅ None          |
| **Flexibility**        | ✅ Full        | ⚠️ Limited   | ✅ Full            | ✅ Full          |
| **Production Ready**   | ✅ Yes         | ✅ Yes       | ⚠️ Custom          | ✅ Yes           |
| **Review Ease**        | ❌ 2 files     | ✅ 1 file    | ✅ 1 file          | ✅ 2 generated   |
| **Debugging**          | ✅ Direct SQL  | ⚠️ Generated | ⚠️ Generated       | ✅ Direct SQL    |
| **No Manual SQL**      | ❌ 100% manual | ⚠️ Templates | ⚠️ Builder API     | ✅ Fully auto    |
| **Battle-Tested**      | ✅ Yes         | ⚠️ Custom    | ❌ Custom          | ✅ Drizzle team  |

\*Schema duplication (~200 lines per file), but migrations are 100% auto-generated

**Winner**: ✅ **Drizzle Auto-Generation** (battle-tested, zero manual SQL, minimal maintenance)

---

## Implementation Plan

### Phase 1: Create Dual Schema Files (2 days)

1. Create `schema.sqlite.ts` (copy from existing `schema.ts`)
2. Create `schema.postgres.ts` (translate to PostgreSQL types)
3. Create `schema-factory.ts` (optional shared column definitions)
4. Update `schema.ts` to re-export based on runtime dialect
5. Validate both schemas compile without errors

### Phase 2: Set Up Drizzle Configs (1 day)

1. Create `drizzle.sqlite.config.ts`
2. Create `drizzle.postgres.config.ts`
3. Move existing migrations to `drizzle/sqlite/`
4. Add package.json scripts (`db:generate`, `db:generate:sqlite`, `db:generate:postgres`)
5. Test migration generation for SQLite (should match existing)

### Phase 3: Generate Initial PostgreSQL Migrations (1 day)

1. Run `pnpm db:generate:postgres` to generate initial schema
2. Review generated PostgreSQL SQL
3. Validate against PostgreSQL test database
4. Commit both migration folders to git

### Phase 4: Update Migration Runner (1 day)

1. Update `migrate.ts` to read from dialect-specific folders
2. Add runtime dialect detection
3. Test migration runner with both SQLite and PostgreSQL
4. Validate existing SQLite migrations still work

---

## Open Questions

1. **Should we commit generated SQL files to git?**
   - **Answer**: Yes (Drizzle's recommended approach)
   - Both `drizzle/sqlite/` and `drizzle/postgres/` committed
   - Easier to review in PRs
   - No build step required for end users

2. **How to keep schemas in sync?**
   - **Recommendation**: Manual discipline + optional shared factory
   - CI could add linter to check column parity between schemas
   - Shared `schema-factory.ts` can help reduce copy-paste errors

3. **Should we support down migrations?**
   - **Answer**: Drizzle Kit doesn't generate down migrations
   - For now, rely on database backups for rollback
   - Future: could manually add down migrations if needed

4. **How to handle existing migrations (0000-0010)?**
   - **Answer**: Keep SQLite migrations as-is (already in `drizzle/` folder)
   - Move to `drizzle/sqlite/` folder
   - Generate equivalent PostgreSQL migrations from schema
   - Both sets of migrations committed to git

---

## Summary

**Recommendation**: Use **Drizzle Kit auto-generation with dual schemas**.

**Key Benefits**:

- ✅ Zero manual SQL writing (Drizzle generates everything)
- ✅ Battle-tested migration logic from Drizzle team
- ✅ Type-safe schema definitions
- ✅ Automatic handling of dialect quirks (PRAGMA, table recreation, etc.)
- ✅ Snapshot-based diffing (only generates changes)
- ✅ Production-ready (Drizzle is stable and widely used)

**Trade-offs**:

- ⚠️ Schema files duplicated (~200 lines per file)
- ⚠️ Must manually keep schemas in sync (or use shared factory)
- ⚠️ No automatic down migrations (rely on backups)

**Timeline**: 5 days total (down from 7 days with custom builder!)

**Net Savings**: 2 days + no custom migration builder to maintain

**Next Steps**:

1. Create `schema.sqlite.ts` and `schema.postgres.ts`
2. Set up dual Drizzle configs
3. Generate initial PostgreSQL migrations
4. Test migration runner with both dialects
5. Update developer documentation
