-- These index replacements need brief table locks. Fail fast instead of
-- queueing behind a long transaction and blocking unrelated application work.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint

-- Durable completion marker for recoverable scheduler initialization. Existing
-- scheduled Sessions predate recovery and are treated as already complete.
ALTER TABLE "sessions" ADD COLUMN "scheduler_init_completed_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "sessions"
SET "scheduler_init_completed_at" = COALESCE("updated_at", "created_at")
WHERE "scheduled_from_branch" = true;
--> statement-breakpoint
CREATE INDEX "sessions_scheduler_init_pending_idx"
  ON "sessions" ("created_at", "session_id")
  WHERE "scheduled_from_branch" = true
    AND "scheduled_run_at" IS NOT NULL
    AND "scheduler_init_completed_at" IS NULL;
--> statement-breakpoint

-- The source schema has been tenant-aware since app-level multitenancy landed,
-- but the historical migration still leaves this index as
-- (schedule_id, scheduled_run_at). Repair migrated databases to match source.
DROP INDEX IF EXISTS "sessions_schedule_run_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_schedule_run_unique"
  ON "sessions" ("tenant_id", "schedule_id", "scheduled_run_at")
  WHERE "schedule_id" IS NOT NULL AND "scheduled_run_at" IS NOT NULL;
--> statement-breakpoint

-- Recovery may attach the same MCP server from more than one scheduler process.
-- Dedupe legacy rows before replacing the non-unique index with a tenant-aware
-- idempotency constraint.
UPDATE "session_mcp_servers" AS target
SET "enabled" = aggregate."enabled"
FROM (
  SELECT "tenant_id", "session_id", "mcp_server_id", bool_or("enabled") AS "enabled"
  FROM "session_mcp_servers"
  GROUP BY "tenant_id", "session_id", "mcp_server_id"
) AS aggregate
WHERE target."tenant_id" = aggregate."tenant_id"
  AND target."session_id" = aggregate."session_id"
  AND target."mcp_server_id" = aggregate."mcp_server_id";
--> statement-breakpoint
DELETE FROM "session_mcp_servers" AS duplicate
USING "session_mcp_servers" AS keeper
WHERE duplicate."tenant_id" = keeper."tenant_id"
  AND duplicate."session_id" = keeper."session_id"
  AND duplicate."mcp_server_id" = keeper."mcp_server_id"
  AND duplicate.ctid > keeper.ctid;
--> statement-breakpoint
DROP INDEX IF EXISTS "session_mcp_servers_pk";
--> statement-breakpoint
CREATE UNIQUE INDEX "session_mcp_servers_pk"
  ON "session_mcp_servers" ("tenant_id", "session_id", "mcp_server_id");
--> statement-breakpoint

-- System discovery exposes only enabled due schedule routing metadata. The
-- daemon immediately leaves this capability and reloads the schedule under its
-- trusted tenant scope before reading prompt/config content or mutating work.
DROP POLICY IF EXISTS "scheduler_discovery" ON "schedules";
--> statement-breakpoint
CREATE POLICY "scheduler_discovery" ON "schedules"
  FOR SELECT
  USING (
    "enabled" = true
    AND current_setting('agor.system_scope', true) = 'scheduler_discovery'
  );

--> statement-breakpoint
DROP POLICY IF EXISTS "scheduler_recovery_discovery" ON "sessions";
--> statement-breakpoint
CREATE POLICY "scheduler_recovery_discovery" ON "sessions"
  FOR SELECT
  USING (
    "scheduled_from_branch" = true
    AND "scheduled_run_at" IS NOT NULL
    AND "scheduler_init_completed_at" IS NULL
    AND current_setting('agor.system_scope', true) = 'scheduler_discovery'
  );
--> statement-breakpoint

-- Keep the fail-fast lock timeout local to this migration's brief table-locking
-- DDL so later migrations applied in the same Drizzle batch inherit defaults.
SET LOCAL lock_timeout = DEFAULT;
