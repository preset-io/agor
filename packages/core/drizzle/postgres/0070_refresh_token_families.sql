CREATE TABLE "refresh_token_families" (
  "family_id" varchar(36) PRIMARY KEY NOT NULL,
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "user_id" varchar(36) NOT NULL REFERENCES "users"("user_id") ON DELETE cascade,
  "current_token_hash" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "refresh_token_families_user_idx" ON "refresh_token_families" ("tenant_id","user_id");
--> statement-breakpoint
ALTER TABLE "refresh_token_families" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "refresh_token_families" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_refresh_token_families" ON "refresh_token_families"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
