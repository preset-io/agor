-- MCP OAuth Token Refresh — consolidate shared + per-user OAuth tokens
--
-- 1. Rebuild `user_mcp_oauth_tokens` with:
--      - `user_id` NULLABLE (NULL = shared-mode token for that mcp_server_id)
--      - new columns `oauth_client_id`, `oauth_client_secret` (co-located
--        with the refresh_token because the refresh grant is bound to the
--        client credentials it was issued under, especially for DCR).
--    Preserves all existing per-user rows.
--
-- 2. Backfill shared-mode tokens from `mcp_servers.data.auth.*` into the
--    same table with `user_id = NULL`.
--
-- 3. Strip runtime token fields from `mcp_servers.data.auth`
--    (access/refresh/expiry). Leaves config fields (token_url,
--    authorization_url, pre-registered client_id/secret, scope, mode)
--    intact so admin-entered credentials still work.

PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `__new_user_mcp_oauth_tokens` (
	`user_id` text(36),
	`mcp_server_id` text(36) NOT NULL,
	`oauth_access_token` text NOT NULL,
	`oauth_token_expires_at` integer,
	`oauth_refresh_token` text,
	`oauth_client_id` text,
	`oauth_client_secret` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`mcp_server_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

-- Dedupe on the way in: the previous schema had a non-unique index on
-- (user_id, mcp_server_id) and writes were check-then-insert, so duplicates
-- are possible in pre-migration data. Keep the most-recently-touched row
-- per key (coalesce(updated_at, created_at), newest wins).
INSERT INTO `__new_user_mcp_oauth_tokens` (
	`user_id`, `mcp_server_id`, `oauth_access_token`, `oauth_token_expires_at`,
	`oauth_refresh_token`, `created_at`, `updated_at`
)
SELECT
	`user_id`, `mcp_server_id`, `oauth_access_token`, `oauth_token_expires_at`,
	`oauth_refresh_token`, `created_at`, `updated_at`
FROM (
	SELECT
		`user_id`, `mcp_server_id`, `oauth_access_token`, `oauth_token_expires_at`,
		`oauth_refresh_token`, `created_at`, `updated_at`,
		ROW_NUMBER() OVER (
			PARTITION BY `user_id`, `mcp_server_id`
			ORDER BY COALESCE(`updated_at`, `created_at`) DESC, `created_at` DESC
		) AS rn
	FROM `user_mcp_oauth_tokens`
) WHERE rn = 1;
--> statement-breakpoint

DROP TABLE `user_mcp_oauth_tokens`;
--> statement-breakpoint
ALTER TABLE `__new_user_mcp_oauth_tokens` RENAME TO `user_mcp_oauth_tokens`;
--> statement-breakpoint

PRAGMA foreign_keys=ON;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `user_mcp_oauth_tokens_pk` ON `user_mcp_oauth_tokens` (`user_id`,`mcp_server_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_mcp_oauth_tokens_user_idx` ON `user_mcp_oauth_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_mcp_oauth_tokens_server_idx` ON `user_mcp_oauth_tokens` (`mcp_server_id`);--> statement-breakpoint

-- Enforce one token per (user, server) for per-user rows, and one shared row per server.
CREATE UNIQUE INDEX IF NOT EXISTS `user_mcp_oauth_tokens_user_server_uq`
	ON `user_mcp_oauth_tokens` (`user_id`, `mcp_server_id`)
	WHERE `user_id` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `user_mcp_oauth_tokens_shared_server_uq`
	ON `user_mcp_oauth_tokens` (`mcp_server_id`)
	WHERE `user_id` IS NULL;--> statement-breakpoint

-- Backfill shared-mode tokens.
INSERT OR IGNORE INTO `user_mcp_oauth_tokens` (
	`user_id`, `mcp_server_id`, `oauth_access_token`, `oauth_token_expires_at`,
	`oauth_refresh_token`, `oauth_client_id`, `oauth_client_secret`,
	`created_at`, `updated_at`
)
SELECT
	NULL,
	`mcp_server_id`,
	json_extract(`data`, '$.auth.oauth_access_token'),
	json_extract(`data`, '$.auth.oauth_token_expires_at'),
	json_extract(`data`, '$.auth.oauth_refresh_token'),
	json_extract(`data`, '$.auth.oauth_client_id'),
	json_extract(`data`, '$.auth.oauth_client_secret'),
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `mcp_servers`
WHERE json_extract(`data`, '$.auth.type') = 'oauth'
	AND json_extract(`data`, '$.auth.oauth_mode') = 'shared'
	AND json_extract(`data`, '$.auth.oauth_access_token') IS NOT NULL;--> statement-breakpoint

-- Strip runtime token fields from mcp_servers.data.auth.
-- Leave oauth_client_id/oauth_client_secret in place — admin-entered
-- pre-registered credentials are configuration, not grant artifacts.
UPDATE `mcp_servers`
SET `data` = json_remove(
	`data`,
	'$.auth.oauth_access_token',
	'$.auth.oauth_token_expires_at',
	'$.auth.oauth_refresh_token'
)
WHERE json_extract(`data`, '$.auth.type') = 'oauth';
