ALTER TABLE mcp_oauth_pending_flows ADD COLUMN credential_origin text NOT NULL DEFAULT 'direct';
--> statement-breakpoint
ALTER TABLE mcp_oauth_pending_flows ADD COLUMN managed_metadata text;
--> statement-breakpoint
ALTER TABLE mcp_oauth_pending_flows ADD COLUMN managed_operation_id text;
--> statement-breakpoint
ALTER TABLE user_mcp_oauth_tokens ADD COLUMN credential_origin text NOT NULL DEFAULT 'direct';
--> statement-breakpoint
ALTER TABLE user_mcp_oauth_tokens ADD COLUMN managed_metadata text;
--> statement-breakpoint
ALTER TABLE user_mcp_oauth_tokens ADD COLUMN managed_operation_id text;
--> statement-breakpoint
ALTER TABLE user_mcp_oauth_tokens ADD COLUMN managed_refresh_not_before integer;
--> statement-breakpoint
ALTER TABLE mcp_oauth_pending_flows ADD COLUMN managed_transaction_id text;
--> statement-breakpoint
ALTER TABLE user_mcp_oauth_tokens ADD COLUMN oauth_token_endpoint_auth_method text;
--> statement-breakpoint
CREATE TABLE mcp_managed_oauth_outbox (
  outbox_id text PRIMARY KEY, outbox_key text NOT NULL, operation_id text NOT NULL,
 kind text NOT NULL, attempt_id text NOT NULL, user_id text NOT NULL, mcp_server_id text NOT NULL,
 grant_generation text NOT NULL, managed_metadata text NOT NULL, transaction_id text,
 sealed_material text, created_at integer NOT NULL, expires_at integer NOT NULL, completed_at integer);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_managed_oauth_outbox_key_uq ON mcp_managed_oauth_outbox (outbox_key);
--> statement-breakpoint
CREATE TABLE mcp_managed_oauth_invalidations (
  scope_key text PRIMARY KEY, cell_id text NOT NULL, environment text NOT NULL,
 residency_region text NOT NULL, recovery_incarnation text NOT NULL, status text NOT NULL,
 cursor text, page_digest text, items text NOT NULL, staged_items text NOT NULL, updated_at integer NOT NULL);

--> statement-breakpoint
DROP INDEX mcp_servers_catalog_owner_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_servers_catalog_owner_uq ON mcp_servers (coalesce(owner_user_id, ''), catalog_entry_name, coalesce(json_extract(data, '$.auth.oauth_client_mode'), 'direct')) WHERE source='catalog' AND catalog_entry_name IS NOT NULL;
