-- Existing terminal Tasks predate durable consequence completion tracking.
-- Baseline them once so startup does not replay every historical callback or gateway delivery.
-- FORCE RLS applies to the table owner, so grant only this transaction a
-- migration-local SELECT + UPDATE path and remove both policies before commit.
SELECT set_config('agor.migration_scope', 'terminal_consequence_baseline', true);
--> statement-breakpoint
CREATE POLICY "terminal_consequence_baseline_select" ON "tasks"
  FOR SELECT
  USING (
    current_setting('agor.migration_scope', true) = 'terminal_consequence_baseline'
    AND "status" IN ('completed', 'failed', 'stopped', 'timed_out')
  );
--> statement-breakpoint
CREATE POLICY "terminal_consequence_baseline_update" ON "tasks"
  FOR UPDATE
  USING (
    current_setting('agor.migration_scope', true) = 'terminal_consequence_baseline'
    AND "status" IN ('completed', 'failed', 'stopped', 'timed_out')
    AND "data" -> 'metadata' ->> 'terminal_consequences_completed_at' IS NULL
  )
  WITH CHECK (
    current_setting('agor.migration_scope', true) = 'terminal_consequence_baseline'
    AND "status" IN ('completed', 'failed', 'stopped', 'timed_out')
  );
--> statement-breakpoint
UPDATE "tasks"
SET "data" = jsonb_set(
  jsonb_set(
    COALESCE("data", '{}'::jsonb),
    '{metadata}',
    COALESCE("data" -> 'metadata', '{}'::jsonb),
    true
  ),
  '{metadata,terminal_consequences_completed_at}',
  to_jsonb(to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  true
)
WHERE "status" IN ('completed', 'failed', 'stopped', 'timed_out')
  AND "data" -> 'metadata' ->> 'terminal_consequences_completed_at' IS NULL;
--> statement-breakpoint
DROP POLICY "terminal_consequence_baseline_update" ON "tasks";
--> statement-breakpoint
DROP POLICY "terminal_consequence_baseline_select" ON "tasks";
--> statement-breakpoint
SELECT set_config('agor.migration_scope', '', true);
--> statement-breakpoint

DROP POLICY IF EXISTS "task_runtime_recovery_discovery" ON "tasks";
CREATE POLICY "task_runtime_recovery_discovery" ON "tasks"
  FOR SELECT
  USING (
    (
      "status" IN ('dispatching', 'running', 'awaiting_permission', 'awaiting_input', 'stopping')
      OR (
        "status" IN ('completed', 'failed', 'stopped', 'timed_out')
        AND (
          "data" -> 'metadata' ->> 'terminal_consequences_completed_at' IS NULL
          OR "data" -> 'metadata' -> 'gateway_terminal_delivery' ->> 'status' = 'pending'
        )
      )
    )
    AND current_setting('agor.system_scope', true) = 'task_runtime_recovery'
  );

DROP POLICY IF EXISTS "session_runtime_recovery_discovery" ON "sessions";
CREATE POLICY "session_runtime_recovery_discovery" ON "sessions"
  FOR SELECT
  USING (
    "status" IN ('running', 'stopping', 'awaiting_permission', 'awaiting_input')
    AND current_setting('agor.system_scope', true) = 'task_runtime_recovery'
  );
