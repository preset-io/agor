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

_Detailed planning doc archived in `context/archives/database-migrations.md`._
