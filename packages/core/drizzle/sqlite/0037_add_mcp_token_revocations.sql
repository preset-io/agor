-- MCP token hardening: add jti/exp/gen + revocation ledger.
--
-- 1. `sessions.mcp_token_generation` — bump to invalidate all outstanding MCP
--    tokens for a session in one write. Default 0 so existing sessions mint
--    tokens with `gen: 0` (matches any regenerated token for that session).
--
-- 2. `mcp_token_revocations` — primary-key ledger of individually revoked
--    `jti`s. Verification rejects any token whose `jti` is present, even if
--    sig + exp are still valid. Rows can be pruned once `expires_at` passes
--    (the token's own `exp` rejects it).
--
-- No CHECK constraint on `reason`; enum validated at the app layer per
-- `context/concepts/database-migrations.md` guidance.

ALTER TABLE `sessions` ADD `mcp_token_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE TABLE `mcp_token_revocations` (
	`jti` text PRIMARY KEY NOT NULL,
	`session_id` text(36),
	`revoked_at` integer NOT NULL,
	`revoked_by` text,
	`reason` text NOT NULL,
	`expires_at` integer NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `mcp_token_revocations_session_idx` ON `mcp_token_revocations` (`session_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mcp_token_revocations_expires_idx` ON `mcp_token_revocations` (`expires_at`);
