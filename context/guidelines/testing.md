# Testing Guidelines

**Vitest with co-located test files.**

---

## Philosophy

**Write straightforward, useful unit tests. Avoid zealous testing and overfitting.**

- ✅ Test behavior and contracts, not implementation details
- ✅ Focus on what matters: edge cases, error handling, business logic
- ❌ Don't test trivial code or third-party libraries
- ❌ Don't write tests just to hit coverage numbers

**Tests are bug-finding tools:**

- If you encounter a bug in source code while testing, **fix the source code**
- Don't align tests with bugs - that defeats the purpose
- Report bugs you find and fix in your test summary

**Tests are type-checking opportunities:**

- Review type validity as you test
- If types are missing, improper, or could be improved: fix or report back
- Types should accurately represent runtime behavior

**Large files are code smells:**

- If a file is excessively large (>500 LOC), propose refactoring before testing
- Break down into smaller, focused modules
- Testing reveals architectural issues - address them

---

## Core Rule

**Place `{file}.test.ts` as sibling to source file:**

```
✅ packages/core/src/lib/ids.ts
✅ packages/core/src/lib/ids.test.ts

❌ packages/core/src/__tests__/lib/ids.test.ts
```

---

## Priority Order

Test stable code first:

1. **Core utilities** (`lib/ids.ts`, `utils/pricing.ts`) → 100% coverage target
2. **Config/Git** (`config-manager.ts`, `git/index.ts`) → 90-95%
3. **Database repos** → 85%
4. **Services** → 80%
5. **React components** → 70%

---

## Quick Examples

**Pure function:**

```typescript
// lib/ids.test.ts
import { generateId } from './ids';

describe('generateId', () => {
  it('should generate unique UUIDs', () => {
    expect(generateId()).not.toBe(generateId());
  });
});
```

**React component (use RTL):**

```typescript
// components/TaskListItem.test.tsx
import { render, screen } from '@testing-library/react';
import { TaskListItem } from './TaskListItem';

it('should render task content', () => {
  render(<TaskListItem task={{ id: '1', content: 'Test' }} />);
  expect(screen.getByText('Test')).toBeInTheDocument();
});
```

**Database repo (use dbTest fixture):**

```typescript
// db/repositories/repos.test.ts
import { dbTest } from '../test-helpers';
import { RepoRepository } from './repos';

dbTest('should create repo', async ({ db }) => {
  const repo = new RepoRepository(db);
  const created = await repo.create({ path: '/test', name: 'test' });
  expect(created.id).toBeDefined();
});
```

---

## Fixtures & Test Data

**Prefer inline data (default):**

```typescript
it('should create session', () => {
  const session = { id: generateId(), title: 'Test' };
});
```

**Keep things DRY within your test file:**

Use inline helper functions to avoid repetition:

```typescript
// repos.test.ts - helper used only in this file
function createRepoData(overrides?: Partial<Repo>): Repo {
  return { id: generateId(), slug: 'org/repo', ...overrides };
}

dbTest('should create repo', async ({ db }) => {
  const data = createRepoData({ slug: 'custom' });
});

dbTest('should update repo', async ({ db }) => {
  const data = createRepoData(); // DRY - reuse helper
});
```

**Database tests use shared `dbTest` fixture:**

```typescript
// Each test gets fresh isolated DB automatically
// See: packages/core/src/db/test-helpers.ts

import { dbTest } from '../test-helpers';

dbTest('should create repo', async ({ db }) => {
  // db is ready with full schema, isolated per test
  const repo = new RepoRepository(db);
  // test code
});
```

**For utilities shared ACROSS test files, add to test-helpers.ts:**

Only add to `db/test-helpers.ts` if multiple test files need it:

```typescript
// db/test-helpers.ts - ONLY if used by multiple test files

// Example: Seeded DB fixture used by integration tests
export const seededDbTest = test.extend({
  db: async ({}, use) => {
    const db = createDatabase({ url: ':memory:' });
    await initializeDatabase(db);
    // Seed common data needed by many tests
    await new RepoRepository(db).create({ slug: 'test/repo', ... });
    await use(db);
  },
});

// Example: Common assertion helper used across many test files
export function assertValidTimestamp(ts: string) {
  expect(new Date(ts).getTime()).toBeGreaterThan(0);
}
```

