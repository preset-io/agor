CREATE TABLE "agor_pack_imports" (
 "tenant_id" text DEFAULT 'default' NOT NULL,
 "import_id" varchar(36) PRIMARY KEY NOT NULL,
 "owner_user_id" varchar(36) NOT NULL,
 "content_sha256" text NOT NULL,
 "staging_ref" text,
 "status" text NOT NULL,
 "manifest" jsonb NOT NULL,
 "dry_run" jsonb,
 "results" jsonb,
 "error" text,
 "created_at" timestamp with time zone NOT NULL,
 "updated_at" timestamp with time zone NOT NULL,
 "applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "agor_pack_imports_tenant_idx" ON "agor_pack_imports" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agor_pack_imports_content_unique" ON "agor_pack_imports" ("tenant_id", "owner_user_id", "content_sha256");
--> statement-breakpoint
ALTER TABLE "agor_pack_imports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agor_pack_imports" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_agor_pack_imports" ON "agor_pack_imports"
USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''))
WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''));
