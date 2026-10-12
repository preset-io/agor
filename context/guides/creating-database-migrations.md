# Creating Database Migrations

Drizzle maintains two schemas that must change together:
`packages/core/src/db/schema.sqlite.ts` and `schema.postgres.ts`. If you edit only one,
generation still succeeds and the other dialect silently goes stale. Only three column
types should differ between them:

| Concept   | SQLite    | Postgres    |
| --------- | --------- | ----------- |
| Timestamp | `integer` | `timestamp` |
| Boolean   | `integer` | `boolean`   |
| JSON      | `text`    | `jsonb`     |

## Workflow

```bash
cd packages/core
pnpm db:generate:sqlite && pnpm db:generate:postgres   # or: pnpm db:generate
# review drizzle/{sqlite,postgres}/<new>.sql, then from repo root:
pnpm agor db migrate          # db status [--json] shows pending
```

Commit the schema files, the new SQL, and `drizzle/{sqlite,postgres}/meta/`. Container boot
(`docker/docker-entrypoint.sh`) runs `agor db migrate --yes`. Runtime and the impact
registry live in `packages/core/src/db/migrate.ts`.

When SQLite drops a column or changes its type, it rebuilds the table with
`INSERT INTO __new_x SELECT … FROM x`. Check the column list, because a mismatch loses data.

## Dialect-portable queries

Repositories go through `packages/core/src/db/database-wrapper.ts`, not raw Drizzle
terminals, because SQLite uses `.get()/.all()/.run()` and Postgres awaits the query.
`select(db)`, `insert(db, t)`, `update(db, t)`, and `deleteFrom(db, t)` add `.one()`
(`T | null`), `.all()`, `.run()`, and `.returning().one()/.all()`. The wrapper also holds the
dialect helpers: `runDatabaseTransaction`, `jsonExtract`, `dateTruncUtc`, `executeRaw`, and
`lockRowForUpdate`. Use those instead of branching on `isSQLiteDatabase()`.

## Gotchas

### Journal `when` must strictly increase

Drizzle treats a migration as pending only if its `when` is greater than the newest applied
`created_at`. A manually added or edited journal entry with an earlier `when` is silently
skipped, and both the migrator and `checkMigrationStatus` report it as applied. Check this
separately for the sqlite and postgres journals.

### No `CHECK(col IN (...))` enums on SQLite

SQLite can't alter constraints, so adding a value forces a full table rebuild. Validate enums
in the application layer.

### New tenant-table FKs: `DEFERRABLE INITIALLY IMMEDIATE` (Postgres)

`agor tenant import` restores a tenant in one transaction with `SET CONSTRAINTS ALL DEFERRED`,
which only works on deferrable constraints. Drizzle generates non-deferrable FKs, so a new
tenant-owned table, or a new FK between tenant tables, needs a companion Postgres migration:

```sql
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "my_table" ALTER CONSTRAINT "my_table_branch_id_branches_branch_id_fk" DEFERRABLE INITIALLY IMMEDIATE;
```

`packages/core/src/db/tenant-portability.postgres.test.ts` pins the exact deferrable set in
both directions.

### Bound lock waits when altering existing tables (Postgres)

While an ALTER waits for its ACCESS EXCLUSIVE lock, every new query on that table queues
behind it. The migrator runs all pending migrations in one transaction and keeps the
earlier locks while it waits. Start any migration that touches several existing tables with
`SET LOCAL lock_timeout = '3s';` (see `0070_tenant_portability_deferrable_fks.sql`). On a busy
database it then fails fast with `55P03` and rolls back cleanly. Operators should run such
migrations with the daemon stopped.

### Protocol-breaking migrations need an enforced offline cutover

If old and new workers can't share the schema, add the migration to the impact registry in
`migrate.ts` with `requiresOfflineCutover: true` and its rollback compatibility. Existing
databases, SQLite included, then refuse automatic migration until someone runs
`agor db migrate --offline-cutover` with every daemon stopped. Fresh databases still migrate
automatically. Document stop → migrate → start in the user guide. `db status --json`
consumers must read the structured `impact` and `requiresOfflineCutover` fields, never parse
migration names or SQL.

`AGOR_MIGRATION_OFFLINE_CUTOVER=true` (and `SEED=true` for already-rendered managed env
commands) exists only for isolated dev Compose projects. Never set either one to make a shared
or production database boot.

### MCP OAuth grant attribution (0105) lock order

When grants are established, existing config/subject locks come before the consenter
`KEY SHARE` and the token writes. Hard user deletion takes no MCP advisory lock; the FK cascade
is its fence. If a new writer takes a user lock after a token-row lock, it reverses the cascade
order. No provider round-trip may run inside the persistence transaction. OAuth grant tables
are deployment-bound and excluded from tenant portability, so their FKs stay
non-deferrable. Operator steps: `apps/agor-docs/content/guide/mcp-servers.mdx`.

### Edited historical migrations are intentional

The PostgreSQL `0095`/SQLite `0098` owner fallback and the PostgreSQL `0103` NOT NULL
fingerprint repair edit the blocked migration itself, because a blocked database could never
reach a new suffix. Drizzle selects pending work by timestamp and doesn't re-run or
checksum-reject applied migrations. Don't rewrite an operator's ledger. Don't change the
archived-head hash that `0103` uses to authorize destructive reconciliation.
