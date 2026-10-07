SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "user_mcp_oauth_tokens" ADD COLUMN "oauth_token_endpoint_auth_method" text;
