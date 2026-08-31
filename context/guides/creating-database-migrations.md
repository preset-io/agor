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

| Concept   | SQLite    | Postgres    |
| --------- | --------- | ----------- |
| Timestamp | `integer` | `timestamp` |
| Boolean   | `integer` | `boolean`   |
| JSON      | `text`    | `jsonb`     |

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
#    on boot, so a branch restart applies ordinary pending migrations automatically.
#    Purpose-marked offline cutovers still require an explicit maintenance run.

# 6. Commit schema files + new SQL + the meta/_journal.json updates.
git add packages/core/src/db/schema.{sqlite,postgres}.ts
git add packages/core/drizzle/sqlite/<NEW_FILE>.sql packages/core/drizzle/sqlite/meta/
git add packages/core/drizzle/postgres/<NEW_FILE>.sql packages/core/drizzle/postgres/meta/
```

If `drizzle-kit` prompts you to disambiguate a rename, answer in the terminal — those prompts only show up when the diff is genuinely ambiguous.

---

## Common scenarios

| Change             | Drizzle output                                                             |
| ------------------ | -------------------------------------------------------------------------- |
| Add column         | `ALTER TABLE … ADD COLUMN` (both dialects)                                 |
| Remove column      | SQLite recreates the table (`__new_<table>` dance); Postgres `DROP COLUMN` |
| Change column type | SQLite recreates table; Postgres `ALTER COLUMN … TYPE`                     |
| Add index          | `CREATE INDEX` (both dialects)                                             |

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

### New tenant-table FKs must be made `DEFERRABLE INITIALLY IMMEDIATE` (Postgres)

`agor tenant import` restores a whole tenant inside one transaction with
`SET CONSTRAINTS ALL DEFERRED`, which only works on constraints _declared_
deferrable. Migration `0070_tenant_portability_deferrable_fks` marked every
existing FK between tenant-manifest tables `DEFERRABLE INITIALLY IMMEDIATE`
(behaviorally identical for normal transactions — checks still run per
statement unless a transaction explicitly defers them).

Drizzle generates FKs **non-deferrable** by default, so when you add a
tenant-owned table (or a new FK between existing tenant tables), ship a small
companion Postgres migration:

```sql
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "my_table" ALTER CONSTRAINT "my_table_branch_id_branches_branch_id_fk" DEFERRABLE INITIALLY IMMEDIATE;
```

If you forget, the integration test
`packages/core/src/db/tenant-portability.postgres.test.ts`
("keeps exactly every manifest-to-manifest FK deferrable and initially
immediate") fails — it pins the exact deferrable set against `pg_constraint`
in both directions, so stray deferrable FKs outside the manifest also fail.

### Bound lock waits when ALTERing existing tables (Postgres)

`ALTER TABLE … ALTER CONSTRAINT` (and most other ALTERs) need an
ACCESS EXCLUSIVE lock. Two things make an unbounded wait dangerous on a live
database:

1. While the ALTER waits for its lock, **every new query on that table queues
   behind it** — even SELECTs — so a wait is a traffic stall, not a quiet delay.
2. The migrator runs all pending migrations in **one transaction**, and
   Postgres holds every acquired lock until commit. A multi-table migration
   that stalls on table N is still holding exclusive locks on tables 1…N-1.

For any migration touching multiple existing tables, start it with
`SET LOCAL lock_timeout = '3s';` (see `0070_tenant_portability_deferrable_fks.sql`
for the pattern and full rationale). On an idle DB the timeout never triggers;
on a busy one the migration fails fast with `55P03` and rolls back atomically —
always safe to retry — instead of freezing the app. `SET LOCAL` scopes the
setting to the migration transaction, so it never leaks onto pooled connections.

The corollary for operators: migrations that ALTER existing tables should run
with the daemon **stopped** (`systemctl stop` → `agor db migrate` → `start`);
live daemon connections hold shared locks that will trip the timeout.

### Protocol-breaking migrations require an enforced offline cutover

If old and new workers cannot safely share the additive schema, register the
migration in the impact registry in `src/db/migrate.ts` with
`requiresOfflineCutover: true`. Existing
databases then refuse automatic migration until an operator stops every daemon
and runs `agor db migrate --offline-cutover`. The registry may cover either or
both dialects; a protocol-breaking SQLite migration still needs acknowledgement
on an existing database even though it has no HA cohort. Fresh databases may
still migrate automatically because no old worker can exist. Document the exact
stop → migrate → start order in the user guide; the acknowledgement flag cannot
itself prove that another host has stopped.

Agor-managed standalone development variants are isolated by Compose project
and explicitly set `AGOR_MIGRATION_OFFLINE_CUTOVER=true`. The development
entrypoint translates that acknowledgement to `--offline-cutover`; arbitrary
unseeded Compose invocations default it to false. For already-rendered managed
environment commands, `SEED=true` is the development-only compatibility signal;
those Compose projects own isolated database volumes. HA keeps using its
dedicated one-shot migrator before either daemon replica starts. Never set this
variable or `SEED=true` merely to make a shared or production database boot.

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
pnpm agor db status --json   # emit the versioned automation contract
pnpm agor db migrate         # apply pending migrations to local DB
```

`db status --json` writes exactly one JSON document to stdout. Version 1 reports
the database `dialect` (`sqlite` or `postgresql`), `appliedMigrations`, structured
`pendingMigrations`, the aggregate
`requiresOfflineCutover` decision, and `databaseAheadOfBinary`. Each pending
migration includes the runtime-owned `requiresOfflineCutover` decision and a
bounded `impact` object (`classification`, `userAction`,
`rollbackCompatibility`, and `summary`). Missing impact metadata is represented
conservatively with explicit `unknown` values; callers must not infer impact by
parsing migration names, SQL, or human-readable command output.

**File locations:**

- Schemas: `packages/core/src/db/schema.{sqlite,postgres}.ts`
- Migrations: `packages/core/drizzle/{sqlite,postgres}/*.sql` + `meta/_journal.json`
- Configs: `packages/core/drizzle.{sqlite,postgres}.config.ts`
- Migrate runtime: `packages/core/src/db/migrate.ts`
- Auto-apply on container boot: `docker/docker-entrypoint.sh` (calls `pnpm agor db migrate --yes`)

**External:** [Drizzle migrations docs](https://orm.drizzle.team/docs/migrations).
