-- Discover only tenant IDs that own active runtime projections or recently-terminal Tasks.
-- Recovery leaves system scope and reloads every resource under ordinary tenant RLS.
CREATE POLICY "task_runtime_recovery_discovery" ON "tasks"
  FOR SELECT
  USING (
    (
      "status" IN ('dispatching', 'running', 'awaiting_permission', 'awaiting_input', 'stopping')
      OR "completed_at" > CURRENT_TIMESTAMP - INTERVAL '7 days'
    )
    AND current_setting('agor.system_scope', true) = 'task_runtime_recovery'
  );

CREATE POLICY "session_runtime_recovery_discovery" ON "sessions"
  FOR SELECT
  USING (
    "status" IN ('running', 'stopping', 'awaiting_permission', 'awaiting_input', 'timed_out')
    AND current_setting('agor.system_scope', true) = 'task_runtime_recovery'
  );
