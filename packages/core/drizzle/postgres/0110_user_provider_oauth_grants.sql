-- Offline protocol cutover: old writers do not understand managed_oauth.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE "user_provider_oauth_grants" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "user_id" varchar(36) NOT NULL,
  "provider" text NOT NULL,
  "grant_generation" bigint NOT NULL,
  "binding_version" integer NOT NULL,
  "binding_fingerprint" text NOT NULL,
  "established_attempt_id" text NOT NULL,
  "sealed_access_token" text,
  "sealed_refresh_token" text,
  "expires_at" timestamp with time zone,
  "scopes" text DEFAULT '' NOT NULL,
  "subscription_type" text,
  "refresh_generation" bigint DEFAULT 0 NOT NULL,
  "refresh_success_generation" bigint DEFAULT 0 NOT NULL,
  "refresh_claim_id" text,
  "refresh_claimed_at" timestamp with time zone,
  "state" text DEFAULT 'idle' NOT NULL,
  "failure_code" text,
  "retry_not_before" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "user_id", "provider"),
  CONSTRAINT "user_provider_oauth_grants_tenant_user_fk" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users" ("tenant_id", "user_id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "claude_oauth_attempts" ADD COLUMN "submission_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_provider_oauth_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_provider_oauth_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_user_provider_oauth_grants" ON "user_provider_oauth_grants"
USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''))
WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''));
