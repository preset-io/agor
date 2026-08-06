-- Keep recovery discovery bounded and cheap. This is a partial routing index;
-- queue order within one Session remains owned by tasks_queue_idx and the
-- queued-position uniqueness constraint.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE INDEX "tasks_queue_scan_idx"
  ON "tasks" ("tenant_id", "session_id", "created_at")
  WHERE "status" = 'queued';
--> statement-breakpoint

-- All daemons may discover durable queued Session routing refs. The repository
-- projects tenant/session/timestamp only, then leaves system scope and reloads
-- the Session under the discovered trusted tenant before any mutation.
DROP POLICY IF EXISTS "task_queue_discovery" ON "tasks";
--> statement-breakpoint
CREATE POLICY "task_queue_discovery" ON "tasks"
  FOR SELECT
  USING (
    "status" = 'queued'
    AND current_setting('agor.system_scope', true) = 'task_queue_discovery'
  );
