# ID Management

**Category:** Core Concept
**Status:** Canonical Design (January 2025)

Related: [[models]], [[architecture]], [[state-management]], [[cli]]

---

## Overview

Agor uses **UUIDv7** as the universal identifier format across all entities (Session, Task, Board, Concept, Report). This provides globally unique, time-ordered IDs suitable for distributed systems while maintaining excellent database indexing performance.

**Key Insight:** Store full UUIDs (36 characters) in the database for uniqueness guarantees, but expose **short IDs** (8-character prefixes) to users for convenience, with git-style collision resolution.

---

## Why UUIDv7?

### The Evolution of UUIDs

**UUIDv4 (Random):**

- ✅ Globally unique, cryptographically random
- ❌ No temporal ordering (bad for indexes)
- ❌ Random distribution causes B-tree fragmentation
- ❌ Poor cache locality for range queries

**UUIDv7 (Time-Ordered):**

- ✅ Globally unique with temporal ordering
- ✅ First 48 bits = Unix timestamp (ms precision)
- ✅ Sequential IDs improve B-tree performance
- ✅ Sortable by creation time (no separate `created_at` needed)
- ✅ Standardized in RFC 9562 (August 2024)

**Comparison with Alternatives:**

| Format | Length | Sortable | Random | Human-Friendly | DB Performance |
| ------ | ------ | -------- | ------ | -------------- | -------------- |
| UUIDv4 | 36     | ❌       | ✅     | ❌             | Poor           |
| UUIDv7 | 36     | ✅       | ✅     | ❌             | Excellent      |
| ULID   | 26     | ✅       | ✅     | ✅ (base32)    | Excellent      |
| CUID2  | 24     | ✅       | ✅     | ❌             | Good           |
| KSUID  | 27     | ✅       | ✅     | ❌             | Excellent      |

**Why not ULID/CUID2/KSUID?**

- UUIDv7 is an **IETF standard** (RFC 9562), ensuring long-term support
- Ecosystem compatibility (PostgreSQL, MySQL have native UUID types)
- Migration path to cloud databases easier with standards
- TypeScript ecosystem has mature UUIDv7 libraries (`uuidv7` npm package)

---

## Short ID Strategy

### Git-Style Short IDs

Inspired by git's abbreviated commit SHAs:

**Full UUID (stored):**

```
01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f
```

**Short ID (displayed):**

```
01933e4a  (first 8 characters)
```

**Usage:**

```bash
# CLI accepts short IDs
agor session resume 01933e4a

# UI displays short IDs
Session 01933e4a: "Add authentication middleware"

# Full ID shown in detailed views
agor session show 01933e4a --verbose
```

### Collision Probability

**8 hexadecimal characters = 4.3 billion possibilities (16^8)**

| Total IDs | Collision Probability  |
| --------- | ---------------------- |
| 1,000     | 0.01%                  |
| 10,000    | 1.16%                  |
| 65,536    | 50% (birthday paradox) |
| 100,000   | 77%                    |

**Practical Reality:**

- Most Agor instances will have < 10,000 total entities
- Collisions are rare in practice
- When collisions occur, use git-style resolution (expand to 12/16 chars)

### Collision Resolution Algorithm

**When a short ID matches multiple entities:**

```typescript
function resolveShortId(prefix: string, entities: Entity[]): Entity | Error {
  const matches = entities.filter(e => e.id.startsWith(prefix));

  if (matches.length === 0) {
    return new Error(`No entity found with ID prefix: ${prefix}`);
  }

  if (matches.length === 1) {
    return matches[0];
  }

  // Collision: show all matches with longer prefixes
  return new Error(`Ambiguous ID prefix: ${prefix}

  Multiple matches found:
  - ${shortId(matches[0].id, 12)}: ${matches[0].description}
  - ${shortId(matches[1].id, 12)}: ${matches[1].description}

  Use a longer prefix to disambiguate.`);
}
```

**CLI Error Example:**

```bash
$ agor session resume 0193

✗ Error: Ambiguous ID prefix: 0193

  Multiple matches found:
  - 01933e4a7b89: "Add authentication middleware"
  - 0193416c2d4f: "Add auth tests"

  Use a longer prefix to disambiguate:
    agor session resume 01933e4a
```

---

## Database Schema

### Primary Keys

All entities use TEXT primary keys with UUIDv7 values:

