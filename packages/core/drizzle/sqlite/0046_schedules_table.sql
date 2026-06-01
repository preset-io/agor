-- First-class schedules table. Design doc:
-- docs/internal/schedules-first-class-design-2026-05-24.md
--
-- - Creates `schedules` table + `sessions.schedule_id` FK column.
-- - The `sessions(schedule_id, scheduled_run_at)` covering index is
--   defined as a PARTIAL UNIQUE index from the start: it serves both
--   as the scheduler's dedup-lookup hot path AND as a DB-level guard
--   against check-then-create races inside spawnScheduledSession
--   (cron tick + manual run-now, or back-to-back ticks on the same
--   scheduledRunAt). The partial predicate excludes rows where either
--   column is NULL — ad-hoc sessions (no schedule_id) and any other
--   row with a NULL key would otherwise spuriously clash.
-- - Backfills one `schedules` row per branch that has a fully-configured
--   schedule today (schedule_cron IS NOT NULL AND data.schedule.prompt_template
--   IS NOT NULL); half-configured rows are dropped silently per §5.4.
-- - Backfills sessions.schedule_id by joining on branch_id (one schedule
--   per branch today, so the mapping is unambiguous).
-- - Drops the four branches.schedule_* columns and the data.schedule key
--   in the same transaction. SQLite supports ALTER TABLE ... DROP COLUMN
--   since 3.35 (2021), so we avoid the __new_branches recreation dance.
--
-- Order matters: INSERT into schedules → UPDATE sessions → DROP indexes →
-- DROP COLUMN. If the INSERT fails, the migration aborts before any
-- destructive operation (Drizzle wraps each migration in a transaction).
--
-- timezone_mode is validated at the app layer (no DB CHECK) per
-- context/guides/creating-database-migrations.md.

