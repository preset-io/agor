ALTER TABLE "messages" ADD COLUMN "mcp_slack_connect_due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "messages_mcp_slack_connect_due_idx" ON "messages" USING btree ("tenant_id","mcp_slack_connect_due_at","message_id") WHERE "mcp_slack_connect_due_at" IS NOT NULL;