```typescript
// Drizzle ORM schema example
import { text, sqliteTable } from 'drizzle-orm/sqlite-core';
import { generateId } from '../lib/ids';

export const sessions = sqliteTable('sessions', {
  session_id: text('session_id', { length: 36 })
    .primaryKey()
    .$defaultFn(() => generateId()),

  agent: text('agent', { length: 20 }).notNull(),
  status: text('status', { length: 20 }).notNull(),
  // ... other fields
});
```

### Indexing Strategy

**Primary Key Index (Automatic):**

```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,  -- Automatically indexed
  -- ...
);
```

**Short ID Prefix Queries:**

SQLite's B-tree index supports efficient prefix matching:

```sql
-- Fast: Uses primary key index with prefix scan
SELECT * FROM sessions
WHERE session_id LIKE '01933e4a%';

-- Even faster: Explicit range query
SELECT * FROM sessions
WHERE session_id >= '01933e4a'
  AND session_id < '01933e4b';
```

**Performance Characteristics:**

- Prefix match on indexed TEXT: O(log n) seek + O(m) scan (m = matches)
- 8-char prefix reduces search space to ~1-10 candidates typically
- No additional indexes needed for short ID resolution

### Foreign Keys

All relationships use full UUIDs (not short IDs):

```typescript
export const tasks = sqliteTable('tasks', {
  task_id: text('task_id', { length: 36 })
    .primaryKey()
    .$defaultFn(() => generateId()),

  session_id: text('session_id', { length: 36 })
    .notNull()
    .references(() => sessions.session_id), // Full UUID

  // ...
});
```

**Why not integer auto-increment?**

- UUIDs enable distributed ID generation (no central counter)
- Easier migration to cloud/sync (no ID conflicts)
- Public IDs don't leak information (unlike sequential IDs)
- No need for separate `public_id` field

---

## TypeScript Types

### Core Types

```typescript
// Base types
export type UUID = string & { readonly brand: unique symbol };
export type ShortID = string; // 8-16 characters
export type IDPrefix = string; // Any length prefix

// Entity IDs (aliased for clarity)
export type SessionID = UUID;
export type TaskID = UUID;
export type BoardID = UUID;
export type ConceptID = UUID;
export type ReportID = UUID;

// Validation
export function isValidUUID(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function isValidShortID(value: string): value is ShortID {
  return /^[0-9a-f]{8,16}$/.test(value);
}
```

### Updated Entity Interfaces

All `*_id` fields are typed as `UUID`:

```typescript
// session.ts
export interface Session {
  session_id: UUID;
  // ...
  genealogy: {
    forked_from_session_id?: UUID;
    fork_point_task_id?: UUID;
    parent_session_id?: UUID;
    spawn_point_task_id?: UUID;
    children: UUID[];
  };
  tasks: UUID[];
}

// task.ts
export interface Task {
  task_id: UUID;
  session_id: UUID;
  // ...
}

// board.ts
export interface Board {
  board_id: UUID;
  sessions: UUID[];
  // ...
}
```

---

## ID Generation

### Implementation

Use the `uuidv7` npm package (LiosK/uuidv7):

```typescript
// src/lib/ids.ts
import { uuidv7 } from 'uuidv7';

/**
 * Generate a new UUIDv7 identifier.
 *
 * Format: 01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f
 *
 * - First 48 bits: Unix timestamp (ms)
 * - Next 12 bits: Random sequence
 * - Last 62 bits: Random data
 */
export function generateId(): UUID {
  return uuidv7() as UUID;
}

/**
 * Extract short ID prefix from UUID.
 *
 * @param uuid - Full UUID
 * @param length - Prefix length (default: 8, max: 32)
 * @returns Short ID without hyphens
 */
export function shortId(uuid: UUID, length: number = 8): ShortID {
  return uuid.replace(/-/g, '').slice(0, length);
}

/**
 * Expand short ID to full UUID pattern for DB queries.
 *
 * @param prefix - Short ID prefix (8-32 chars, no hyphens)
 * @returns SQL LIKE pattern
 */
export function expandPrefix(prefix: IDPrefix): string {
  // "01933e4a" -> "01933e4a-____-____-____-____________"
  const clean = prefix.replace(/-/g, '');

  if (clean.length >= 32) {
    // Full UUID without hyphens, reformat
    return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20, 32)}`;
  }

  // Partial prefix, use LIKE pattern
  let formatted = clean;
  if (clean.length > 8) formatted = `${clean.slice(0, 8)}-${clean.slice(8)}`;
  if (clean.length > 12) formatted = `${formatted.slice(0, 13)}-${clean.slice(12)}`;
  // ... continue formatting if longer

  return `${formatted}%`;
}

