SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_tenant_archived_updated_idx" ON "sessions" ("tenant_id","archived","updated_at");--> statement-breakpoint
-- Keep this migration's fail-fast lock policy from leaking into later DDL in
-- the same Drizzle transaction.
SET LOCAL lock_timeout = DEFAULT;
