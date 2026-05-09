# How to Create Database Migrations

**Status:** ✅ Guide
**Related:** [[postgres-support]], [[architecture]]

---

## Overview

Agor uses **Drizzle ORM** for schema migrations against both SQLite and PostgreSQL. Schemas live in two parallel files; migrations are generated locally with `pnpm` and applied via `agor db migrate`. No Docker is required for the dev loop.

---

## The dual-schema pattern

Two schema files, kept in lockstep:

```
packages/core/src/db/
├── schema.sqlite.ts    # SQLite-specific schema
├── schema.postgres.ts  # PostgreSQL-specific schema
└── schema-factory.ts   # Runtime dialect detection helpers
                        # (getDatabaseDialect / detectDialectFromUrl).
                        # Type-helper factory pattern was abandoned —
                        # type helpers are inlined in each schema.
```

**Golden rule: when you modify one schema, you modify the other to match.**

Only **3 column types** legitimately differ between dialects:

| Concept | SQLite | Postgres |
|---|---|---|
| Timestamp | `integer` | `timestamp` |
| Boolean | `integer` | `boolean` |
| JSON | `text` | `jsonb` |

Everything else — table names, columns, indexes, foreign keys — should be identical.

---

## Workflow

```bash
# 1. Edit packages/core/src/db/schema.sqlite.ts AND schema.postgres.ts.

# 2. Generate migrations (host-side; drizzle-kit is in node_modules).
cd packages/core
pnpm db:generate:sqlite
pnpm db:generate:postgres

# 3. Review the generated SQL — drizzle usually gets it right but verify.
cat drizzle/sqlite/<NEW_FILE>.sql
cat drizzle/postgres/<NEW_FILE>.sql

# 4. Apply to your local dev database.
pnpm agor db migrate

# 5. (Optional) Test against a live agor-managed env.
#    The container's docker-entrypoint.sh runs `pnpm agor db migrate --yes`
#    on boot, so a worktree restart applies pending migrations automatically.

# 6. Commit schema files + new SQL + the meta/_journal.json updates.
git add packages/core/src/db/schema.{sqlite,postgres}.ts
git add packages/core/drizzle/sqlite/<NEW_FILE>.sql packages/core/drizzle/sqlite/meta/
git add packages/core/drizzle/postgres/<NEW_FILE>.sql packages/core/drizzle/postgres/meta/
```

If `drizzle-kit` prompts you to disambiguate a rename, answer in the terminal — those prompts only show up when the diff is genuinely ambiguous.

---

## Common scenarios

| Change | Drizzle output |
|---|---|
| Add column | `ALTER TABLE … ADD COLUMN` (both dialects) |
| Remove column | SQLite recreates the table (`__new_<table>` dance); Postgres `DROP COLUMN` |
| Change column type | SQLite recreates table; Postgres `ALTER COLUMN … TYPE` |
| Add index | `CREATE INDEX` (both dialects) |

For removals/type changes on tables with data, **review the recreation SQL carefully** — Drizzle does an `INSERT INTO __new_x SELECT … FROM x` which loses data if the column list doesn't match.

---

## Gotchas

### Journal `when` timestamps must be monotonically increasing

Drizzle determines pending migrations by comparing each journal entry's `when` against the max `created_at` in `__drizzle_migrations`. A migration is "pending" only if `when > maxAppliedMillis`.

**If you manually add or edit a journal entry with a `when` value earlier than an already-applied migration, it will be silently skipped** — never run, but classified as "already applied" by both the migrator and `checkMigrationStatus`.

When inserting manual or backfill migrations into `meta/_journal.json`, ensure the `when` value is **strictly greater** than every preceding entry. The sqlite and postgres journals are tracked independently — apply this rule to each one separately.

### Avoid `CHECK` constraints for enum-like columns on SQLite

Don't use `CHECK(col IN ('a', 'b', 'c'))` on a SQLite column. When a new value is added (e.g. extending `others_can` with `'session'`), the CHECK constraint forces a full table-recreation migration — SQLite can't alter constraints in place. This is error-prone and easy to forget when updating TypeScript enums.

Validate enum values at the application layer instead — Drizzle schema `enum` option, Zod, or service hooks. The TypeScript types are the source of truth; the DB just stores text.

### Schemas drifting

If you only update one schema, generation succeeds for that dialect and silently leaves the other one stale. Catch it before merge:

```bash
sqlite3 ~/.agor/agor.db ".schema <table>"
# vs the postgres equivalent if you have a Postgres dev DB
```

---

## Reference

```bash
# From packages/core:
pnpm db:generate:sqlite      # generate SQLite migration from schema diff
pnpm db:generate:postgres    # generate Postgres migration from schema diff
pnpm db:push                 # push schema directly (dev only — skips migrations)
pnpm db:studio               # open Drizzle Studio

# From repo root:
pnpm agor db status          # show pending migrations
pnpm agor db migrate         # apply pending migrations to local DB
```

**File locations:**

- Schemas: `packages/core/src/db/schema.{sqlite,postgres}.ts`
- Migrations: `packages/core/drizzle/{sqlite,postgres}/*.sql` + `meta/_journal.json`
- Configs: `packages/core/drizzle.{sqlite,postgres}.config.ts`
- Migrate runtime: `packages/core/src/db/migrate.ts`
- Auto-apply on container boot: `docker/docker-entrypoint.sh` (calls `pnpm agor db migrate --yes`)

**External:** [Drizzle migrations docs](https://orm.drizzle.team/docs/migrations).
