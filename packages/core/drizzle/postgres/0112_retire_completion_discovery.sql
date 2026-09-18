-- Root propagation was withdrawn. Preserve stored rows and tenant isolation,
-- but revoke its unused cross-tenant discovery capability (including on Tasks).
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DROP POLICY IF EXISTS "completion_callback_task_discovery" ON "tasks";--> statement-breakpoint
DROP POLICY IF EXISTS "completion_callback_discovery" ON "completion_subscriptions";