CREATE TABLE `schedules` (
	`schedule_id` text(36) PRIMARY KEY NOT NULL,
	`branch_id` text(36) NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cron_expression` text NOT NULL,
	`timezone_mode` text DEFAULT 'local' NOT NULL,
	`timezone` text,
	`prompt` text NOT NULL,
	`agentic_tool_config` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`allow_concurrent_runs` integer DEFAULT false NOT NULL,
	`retention` integer DEFAULT 5 NOT NULL,
	`last_run_at` integer,
	`last_run_session_id` text(36),
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text(36) NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_run_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint

CREATE INDEX `schedules_enabled_next_run_idx` ON `schedules` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `schedules_branch_idx` ON `schedules` (`branch_id`);--> statement-breakpoint
CREATE INDEX `schedules_created_by_idx` ON `schedules` (`created_by`);--> statement-breakpoint

-- Add schedule_id FK to sessions (ON DELETE SET NULL — retention-deleted
-- sessions shouldn't dangle; surviving sessions of a deleted schedule
-- become orphaned runs).
ALTER TABLE `sessions` ADD COLUMN `schedule_id` text(36) REFERENCES `schedules`(`schedule_id`) ON DELETE SET NULL;--> statement-breakpoint

-- Partial unique index: covering for the scheduler's dedup lookup AND
-- the DB-level race guard. Predicate requires BOTH columns non-null —
-- the logical dedup key is only meaningful when both are present, and
-- ad-hoc sessions (NULL schedule_id) must coexist freely.
CREATE UNIQUE INDEX `sessions_schedule_run_unique` ON `sessions` (`schedule_id`,`scheduled_run_at`)
WHERE `schedule_id` IS NOT NULL AND `scheduled_run_at` IS NOT NULL;--> statement-breakpoint

-- Backfill: one schedules row per fully-configured branch schedule.
-- timezone_mode='utc' preserves today's hardcoded-UTC behavior.
-- New schedule_id is a random hex blob (UUIDv4 shape). The app layer
-- generates UUIDv7 for new rows; backfilled rows don't need ordering.
INSERT INTO `schedules` (
	schedule_id, branch_id, name, cron_expression,
	timezone_mode, timezone, prompt, agentic_tool_config,
	enabled, allow_concurrent_runs, retention,
	last_run_at, next_run_at,
	created_at, updated_at, created_by
)
SELECT
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	b.branch_id,
	'Default',
	b.schedule_cron,
	'utc',
	NULL,
	json_extract(b.data, '$.schedule.prompt_template'),
	json_object(
		'agentic_tool',     json_extract(b.data, '$.schedule.agentic_tool'),
		'permission_mode',  json_extract(b.data, '$.schedule.permission_mode'),
		-- Legacy { mode: 'default'|'custom' } → canonical { mode: 'exact' }
		-- per the new DefaultModelConfig shape used everywhere else
		-- (sessions / user defaults / form helpers). mode='default' meant
		-- "no override" → drop to NULL so the scheduler falls back to
		-- agent defaults.
		'model_config',
			CASE
				WHEN json_extract(b.data, '$.schedule.model_config.mode') = 'custom'
				     AND json_extract(b.data, '$.schedule.model_config.model') IS NOT NULL
				THEN json_object(
					'mode', 'exact',
					'model', json_extract(b.data, '$.schedule.model_config.model')
				)
				ELSE NULL
			END,
		'mcp_server_ids',   json_extract(b.data, '$.schedule.mcp_server_ids'),
		'context_files',    json_extract(b.data, '$.schedule.context_files')
	),
	b.schedule_enabled,
	-- Wrap JSON-extracted numeric values in CAST AS INTEGER. SQLite has
	-- loose type affinity — `json_extract` of a string value (e.g.
	-- corrupted JSON like `"retention": "10"`) would otherwise silently
	-- write text into the INTEGER NOT NULL column. CAST coerces to
	-- INTEGER (text "10" → 10, garbage → 0). Postgres' strict typing
	-- catches this naturally; SQLite needs the explicit cast.
	CAST(COALESCE(json_extract(b.data, '$.schedule.allow_concurrent_runs'), 0) AS INTEGER),
	CAST(COALESCE(json_extract(b.data, '$.schedule.retention'), 5) AS INTEGER),
	b.schedule_last_triggered_at,
	b.schedule_next_run_at,
	CAST(COALESCE(json_extract(b.data, '$.schedule.created_at'), b.created_at) AS INTEGER),
	b.updated_at,
	-- ALWAYS use the branch's created_by. The schedule blob also stores
	-- the user who originally saved it, but if THAT user was later
	-- deleted, schedules.created_by → users(user_id) would FK-violate
	-- and abort the migration. b.created_by is guaranteed valid (it's
	-- the branch's FK to users). Minor attribution fidelity loss; high
	-- migration safety.
	b.created_by
FROM `branches` b
WHERE b.schedule_cron IS NOT NULL
	AND json_extract(b.data, '$.schedule.prompt_template') IS NOT NULL;--> statement-breakpoint

-- Backfill: link existing scheduled sessions to their schedule.
-- Each branch has at most one schedule today, so the mapping is unambiguous.
UPDATE `sessions`
SET schedule_id = (
	SELECT s.schedule_id FROM `schedules` s WHERE s.branch_id = sessions.branch_id
)
WHERE sessions.scheduled_from_branch = 1
	AND sessions.branch_id IN (SELECT branch_id FROM `schedules`);--> statement-breakpoint

-- Backfill: point `schedules.last_run_session_id` at the session that
-- corresponds to `schedules.last_run_at`. Pre-#1253 the scheduler
-- already stored the minute-rounded scheduled_run_at on both sides, so
-- the join is exact when a matching session survives retention. NULL
-- when no match (acceptable — UI will simply not render a clickable
-- link until the next run fires).
UPDATE `schedules`
SET last_run_session_id = (
	SELECT s.session_id FROM `sessions` s
	WHERE s.schedule_id = schedules.schedule_id
		AND s.scheduled_run_at = schedules.last_run_at
	LIMIT 1
)
WHERE schedules.last_run_at IS NOT NULL;--> statement-breakpoint

-- Remove the schedule key from branches.data JSON (SQLite 3.38+ json_remove).
UPDATE `branches`
SET data = json_remove(data, '$.schedule')
WHERE json_extract(data, '$.schedule') IS NOT NULL;--> statement-breakpoint

-- Drop old indexes that referenced the columns being removed.
DROP INDEX IF EXISTS `branches_schedule_enabled_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `branches_board_schedule_idx`;--> statement-breakpoint

-- Drop the four schedule_* columns from `branches`.
ALTER TABLE `branches` DROP COLUMN `schedule_enabled`;--> statement-breakpoint
ALTER TABLE `branches` DROP COLUMN `schedule_cron`;--> statement-breakpoint
ALTER TABLE `branches` DROP COLUMN `schedule_last_triggered_at`;--> statement-breakpoint
ALTER TABLE `branches` DROP COLUMN `schedule_next_run_at`;