/**
 * Resolve a short ID to a full entity.
 * Throws error if not found or ambiguous.
 */
export function resolveShortId<T extends { id: UUID }>(prefix: IDPrefix, entities: T[]): T {
  const pattern = expandPrefix(prefix);
  const matches = entities.filter(e => e.id.startsWith(pattern.replace('%', '')));

  if (matches.length === 0) {
    throw new Error(`No entity found with ID prefix: ${prefix}`);
  }

  if (matches.length > 1) {
    const suggestions = matches
      .map(m => `  - ${shortId(m.id, 12)}: ${(m as any).description || '(no description)'}`)
      .join('\n');

    throw new Error(
      `Ambiguous ID prefix: ${prefix}\n\n` +
        `Multiple matches found:\n${suggestions}\n\n` +
        `Use a longer prefix to disambiguate.`
    );
  }

  return matches[0];
}
```

### Usage in Application Code

```typescript
// Creating entities
const session: Session = {
  session_id: generateId(),
  agent: 'claude-code',
  status: 'idle',
  created_at: new Date().toISOString(),
  // ...
};

// Displaying in UI
console.log(`Session ${shortId(session.session_id)}: ${session.description}`);
// Output: Session 01933e4a: Add authentication middleware

// CLI resolution
const userInput = '01933e4a';
const session = resolveShortId(userInput, allSessions);
console.log(`Resuming session: ${session.description}`);
```

---

## Display Patterns

### CLI Tables

**Session List:**

```
┌──────────┬─────────────────────────────────┬──────────────┬───────────┐
│ ID       │ Description                     │ Agent        │ Status    │
├──────────┼─────────────────────────────────┼──────────────┼───────────┤
│ 01933e4a │ Add authentication middleware   │ claude-code  │ ● Running │
│ 01934c2d │ Fix CORS configuration          │ cursor       │ ✓ Done    │
│ 019351ab │ Implement caching layer         │ codex        │ ○ Idle    │
└──────────┴─────────────────────────────────┴──────────────┴───────────┘
```

**Task Timeline:**

```
┌────┬──────────┬────────────────────────────────┬───────────┐
│ #  │ Task ID  │ Prompt                         │ Status    │
├────┼──────────┼────────────────────────────────┼───────────┤
│ 1  │ 0193a1b2 │ Setup auth middleware          │ ✓ Done    │
│ 2  │ 0193a3c4 │ Implement JWT validation       │ ✓ Done    │
│ 3  │ 0193a5d6 │ Add refresh token logic        │ ● Running │
└────┴──────────┴────────────────────────────────┴───────────┘
```

### UI Components

**React Component Example:**

```typescript
import { shortId } from '@/lib/ids';

function SessionCard({ session }: { session: Session }) {
  return (
    <Card>
      <Text type="secondary">Session {shortId(session.session_id)}</Text>
      <Title level={4}>{session.description}</Title>
      {/* ... */}
    </Card>
  );
}
```

**Tooltips (show full UUID on hover):**

```tsx
<Tooltip title={session.session_id}>
  <Text copyable>{shortId(session.session_id)}</Text>
