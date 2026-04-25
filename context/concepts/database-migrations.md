# Database Migrations

**Status:** ✅ Implemented (Oct 2025)
**Related:** [[architecture]], [[models]], [[worktrees]]

---

## Overview

Agor uses **Drizzle ORM migrations** to version the LibSQL database. Migrations live in `packages/core/drizzle/` and run through the shared CLI + daemon bootstrap.

### Tooling

- `agor db status` – show applied/pending tags
- `agor db migrate` – apply pending SQL with safety prompts
- Daemon boot blocker – refuses to start if migrations are pending (see `apps/agor-daemon/src/index.ts`).

## Implementation Notes

- Source of truth: `packages/core/src/db/schema.ts`
- SQL snapshots: `packages/core/drizzle/{0000_*.sql}` + metadata in `meta/`
- Runtime helpers: `packages/core/src/db/{index.ts,migrate.ts}` expose `checkMigrationStatus`, `runMigrations`.
- CLI commands: `apps/agor-cli/src/commands/db/{status,migrate}.ts`

## Usage

1. Pull latest code.
2. Run `pnpm -w agor db status` to inspect.
3. If pending, run `pnpm -w agor db migrate` (shell prompts you to back up first).
4. Restart daemon—startup check verifies everything is current.

## Gotchas

### Journal timestamps must be monotonically increasing

Drizzle determines pending migrations by comparing each journal entry's `when` timestamp against the max `created_at` in `__drizzle_migrations`. A migration is "pending" only if `when > maxAppliedMillis`.

**If you manually add a migration with a `when` timestamp earlier than an already-applied migration, it will be silently skipped.** The migrator (and `checkMigrationStatus`) will classify it as "already applied" even though it never ran.

When adding manual/backfill migrations to `meta/_journal.json`, always ensure the `when` value is **strictly greater** than all preceding entries. This applies to both `postgres` and `sqlite` journals independently.

### Avoid CHECK constraints for enum-like columns

Don't use `CHECK(col IN ('a', 'b', 'c'))` on SQLite columns. When a new value is added (like adding `'session'` to `others_can`), the CHECK constraint requires a full table recreation migration — SQLite can't alter constraints in place. This is error-prone and easy to forget when updating TypeScript enums.

Instead, validate enum values at the application layer (Drizzle schema `enum` option, Zod, service hooks). The TypeScript types are the source of truth; the DB just stores text.
