ALTER TABLE "users" ADD COLUMN "access_disabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "external_user_authority" (
 "tenant_id" text DEFAULT 'default' NOT NULL,
 "identity_key" text NOT NULL,
 "provider" text NOT NULL,
 "issuer" text NOT NULL,
 "subject" text NOT NULL,
 "revision" text NOT NULL,
 "login_epoch" text NOT NULL,
 "active" boolean NOT NULL,
 "role" text NOT NULL,
 PRIMARY KEY ("tenant_id", "identity_key")
);
--> statement-breakpoint
ALTER TABLE "external_user_authority" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "external_user_authority" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_external_user_authority" ON "external_user_authority"
USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''))
WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''));
