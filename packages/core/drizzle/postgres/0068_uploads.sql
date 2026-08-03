CREATE TABLE "uploads" (
  "upload_ref" text PRIMARY KEY NOT NULL,
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "created_by" varchar(36) NOT NULL,
  "session_id" varchar(36) NOT NULL,
  "branch_id" varchar(36) NOT NULL,
  "storage_key" text NOT NULL,
  "original_name" text NOT NULL,
  "display_name" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "checksum" text,
  "status" text DEFAULT 'active' NOT NULL,
  "provenance" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "uploads_tenant_owner_idx" ON "uploads" ("tenant_id","created_by");
--> statement-breakpoint
CREATE INDEX "uploads_tenant_session_idx" ON "uploads" ("tenant_id","session_id");
--> statement-breakpoint
CREATE INDEX "uploads_expiry_idx" ON "uploads" ("expires_at");
--> statement-breakpoint
ALTER TABLE "uploads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "uploads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_uploads" ON "uploads"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
