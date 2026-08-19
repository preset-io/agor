-- Task-runtime HA recovery. Scan markers and coordination columns are
-- materialized because bounded hot-path predicates must not depend on JSON
-- expression scans. Daemon identity is diagnostic; the opaque token fences
-- settlement after a replacement coordinator reclaims expired work.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "termination_coordination_token" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "dispatch_timeout_observed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "termination_coordination_claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "termination_coordination_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "termination_coordination_instance_id" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "termination_coordination_boot_id" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "termination_unverified_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "tasks"
SET "termination_unverified_at" = CURRENT_TIMESTAMP
WHERE "status" = 'stopping' AND "data"->'sdk_failure'->>'termination' = 'unverified';
--> statement-breakpoint
CREATE INDEX "tasks_runtime_dispatch_idx" ON "tasks" ("started_at", "task_id")
  WHERE "status" = 'dispatching' AND "executor_connected_at" IS NULL
    AND "started_at" IS NOT NULL AND "dispatch_timeout_observed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "tasks_runtime_heartbeat_idx" ON "tasks" ("last_executor_heartbeat_at", "task_id")
  WHERE "status" IN ('running', 'awaiting_permission', 'awaiting_input')
    AND "last_executor_heartbeat_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "tasks_runtime_termination_idx" ON "tasks" ("termination_coordination_expires_at", "task_id")
  WHERE "status" = 'stopping' AND "termination_unverified_at" IS NULL;
--> statement-breakpoint

-- System scope is routing-only at the repository boundary. The policy grants
-- SELECT only for runtime states the reconciler is allowed to discover; each
-- candidate is reloaded and mutated under its trusted tenant context.
DROP POLICY IF EXISTS "task_runtime_discovery" ON "tasks";
--> statement-breakpoint
CREATE POLICY "task_runtime_discovery" ON "tasks"
  FOR SELECT
  USING (
    current_setting('agor.system_scope', true) = 'task_runtime_discovery'
    AND "status" IN (
      'dispatching',
      'running',
      'stopping',
      'awaiting_permission',
      'awaiting_input'
    )
  );
