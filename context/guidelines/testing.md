# Testing Guidelines

Use Vitest. Put each `{file}.test.ts` next to its source file, not in `__tests__/`.

- Test behavior and contracts. Skip tests of Drizzle/SQLite/library behavior, tests that
  check JSON columns one field at a time, and tests written for coverage numbers.
- If a test exposes a source bug, fix the source and report it. Don't write the test to
  match the bug.
- Tests must pass `pnpm typecheck`. Don't use `as any` mocks or `@ts-ignore`. Use
  `generateId()` or explicit `as UUID` for branded IDs, and ISO strings for timestamps.
- DB repository tests use the `dbTest` / `ownedDbTest` fixtures from
  `packages/core/src/db/test-helpers.ts`, which give each test a fresh, fully migrated database.
  Add a helper there only when more than one test file needs it.

## PostgreSQL integration suites

PostgreSQL-only tests must be named `*.postgres.test.ts`. The runner fails if
`AGOR_TEST_POSTGRES_URL` appears in a test with any other name, if it finds no suites, or if
every selected test skips.

```bash
pnpm test:postgres:docker   # disposable pgvector container, same image as CI
```

To use an existing disposable database instead:

```bash
AGOR_DB_DIALECT=postgresql \
AGOR_TEST_POSTGRES_URL='postgresql://agor_app:<pw>@127.0.0.1:5432/agor' \
AGOR_TEST_POSTGRES_ADMIN_URL='postgresql://<bootstrap-user>:<pw>@127.0.0.1:5432/agor' \
pnpm test:postgres:integration
```

The admin URL only creates and drops the per-file databases and installs pgvector.
Migrations, queries, and RLS assertions run as the `NOSUPERUSER`/`NOBYPASSRLS` application
role, so RLS is actually enforced. `AGOR_POSTGRES_TEST_CONCURRENCY=1..8` sets file
concurrency; the default is 3.
