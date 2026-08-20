SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_tenant_archived_updated_idx" ON "sessions" ("tenant_id","archived","updated_at");
