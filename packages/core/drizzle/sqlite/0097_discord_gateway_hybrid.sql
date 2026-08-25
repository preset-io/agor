PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_gateway_channels` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text(36) NOT NULL,
	`name` text NOT NULL,
	`channel_type` text NOT NULL,
	`target_branch_id` text(36) NOT NULL,
	`agor_user_id` text(36),
	`provider_installation_id` text,
	`provider_config_generation` integer DEFAULT 1 NOT NULL,
	`channel_key` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_message_at` integer,
	`config` text NOT NULL,
	`agentic_config` text,
	`agentic_tool_preset_id` text(36),
	`mcp_server_ids` text,
	`listener_claim_token` text,
	`listener_claimed_at` integer,
	`listener_lease_expires_at` integer,
	`listener_instance_id` text,
	`listener_boot_id` text,
	`listener_generation` integer DEFAULT 0 NOT NULL,
	`listener_checkpoint` text,
	`listener_checkpoint_updated_at` integer,
	FOREIGN KEY (`target_branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agentic_tool_preset_id`) REFERENCES `agentic_tool_presets`(`preset_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_gateway_channels`("id", "created_at", "updated_at", "created_by", "name", "channel_type", "target_branch_id", "agor_user_id", "provider_installation_id", "provider_config_generation", "channel_key", "enabled", "last_message_at", "config", "agentic_config", "agentic_tool_preset_id", "mcp_server_ids", "listener_claim_token", "listener_claimed_at", "listener_lease_expires_at", "listener_instance_id", "listener_boot_id", "listener_generation", "listener_checkpoint", "listener_checkpoint_updated_at") SELECT "id", "created_at", "updated_at", "created_by", "name", "channel_type", "target_branch_id", "agor_user_id", NULL, 1, "channel_key", "enabled", "last_message_at", "config", "agentic_config", "agentic_tool_preset_id", "mcp_server_ids", "listener_claim_token", "listener_claimed_at", "listener_lease_expires_at", "listener_instance_id", "listener_boot_id", "listener_generation", "listener_checkpoint", "listener_checkpoint_updated_at" FROM `gateway_channels`;--> statement-breakpoint
DROP TABLE `gateway_channels`;--> statement-breakpoint
ALTER TABLE `__new_gateway_channels` RENAME TO `gateway_channels`;--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_channels_channel_key_unique` ON `gateway_channels` (`channel_key`);--> statement-breakpoint
CREATE INDEX `idx_gateway_channel_key` ON `gateway_channels` (`channel_key`);--> statement-breakpoint
CREATE INDEX `gateway_channels_agentic_tool_preset_idx` ON `gateway_channels` (`agentic_tool_preset_id`);--> statement-breakpoint
CREATE INDEX `idx_gateway_enabled_type` ON `gateway_channels` (`enabled`,`channel_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_channels_discord_installation_unique` ON `gateway_channels` (`channel_type`,`provider_installation_id`) WHERE "gateway_channels"."channel_type" = 'discord' AND "gateway_channels"."enabled" = 1 AND "gateway_channels"."provider_installation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `gateway_channels_listener_lease_idx` ON `gateway_channels` (`enabled`,`listener_lease_expires_at`,`id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;

--> statement-breakpoint
ALTER TABLE `thread_session_map` ADD `discord_last_admitted_message_id` text;
--> statement-breakpoint
CREATE TABLE `discord_message_deliveries` (
	`delivery_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`message_id` text(36) NOT NULL,
	`gateway_channel_id` text(36) NOT NULL,
	`thread_session_map_id` text(36) NOT NULL,
	`provider_installation_id` text NOT NULL,
	`provider_config_generation` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`claim_token` text,
	`claim_expires_at` integer,
	`claim_generation` integer DEFAULT 0 NOT NULL,
	`ambiguous_chunk_index` integer,
	`effect_started_at` integer,
	`effect_recovery_grace_until` integer,
	`chunk_receipts` text NOT NULL,
	`reply_aliases` text NOT NULL,
	`last_error_code` text,
	`completed_at` integer,
	`canceled_at` integer,
	`dead_lettered_at` integer,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`gateway_channel_id`) REFERENCES `gateway_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_session_map_id`) REFERENCES `thread_session_map`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discord_message_deliveries_message_unique` ON `discord_message_deliveries` (`message_id`);--> statement-breakpoint
CREATE INDEX `discord_message_deliveries_due_idx` ON `discord_message_deliveries` (`status`,`next_attempt_at`,`delivery_id`);--> statement-breakpoint
CREATE INDEX `discord_message_deliveries_claim_idx` ON `discord_message_deliveries` (`status`,`claim_expires_at`,`delivery_id`);
