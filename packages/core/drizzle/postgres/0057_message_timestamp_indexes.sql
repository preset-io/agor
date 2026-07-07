CREATE INDEX IF NOT EXISTS "messages_tenant_timestamp_idx" ON "messages" ("tenant_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_timestamp_idx" ON "messages" ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_session_timestamp_idx" ON "messages" ("session_id","timestamp");
