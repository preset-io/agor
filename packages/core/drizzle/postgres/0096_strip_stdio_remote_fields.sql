-- Authentication, URLs, and HTTP headers never participate in an stdio MCP
-- connection. Older rows could retain those fields, but strict transport
-- validation now rejects the whole server before spawning it. OAuth grants and
-- pending flows are likewise unusable after a transport switch and may contain
-- credentials, so remove them in the same transaction as the row repair.
--
-- All three tables use FORCE RLS. Open only this exact transaction-local
-- migration capability, then remove every temporary policy before commit. This
-- keeps the repair effective for every tenant under the supported
-- non-superuser/NOBYPASSRLS migration role without creating a runtime bypass.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
DROP POLICY IF EXISTS "stdio_repair_0096_select" ON "mcp_servers";
--> statement-breakpoint
CREATE POLICY "stdio_repair_0096_select" ON "mcp_servers"
  FOR SELECT
  USING (
    current_setting('agor.system_scope', true) = 'stdio_remote_repair_0096'
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "stdio_repair_0096_update" ON "mcp_servers";
--> statement-breakpoint
CREATE POLICY "stdio_repair_0096_update" ON "mcp_servers"
  FOR UPDATE
  USING (
    current_setting('agor.system_scope', true) = 'stdio_remote_repair_0096'
  )
  WITH CHECK (
    current_setting('agor.system_scope', true) = 'stdio_remote_repair_0096'
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "stdio_repair_0096_delete" ON "user_mcp_oauth_tokens";
--> statement-breakpoint
DROP POLICY IF EXISTS "stdio_repair_0096_select" ON "user_mcp_oauth_tokens";
--> statement-breakpoint
CREATE POLICY "stdio_repair_0096_select" ON "user_mcp_oauth_tokens"
  FOR SELECT
  USING (
    current_setting('agor.system_scope', true) = 'stdio_remote_repair_0096'
  );
--> statement-breakpoint
CREATE POLICY "stdio_repair_0096_delete" ON "user_mcp_oauth_tokens"
  FOR DELETE
  USING (
    current_setting('agor.system_scope', true) = 'stdio_remote_repair_0096'
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "stdio_repair_0096_delete" ON "mcp_oauth_pending_flows";
--> statement-breakpoint
DROP POLICY IF EXISTS "stdio_repair_0096_select" ON "mcp_oauth_pending_flows";
--> statement-breakpoint
CREATE POLICY "stdio_repair_0096_select" ON "mcp_oauth_pending_flows"
  FOR SELECT
  USING (
    current_setting('agor.system_scope', true) = 'stdio_remote_repair_0096'
  );
--> statement-breakpoint
CREATE POLICY "stdio_repair_0096_delete" ON "mcp_oauth_pending_flows"
  FOR DELETE
  USING (
    current_setting('agor.system_scope', true) = 'stdio_remote_repair_0096'
  );
--> statement-breakpoint
SELECT set_config('agor.system_scope', 'stdio_remote_repair_0096', true);
--> statement-breakpoint
WITH stdio_servers AS MATERIALIZED (
  SELECT
    "tenant_id",
    "mcp_server_id",
    "data" ?| ARRAY['auth', 'url', 'headers'] AS "has_remote_fields"
  FROM "mcp_servers"
  WHERE "transport" = 'stdio'
  FOR UPDATE
), deleted_pending_flows AS (
  DELETE FROM "mcp_oauth_pending_flows" AS flow
  USING stdio_servers AS server
  WHERE flow."tenant_id" = server."tenant_id"
    AND flow."mcp_server_id" = server."mcp_server_id"
), deleted_grants AS (
  DELETE FROM "user_mcp_oauth_tokens" AS token
  USING stdio_servers AS server
  WHERE token."tenant_id" = server."tenant_id"
    AND token."mcp_server_id" = server."mcp_server_id"
)
UPDATE "mcp_servers" AS server
SET "data" = server."data" - 'auth' - 'url' - 'headers'
FROM stdio_servers AS repaired
WHERE server."tenant_id" = repaired."tenant_id"
  AND server."mcp_server_id" = repaired."mcp_server_id"
  AND repaired."has_remote_fields";
--> statement-breakpoint
SELECT set_config('agor.system_scope', '', true);
--> statement-breakpoint
DROP POLICY "stdio_repair_0096_delete" ON "mcp_oauth_pending_flows";
--> statement-breakpoint
DROP POLICY "stdio_repair_0096_select" ON "mcp_oauth_pending_flows";
--> statement-breakpoint
DROP POLICY "stdio_repair_0096_delete" ON "user_mcp_oauth_tokens";
--> statement-breakpoint
DROP POLICY "stdio_repair_0096_select" ON "user_mcp_oauth_tokens";
--> statement-breakpoint
DROP POLICY "stdio_repair_0096_update" ON "mcp_servers";
--> statement-breakpoint
DROP POLICY "stdio_repair_0096_select" ON "mcp_servers";
--> statement-breakpoint
-- Migrations share one transaction, so do not leak this DDL safety timeout into
-- later migrations in the same upgrade run.
SET LOCAL lock_timeout = DEFAULT;