**Don't add single-use helpers to test-helpers.ts** - keep them inline!

---

## Anti-Patterns (Avoid Zealous Testing)

**❌ Don't test each field separately:**

```typescript
// BAD - Testing Drizzle ORM's JSON serialization
dbTest('should handle permission_config', ...)
dbTest('should handle model_config', ...)
dbTest('should handle contextFiles array', ...)
```

**✅ Test all fields comprehensively:**

```typescript
// GOOD - Test behavior once, with all fields
dbTest('should store all optional JSON fields correctly', async ({ db }) => {
  const data = createData({
    permission_config: { ... },
    model_config: { ... },
    contextFiles: [...],
  });

  const created = await repo.create(data);
  expect(created).toMatchObject(data);
});
```

**❌ Don't test third-party library behavior:**

```typescript
// BAD - Testing SQLite, not our code
dbTest('should handle empty strings', ...)
dbTest('should handle special characters', ...)
dbTest('should handle negative numbers', ...)
```

**✅ Test your repository logic:**

```typescript
// GOOD - Tests our business logic
dbTest('should order messages by index', ...)
dbTest('should filter by session and exclude others', ...)
dbTest('should resolve short IDs with collision handling', ...)
```

**Test-to-Source Ratio Guidelines:**

- Simple CRUD: 1-2x
- Complex logic: 2-3x
- **>4x is a code smell** - refactor tests

---

## Type Safety in Tests (Critical)

**Always check types after writing/modifying tests!**

Run `pnpm typecheck` before committing. Your tests must pass TypeScript checking - they are code too.

**❌ Don't use loose mocks:**

```typescript
// BAD - Loose typing defeats the purpose of branded types
const mockRepo = {
  create: vi.fn(),
  patch: vi.fn(),
} as any; // ❌ Never use `as any`

// Then passing it and TypeScript has no idea what it should be
someFunction(mockRepo); // Could be completely wrong type
```

**✅ Use proper mock typing:**

```typescript
// GOOD - Typed mocks with vi.fn<T>()
const mockRepo = {
  create: vi.fn<[CreateInput], Promise<Entity>>(),
  patch: vi.fn<[UUID, UpdateInput], Promise<Entity>>(),
} as unknown as Repository; // ✅ Explicit type assertion

// BETTER - Create helper for typed mocks
function createMockRepository(): Repository {
  return {
    create: vi.fn(),
    patch: vi.fn(),
    // ... other methods
  };
}
```

**Branded types in test data:**

```typescript
// BAD - String won't work for UUID branded type
const task = { id: 'abc123', ...rest }; // ❌ Type error

// GOOD - Use `as UUID` or generate with proper function
import { generateId } from '../../lib/ids';
const task = { id: generateId(), ...rest }; // ✅ Proper UUID

// OR - Type assertion for test data
const task = { id: 'abc123' as UUID, ...rest }; // ✅ Explicit
```

**Date vs ISO string:**

```typescript
// BAD - Type mismatch
const data = { created_at: new Date() }; // ❌ Type expects ISO string

// GOOD - Use ISO strings in test data
const data = { created_at: new Date().toISOString() }; // ✅ Correct type
```

**Checklist after writing tests:**

- [ ] Run `pnpm test` - all tests pass
- [ ] Run `pnpm typecheck` - no type errors
- [ ] Mocks use proper types (not `as any`)
- [ ] Test data matches expected types (UUID, ISO strings, etc.)
- [ ] No `@ts-ignore` comments (fix the type instead)

---

## Build Exclusion

**Test files are automatically excluded from builds:**

- Core package: Uses explicit entry points (tests not included)
- Daemon: `ignore: ['**/*.test.ts', '**/*.spec.ts']` in tsup.config.ts
- UI: Configure similar pattern if using glob-based builds

---

## Run Tests

```bash
pnpm test              # Run all
pnpm test:watch        # Watch mode
pnpm test -- --coverage
```
