SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- An already-installed feature DB recorded tenant_restrictions at the exact
-- timestamp now occupied by main's 0112_kb_import_receipts. Drizzle skips that
-- main entry on upgrade, so reconcile its schema here without touching data.
CREATE TABLE IF NOT EXISTS "kb_import_receipts" (
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
CREATE INDEX IF NOT EXISTS "kb_import_receipts_tenant_idx" ON "kb_import_receipts" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kb_import_receipts_identity_unique" ON "kb_import_receipts" ("tenant_id", "owner_user_id", "bundle", "slug", "entry_key");
--> statement-breakpoint
ALTER TABLE "kb_import_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kb_import_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "tenant_isolation_kb_import_receipts" ON "kb_import_receipts"
    USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''))
    WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_restrictions" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "controller_id" text NOT NULL,
  "placement_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "revision" bigint NOT NULL,
  "phase" text NOT NULL,
  "protocol_version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("tenant_id", "controller_id")
);
--> statement-breakpoint
ALTER TABLE "tenant_restrictions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_restrictions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "tenant_isolation_tenant_restrictions" ON "tenant_restrictions"
    USING (
      COALESCE(current_setting('agor.system_scope', true), '') = ''
      AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), '')
    )
    WITH CHECK (
      COALESCE(current_setting('agor.system_scope', true), '') = ''
      AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), '')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- Reconcile main's 0115 policy for the prior feature watermark, which occupied
-- the same timestamp and therefore causes Drizzle to skip that entry.
-- A personal API key carries no tenant claim. In hosted required_from_auth
-- deployments the trusted request Host names the workspace, and each tenant's
-- launch-observed public URL lives in app_variables (tenant.routing/public_url).
-- This narrowly named capability may read ONLY those routing rows so the daemon
-- can map Host -> tenant_id before authentication. Key verification then leaves
-- system scope and runs under the discovered tenant's ordinary RLS policy, so
-- the capability never exposes key material or any other tenant variable.
DROP POLICY IF EXISTS "api_key_host_tenant_discovery" ON "app_variables";
--> statement-breakpoint
CREATE POLICY "api_key_host_tenant_discovery"
	ON "app_variables"
	FOR SELECT
	USING (
		current_setting('agor.system_scope', true) = 'api_key_host_tenant_discovery'
		AND "namespace" = 'tenant.routing'
		AND "key" = 'public_url'
	);

--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
