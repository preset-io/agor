CREATE TABLE "kb_import_receipts" (
 "tenant_id" text DEFAULT 'default' NOT NULL,
 "receipt_id" text PRIMARY KEY NOT NULL,
 "owner_user_id" varchar(36) NOT NULL,
 "bundle" text NOT NULL,
 "slug" text NOT NULL,
 "entry_key" text NOT NULL,
 "target_id" text NOT NULL,
 "digest" text NOT NULL,
 "request_bytes" integer DEFAULT 0 NOT NULL,
 "reconciled_count" integer DEFAULT -1 NOT NULL,
 "created_at" timestamp with time zone NOT NULL,
 CONSTRAINT "kb_import_receipts_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("user_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX "kb_import_receipts_tenant_idx" ON "kb_import_receipts" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "kb_import_receipts_identity_unique" ON "kb_import_receipts" ("tenant_id", "owner_user_id", "bundle", "slug", "entry_key");
--> statement-breakpoint
ALTER TABLE "kb_import_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kb_import_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_kb_import_receipts" ON "kb_import_receipts"
USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''))
WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''));
