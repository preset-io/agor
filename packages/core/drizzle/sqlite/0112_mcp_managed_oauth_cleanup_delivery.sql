-- Inert schema parity only; managed authority is unavailable on SQLite.
ALTER TABLE mcp_managed_oauth_outbox ADD COLUMN cleanup_authorization_id text;
--> statement-breakpoint
ALTER TABLE mcp_managed_oauth_outbox ADD COLUMN cleanup_operation_id text;
