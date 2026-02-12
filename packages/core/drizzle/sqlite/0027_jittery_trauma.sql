CREATE TABLE IF NOT EXISTS `user_mcp_oauth_tokens` (
	`user_id` text(36) NOT NULL,
	`mcp_server_id` text(36) NOT NULL,
	`oauth_access_token` text NOT NULL,
	`oauth_token_expires_at` integer,
	`oauth_refresh_token` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`mcp_server_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_mcp_oauth_tokens_pk` ON `user_mcp_oauth_tokens` (`user_id`,`mcp_server_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_mcp_oauth_tokens_user_idx` ON `user_mcp_oauth_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_mcp_oauth_tokens_server_idx` ON `user_mcp_oauth_tokens` (`mcp_server_id`);