</Tooltip>
```

---

## Migration Strategy

### Phase 1: Current Prototype (In-Memory Mocks)

- Mock data uses string IDs (placeholders)
- Update mocks to use UUIDv7 format
- Add `generateId()` to mock generators

### Phase 2: Local Database (LibSQL)

- Drizzle schema with TEXT primary keys
- `$defaultFn(() => generateId())` for all `*_id` columns
- No migrations needed (fresh schema)

### Phase 3: Cloud Sync (V2)

- UUIDs prevent ID conflicts across devices
- Time-ordering from UUIDv7 helps conflict resolution
- No schema changes needed (same ID format)

### Phase 4: Multi-Tenant (Future)

- UUIDs remain globally unique across tenants
- Optional: Add `workspace_id` prefix for logical isolation
- Still use full UUIDs internally

---

## Best Practices

### DO:

✅ Store full UUIDs (36 chars) in database
✅ Display short IDs (8 chars) in UI/CLI by default
✅ Accept both short and full IDs in CLI commands
✅ Show full UUID in detailed views (`--verbose`)
✅ Use `LIKE 'prefix%'` for efficient prefix queries
✅ Handle collisions gracefully (show all matches)

### DON'T:

❌ Store short IDs in database (defeats uniqueness)
❌ Use auto-increment integers for public IDs
❌ Generate UUIDs client-side without monotonic guarantees
❌ Assume 8-char prefix is always unique (check!)
❌ Display full UUIDs in compact tables (too verbose)
❌ Use UUIDv4 for new code (v7 is better for DBs)

---

## Performance Considerations

### Database Query Performance

**Primary Key Lookup (exact match):**

```sql
SELECT * FROM sessions WHERE session_id = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f';
-- O(log n) - B-tree lookup
```

**Short ID Resolution (prefix match):**

```sql
SELECT * FROM sessions WHERE session_id LIKE '01933e4a%';
-- O(log n) seek + O(m) scan where m = matches (typically 1-10)
```

**Range Query (chronological order):**

```sql
SELECT * FROM sessions
WHERE created_at > '2025-01-01'
ORDER BY session_id ASC;
-- UUIDv7 time-ordering makes this efficient (no extra index needed)
```

### Storage Overhead

**UUIDv7 vs Integer:**

- UUIDv7: 36 bytes (TEXT) or 16 bytes (BLOB)
- Integer: 4-8 bytes

**Trade-offs:**

- 2-4x storage overhead
- But: No need for separate `public_id` column
- But: Global uniqueness enables distributed systems
- Result: Worth it for flexibility

### Indexing Recommendations

**Always indexed:**

- Primary keys (`session_id`, `task_id`, etc.)

**Should be indexed:**

- Foreign keys (`session_id` in tasks table)
- Frequently filtered columns (`status`, `agent`, `board_id`)

**No need to index:**

- Short ID prefixes (use primary key index with `LIKE`)

---

## Testing Strategy

### Unit Tests

```typescript
describe('ID utilities', () => {
  test('generateId creates valid UUIDv7', () => {
    const id = generateId();
    expect(isValidUUID(id)).toBe(true);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  test('shortId extracts prefix', () => {
    const uuid = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f';
    expect(shortId(uuid)).toBe('01933e4a');
    expect(shortId(uuid, 12)).toBe('01933e4a7b89');
  });

  test('resolveShortId finds unique match', () => {
    const entities = [
      { id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f', name: 'A' },
      { id: '01934c2d-1234-7c35-a8f3-9d2e1c4b5a6f', name: 'B' },
    ];

    const match = resolveShortId('01933e4a', entities);
    expect(match.name).toBe('A');
  });

  test('resolveShortId throws on collision', () => {
    const entities = [
      { id: '01933e4a-7b89-7c35-a8f3-111111111111', name: 'A' },
      { id: '01933e4a-7b89-7c35-a8f3-222222222222', name: 'B' },
    ];

    expect(() => resolveShortId('01933e4a', entities)).toThrow('Ambiguous ID prefix');
  });
});
```

### Integration Tests

```typescript
describe('Database ID queries', () => {
  test('prefix match finds session', async () => {
    const session = await db
      .insert(sessions)
      .values({
        session_id: generateId(),
        agent: 'claude-code',
        status: 'idle',
      })
      .returning();

    const prefix = shortId(session.session_id);
    const found = await db
      .select()
      .from(sessions)
      .where(sql`session_id LIKE ${prefix}%`)
      .get();

    expect(found).toBeDefined();
    expect(found.session_id).toBe(session.session_id);
  });
});
```

---

## References

**Standards:**

- RFC 9562: Universally Unique IDentifiers (UUIDs) - https://www.rfc-editor.org/rfc/rfc9562.html
- UUIDv7 Specification: https://www.ietf.org/archive/id/draft-peabody-dispatch-new-uuid-format-04.html

**Libraries:**

- `uuidv7` npm package: https://www.npmjs.com/package/uuidv7
- Drizzle ORM UUID docs: https://orm.drizzle.team/docs/column-types/sqlite

**Related Agor Docs:**

- `context/concepts/models.md` - Entity data models
- `context/concepts/architecture.md` - System architecture
- `context/explorations/state-management.md` - Database layer with Drizzle
- `context/explorations/cli.md` - CLI short ID usage patterns
