SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- Offline cutover under NOSUPERUSER/NOBYPASSRLS. These narrow temporary
-- policies repair all tenants without disabling or weakening runtime FORCE RLS.
-- No historical shared consenter may be inferred from MCP ownership.
ALTER TABLE "user_mcp_oauth_tokens" ADD COLUMN "granted_by_user_id" varchar(36);
--> statement-breakpoint
CREATE POLICY "grant_attribution_0105_select" ON "user_mcp_oauth_tokens"
  FOR SELECT USING (current_setting('agor.system_scope', true) = 'grant_attribution_0105');
--> statement-breakpoint
CREATE POLICY "grant_attribution_0105_update" ON "user_mcp_oauth_tokens"
  FOR UPDATE USING (current_setting('agor.system_scope', true) = 'grant_attribution_0105')
  WITH CHECK (current_setting('agor.system_scope', true) = 'grant_attribution_0105');
--> statement-breakpoint
CREATE POLICY "grant_attribution_0105_delete" ON "user_mcp_oauth_tokens"
  FOR DELETE USING (current_setting('agor.system_scope', true) = 'grant_attribution_0105');
--> statement-breakpoint
SELECT set_config('agor.system_scope', 'grant_attribution_0105', true);
--> statement-breakpoint
-- Local retirement only; this does not synchronously revoke at the provider.
DELETE FROM "user_mcp_oauth_tokens" WHERE "user_id" IS NULL;
--> statement-breakpoint
UPDATE "user_mcp_oauth_tokens" SET "granted_by_user_id" = "user_id";
--> statement-breakpoint
DROP POLICY "grant_attribution_0105_select" ON "user_mcp_oauth_tokens";
--> statement-breakpoint
DROP POLICY "grant_attribution_0105_update" ON "user_mcp_oauth_tokens";
--> statement-breakpoint
DROP POLICY "grant_attribution_0105_delete" ON "user_mcp_oauth_tokens";
--> statement-breakpoint
SELECT set_config('agor.system_scope', '', true);
--> statement-breakpoint
ALTER TABLE "user_mcp_oauth_tokens"
  ALTER COLUMN "granted_by_user_id" SET NOT NULL,
  ADD CONSTRAINT "user_mcp_oauth_tokens_consenter_subject_check"
    CHECK ("user_id" IS NULL OR "user_id" = "granted_by_user_id"),
  ADD CONSTRAINT "user_mcp_oauth_tokens_tenant_granted_by_fk"
    FOREIGN KEY ("tenant_id", "granted_by_user_id")
    REFERENCES "users" ("tenant_id", "user_id") ON DELETE CASCADE;
--> statement-breakpoint
-- Deployment-bound OAuth grants are intentionally excluded from the tenant
-- portability manifest, so this FK remains immediate and non-deferrable.
CREATE INDEX "user_mcp_oauth_tokens_granted_by_idx"
  ON "user_mcp_oauth_tokens" ("granted_by_user_id");
