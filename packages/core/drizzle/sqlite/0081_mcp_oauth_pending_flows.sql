-- Standalone SQLite retains the process-local MCP OAuth flow state. This
-- schema mirror is intentionally unused at runtime and keeps cross-dialect
-- migration history compatible without changing local behavior.
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `grant_generation` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `grant_binding_version` integer;
--> statement-breakpoint
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `grant_binding_fingerprint` text;
--> statement-breakpoint
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `oauth_metadata_uri` text;
--> statement-breakpoint
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `oauth_resource_uri` text;
--> statement-breakpoint
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `oauth_issuer` text;
--> statement-breakpoint
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `oauth_authorization_endpoint` text;
--> statement-breakpoint
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `oauth_token_endpoint` text;
--> statement-breakpoint
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `oauth_redirect_uri` text;
--> statement-breakpoint
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `refresh_status` text DEFAULT 'idle' NOT NULL;
--> statement-breakpoint
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `refresh_generation` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `refresh_success_generation` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `refresh_claim_id` text;
--> statement-breakpoint
ALTER TABLE `user_mcp_oauth_tokens` ADD COLUMN `refresh_claimed_at` integer;
--> statement-breakpoint
CREATE TABLE `mcp_oauth_pending_flows` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`state_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	`oauth_mode` text NOT NULL,
	`subject_user_id` text,
	`grant_generation` integer NOT NULL,
	`config_fingerprint_version` integer NOT NULL,
	`config_fingerprint` text NOT NULL,
	`envelope_version` integer NOT NULL,
	`is_current` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`sealed_material` text,
	`exchange_claim_id` text,
	`failure_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`exchange_started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`mcp_server_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_oauth_pending_flows_state_hash_unique`
	ON `mcp_oauth_pending_flows` (`state_hash`);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_pending_flows_user_idx`
	ON `mcp_oauth_pending_flows` (`user_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_pending_flows_server_idx`
	ON `mcp_oauth_pending_flows` (`mcp_server_id`);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_pending_flows_grant_idx`
	ON `mcp_oauth_pending_flows` (`mcp_server_id`, `oauth_mode`, `subject_user_id`, `grant_generation`);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_pending_flows_maintenance_idx`
	ON `mcp_oauth_pending_flows` (`status`, `expires_at`, `exchange_started_at`, `finished_at`);
