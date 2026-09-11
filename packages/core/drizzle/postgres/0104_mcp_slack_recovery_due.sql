SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "mcp_slack_recovery_due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tasks_mcp_slack_recovery_due_idx" ON "tasks" USING btree ("tenant_id","mcp_slack_recovery_due_at","task_id") WHERE "mcp_slack_recovery_due_at" IS NOT NULL;
