-- Offline cutover: historical shared consenters are unknowable. Retire those
-- local grants; current authorized users must consent again. Per-user grants
-- retain all token, binding, refresh and timestamp values. No provider revocation.
-- SQLite has one tenant per database; all three FKs bind to that database.
CREATE TABLE `__new_user_mcp_oauth_tokens` (
  `user_id` text(36),
  `mcp_server_id` text(36) NOT NULL,
  `oauth_access_token` text NOT NULL,
  `oauth_token_expires_at` integer,
  `oauth_refresh_token` text,
  `oauth_client_id` text,
  `oauth_client_secret` text,
  `grant_generation` integer DEFAULT 0 NOT NULL,
  `grant_binding_version` integer,
  `grant_binding_fingerprint` text,
  `oauth_metadata_uri` text,
  `oauth_resource_uri` text,
  `oauth_issuer` text,
  `oauth_authorization_endpoint` text,
  `oauth_token_endpoint` text,
  `oauth_redirect_uri` text,
  `refresh_status` text DEFAULT 'idle' NOT NULL,
  `refresh_generation` integer DEFAULT 0 NOT NULL,
  `refresh_success_generation` integer DEFAULT 0 NOT NULL,
  `refresh_claim_id` text,
  `refresh_claimed_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer,
  `granted_by_user_id` text(36) NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE,
  FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`mcp_server_id`) ON DELETE CASCADE,
  FOREIGN KEY (`granted_by_user_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE,
  CONSTRAINT `user_mcp_oauth_tokens_consenter_subject_check`
    CHECK (`user_id` IS NULL OR `user_id` = `granted_by_user_id`)
);
--> statement-breakpoint
INSERT INTO `__new_user_mcp_oauth_tokens` (`user_id`, `mcp_server_id`, `oauth_access_token`, `oauth_token_expires_at`, `oauth_refresh_token`, `oauth_client_id`, `oauth_client_secret`, `grant_generation`, `grant_binding_version`, `grant_binding_fingerprint`, `oauth_metadata_uri`, `oauth_resource_uri`, `oauth_issuer`, `oauth_authorization_endpoint`, `oauth_token_endpoint`, `oauth_redirect_uri`, `refresh_status`, `refresh_generation`, `refresh_success_generation`, `refresh_claim_id`, `refresh_claimed_at`, `created_at`, `updated_at`, `granted_by_user_id`)
SELECT `user_id`, `mcp_server_id`, `oauth_access_token`, `oauth_token_expires_at`, `oauth_refresh_token`, `oauth_client_id`, `oauth_client_secret`, `grant_generation`, `grant_binding_version`, `grant_binding_fingerprint`, `oauth_metadata_uri`, `oauth_resource_uri`, `oauth_issuer`, `oauth_authorization_endpoint`, `oauth_token_endpoint`, `oauth_redirect_uri`, `refresh_status`, `refresh_generation`, `refresh_success_generation`, `refresh_claim_id`, `refresh_claimed_at`, `created_at`, `updated_at`, `user_id` FROM `user_mcp_oauth_tokens`
WHERE `user_id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `user_mcp_oauth_tokens`;
--> statement-breakpoint
ALTER TABLE `__new_user_mcp_oauth_tokens` RENAME TO `user_mcp_oauth_tokens`;
--> statement-breakpoint
CREATE INDEX `user_mcp_oauth_tokens_pk` ON `user_mcp_oauth_tokens` (`user_id`, `mcp_server_id`);
--> statement-breakpoint
CREATE INDEX `user_mcp_oauth_tokens_user_idx` ON `user_mcp_oauth_tokens` (`user_id`);
--> statement-breakpoint
CREATE INDEX `user_mcp_oauth_tokens_server_idx` ON `user_mcp_oauth_tokens` (`mcp_server_id`);
--> statement-breakpoint
CREATE INDEX `user_mcp_oauth_tokens_granted_by_idx` ON `user_mcp_oauth_tokens` (`granted_by_user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_mcp_oauth_tokens_user_server_uq`
  ON `user_mcp_oauth_tokens` (`user_id`, `mcp_server_id`) WHERE `user_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `user_mcp_oauth_tokens_shared_server_uq`
  ON `user_mcp_oauth_tokens` (`mcp_server_id`) WHERE `user_id` IS NULL;
