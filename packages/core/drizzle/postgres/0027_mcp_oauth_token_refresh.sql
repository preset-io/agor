-- MCP OAuth Token Refresh — consolidate shared + per-user OAuth tokens
--
-- 1. Make `user_mcp_oauth_tokens.user_id` NULLABLE (NULL = shared-mode row
--    for that mcp_server_id) and add `oauth_client_id`/`oauth_client_secret`
--    co-located with the refresh_token.
--
-- 2. Backfill shared-mode tokens from `mcp_servers.data.auth.*`.
--
-- 3. Strip runtime token fields from `mcp_servers.data.auth`, keeping
--    config fields (token_url, authorization_url, pre-registered
--    client_id/secret, scope, mode).

ALTER TABLE "user_mcp_oauth_tokens" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_mcp_oauth_tokens" ADD COLUMN IF NOT EXISTS "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "user_mcp_oauth_tokens" ADD COLUMN IF NOT EXISTS "oauth_client_secret" text;--> statement-breakpoint

-- Dedupe before creating the unique indexes. The previous schema had only a
-- non-unique index on (user_id, mcp_server_id) and writes were check-then-
-- insert, so duplicates are possible in pre-migration data. Keep the most-
-- recently-touched row per key.
DELETE FROM "user_mcp_oauth_tokens" t
USING (
	SELECT ctid, ROW_NUMBER() OVER (
		PARTITION BY "user_id", "mcp_server_id"
		ORDER BY COALESCE("updated_at", "created_at") DESC, "created_at" DESC
	) AS rn
	FROM "user_mcp_oauth_tokens"
) dupes
WHERE t.ctid = dupes.ctid AND dupes.rn > 1;--> statement-breakpoint

-- Enforce one token per (user, server) for per-user rows, and one shared row per server.
CREATE UNIQUE INDEX IF NOT EXISTS "user_mcp_oauth_tokens_user_server_uq"
	ON "user_mcp_oauth_tokens" ("user_id", "mcp_server_id")
	WHERE "user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_mcp_oauth_tokens_shared_server_uq"
	ON "user_mcp_oauth_tokens" ("mcp_server_id")
	WHERE "user_id" IS NULL;--> statement-breakpoint

-- Backfill shared-mode tokens.
INSERT INTO "user_mcp_oauth_tokens" (
	"user_id", "mcp_server_id", "oauth_access_token", "oauth_token_expires_at",
	"oauth_refresh_token", "oauth_client_id", "oauth_client_secret",
	"created_at"
)
SELECT
	NULL,
	"mcp_server_id",
	"data"->'auth'->>'oauth_access_token',
	CASE
		WHEN "data"->'auth'->>'oauth_token_expires_at' ~ '^[0-9]+$'
		THEN to_timestamp(("data"->'auth'->>'oauth_token_expires_at')::bigint / 1000.0)
		ELSE NULL
	END,
	"data"->'auth'->>'oauth_refresh_token',
	"data"->'auth'->>'oauth_client_id',
	"data"->'auth'->>'oauth_client_secret',
	NOW()
FROM "mcp_servers"
WHERE "data"->'auth'->>'type' = 'oauth'
	AND "data"->'auth'->>'oauth_mode' = 'shared'
	AND "data"->'auth'->>'oauth_access_token' IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Strip runtime token fields from mcp_servers.data.auth.
-- Leave oauth_client_id/oauth_client_secret in place — admin-entered
-- pre-registered credentials are configuration, not grant artifacts.
UPDATE "mcp_servers"
SET "data" = (("data"::jsonb)
	#- '{auth,oauth_access_token}'
	#- '{auth,oauth_token_expires_at}'
	#- '{auth,oauth_refresh_token}')::json
WHERE "data"->'auth'->>'type' = 'oauth';
