-- First-class schedules table. Design doc:
-- docs/internal/schedules-first-class-design-2026-05-24.md
--
-- See SQLite mirror (0046) for the full rationale. Notable Postgres-
-- specific bits:
--
-- - `gen_random_uuid()` requires Postgres 13+ (built-in via pgcrypto's
--   internal namespace). We deliberately don't `CREATE EXTENSION
--   pgcrypto` here: it would fail in managed-Postgres environments
--   where the migrator role lacks extension-create privileges, even
--   though `gen_random_uuid()` already works without the extension.
--   PG13+ is the floor for Agor.
-- - jsonb access uses `->` / `->>`; the strict `::bigint` cast
--   inherently rejects corrupt non-numeric values (Postgres throws,
--   migration aborts cleanly — equivalent safety to SQLite's CAST).
-- - The partial unique index uses the same predicate as SQLite
--   (`schedule_id IS NOT NULL AND scheduled_run_at IS NOT NULL`) so
--   the two dialects enforce the exact same dedup invariant.

CREATE TABLE "schedules" (
	"schedule_id" varchar(36) PRIMARY KEY NOT NULL,
	"branch_id" varchar(36) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cron_expression" text NOT NULL,
	"timezone_mode" text DEFAULT 'local' NOT NULL,
	"timezone" text,
	"prompt" text NOT NULL,
	"agentic_tool_config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allow_concurrent_runs" boolean DEFAULT false NOT NULL,
	"retention" integer DEFAULT 5 NOT NULL,
	"last_run_at" bigint,
	"last_run_session_id" varchar(36),
	"next_run_at" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" varchar(36) NOT NULL
);--> statement-breakpoint

ALTER TABLE "schedules" ADD CONSTRAINT "schedules_branch_id_branches_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("branch_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_last_run_session_id_sessions_session_id_fk" FOREIGN KEY ("last_run_session_id") REFERENCES "sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "schedules_enabled_next_run_idx" ON "schedules" ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "schedules_branch_idx" ON "schedules" ("branch_id");--> statement-breakpoint
CREATE INDEX "schedules_created_by_idx" ON "schedules" ("created_by");--> statement-breakpoint

-- Add schedule_id FK to sessions (ON DELETE SET NULL).
ALTER TABLE "sessions" ADD COLUMN "schedule_id" varchar(36);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_schedule_id_schedules_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("schedule_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Partial unique index: covering for dedup AND race guard. Predicate
-- requires BOTH columns non-null — see SQLite mirror.
CREATE UNIQUE INDEX "sessions_schedule_run_unique" ON "sessions" ("schedule_id","scheduled_run_at")
WHERE "schedule_id" IS NOT NULL AND "scheduled_run_at" IS NOT NULL;--> statement-breakpoint

-- Backfill: one schedules row per fully-configured branch schedule.
-- timezone_mode='utc' preserves today's hardcoded-UTC behavior.
INSERT INTO "schedules" (
	schedule_id, branch_id, name, cron_expression,
	timezone_mode, timezone, prompt, agentic_tool_config,
	enabled, allow_concurrent_runs, retention,
	last_run_at, next_run_at,
	created_at, updated_at, created_by
)
SELECT
	gen_random_uuid()::text,
	b.branch_id,
	'Default',
	b.schedule_cron,
	'utc',
	NULL,
	b.data->'schedule'->>'prompt_template',
	jsonb_build_object(
		'agentic_tool',    b.data->'schedule'->>'agentic_tool',
		'permission_mode', b.data->'schedule'->>'permission_mode',
		-- Legacy { mode: 'default'|'custom' } → canonical { mode: 'exact' }
		-- per the new DefaultModelConfig shape. mode='default' meant
		-- "no override" → drop to NULL so the scheduler falls back to
		-- agent defaults.
		'model_config',
			CASE
				WHEN b.data->'schedule'->'model_config'->>'mode' = 'custom'
				     AND b.data->'schedule'->'model_config'->>'model' IS NOT NULL
				THEN jsonb_build_object(
					'mode', 'exact',
					'model', b.data->'schedule'->'model_config'->>'model'
				)
				ELSE NULL
			END,
		'mcp_server_ids',  b.data->'schedule'->'mcp_server_ids',
		'context_files',   b.data->'schedule'->'context_files'
	),
	b.schedule_enabled,
	COALESCE((b.data->'schedule'->>'allow_concurrent_runs')::boolean, false),
	COALESCE((b.data->'schedule'->>'retention')::int, 5),
	b.schedule_last_triggered_at,
	b.schedule_next_run_at,
	COALESCE(to_timestamp((b.data->'schedule'->>'created_at')::bigint / 1000.0), b.created_at),
	b.updated_at,
	-- ALWAYS use the branch's created_by. The schedule blob also stores
	-- the user who originally saved it, but if THAT user was later
	-- deleted, schedules.created_by → users(user_id) would FK-violate
	-- and abort the migration. b.created_by is guaranteed valid (it's
	-- the branch's FK to users). Minor attribution fidelity loss; high
	-- migration safety.
	b.created_by
FROM "branches" b
WHERE b.schedule_cron IS NOT NULL
	AND b.data->'schedule'->>'prompt_template' IS NOT NULL;--> statement-breakpoint

-- Backfill: link existing scheduled sessions to their schedule.
UPDATE "sessions"
SET schedule_id = s.schedule_id
FROM "schedules" s
WHERE sessions.scheduled_from_branch = true
	AND sessions.branch_id = s.branch_id;--> statement-breakpoint

-- Backfill: point `schedules.last_run_session_id` at the session that
-- corresponds to `schedules.last_run_at`.
UPDATE "schedules"
SET last_run_session_id = s.session_id
FROM "sessions" s
WHERE s.schedule_id = schedules.schedule_id
	AND s.scheduled_run_at = schedules.last_run_at
	AND schedules.last_run_at IS NOT NULL;--> statement-breakpoint

-- Remove the schedule key from branches.data jsonb.
UPDATE "branches"
SET data = data - 'schedule'
WHERE data ? 'schedule';--> statement-breakpoint

-- Drop old indexes that referenced the columns being removed.
DROP INDEX IF EXISTS "branches_schedule_enabled_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "branches_board_schedule_idx";--> statement-breakpoint

-- Drop the four schedule_* columns from `branches`.
ALTER TABLE "branches" DROP COLUMN "schedule_enabled";--> statement-breakpoint
ALTER TABLE "branches" DROP COLUMN "schedule_cron";--> statement-breakpoint
ALTER TABLE "branches" DROP COLUMN "schedule_last_triggered_at";--> statement-breakpoint
ALTER TABLE "branches" DROP COLUMN "schedule_next_run_at";
