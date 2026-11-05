SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "agor_pack_imports" ADD COLUMN "progress" jsonb;
--> statement-breakpoint
ALTER TABLE "agor_pack_imports" ADD COLUMN "claim_token" text;
--> statement-breakpoint
ALTER TABLE "agor_pack_imports" ADD COLUMN "claimed_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "staged_blobs" (
 "blob_ref" text PRIMARY KEY NOT NULL,
 "tenant_id" text DEFAULT 'default' NOT NULL,
 "kind" text NOT NULL,
 "scope_id" varchar(36) NOT NULL,
 "created_by" varchar(36) NOT NULL,
 "size_bytes" bigint NOT NULL,
 "status" text NOT NULL,
 "created_at" timestamp with time zone NOT NULL,
 "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "staged_blobs_scope_idx" ON "staged_blobs" ("tenant_id", "kind", "scope_id");
--> statement-breakpoint
CREATE INDEX "staged_blobs_expiry_idx" ON "staged_blobs" ("expires_at");
--> statement-breakpoint
ALTER TABLE "staged_blobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "staged_blobs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_staged_blobs" ON "staged_blobs"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
-- Same narrow discovery as uploads: the maintenance sweep may enumerate the
-- tenant IDs of expired rows, then deletes under each tenant's own scope.
CREATE POLICY "upload_maintenance_discovery" ON "staged_blobs"
  FOR SELECT
  USING (
    "expires_at" < CURRENT_TIMESTAMP
    AND current_setting('agor.system_scope', true) = 'upload_maintenance'
  );
