-- Teams gateway HA: queue-first ingress, durable conversation addresses, and
-- provider-specific outbound delivery. Existing gateway rows are retained;
-- the nullable payload columns keep Slack/Discord's existing path unchanged.
ALTER TABLE `gateway_inbound_events` ADD `payload_encrypted` text;
--> statement-breakpoint
ALTER TABLE `gateway_inbound_events` ADD `payload_expires_at` integer;
--> statement-breakpoint
ALTER TABLE `gateway_inbound_events` ADD `provider_config_generation` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `gateway_inbound_events` ADD `verified_app_id` text;
--> statement-breakpoint
ALTER TABLE `gateway_inbound_events` ADD `verified_tenant_id` text;
--> statement-breakpoint
ALTER TABLE `gateway_inbound_events` ADD `attempt_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `gateway_inbound_events` ADD `next_attempt_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `gateway_inbound_events` ADD `last_error_code` text;
--> statement-breakpoint
ALTER TABLE `thread_session_map` ADD `teams_last_admitted_activity_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_channels_teams_installation_unique` ON `gateway_channels` (`channel_type`,`provider_installation_id`) WHERE `gateway_channels`.`channel_type` = 'teams' AND `gateway_channels`.`enabled` = 1 AND `gateway_channels`.`provider_installation_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `teams_conversation_addresses` (
	`address_id` text(36) PRIMARY KEY NOT NULL,
	`gateway_channel_id` text(36) NOT NULL,
	`thread_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`root_message_id` text,
	`encrypted_address` text NOT NULL,
	`verified_app_id` text NOT NULL,
	`verified_tenant_id` text NOT NULL,
	`provider_config_generation` integer NOT NULL,
	`refreshed_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`gateway_channel_id`) REFERENCES `gateway_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_conversation_addresses_channel_thread_unique` ON `teams_conversation_addresses` (`gateway_channel_id`,`thread_id`);
--> statement-breakpoint
CREATE INDEX `teams_conversation_addresses_conversation_idx` ON `teams_conversation_addresses` (`gateway_channel_id`,`conversation_id`);
--> statement-breakpoint
CREATE TABLE `teams_message_deliveries` (
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
	`effect_started_at` integer,
	`last_error_code` text,
	`provider_message_id` text,
	`completed_at` integer,
	`canceled_at` integer,
	`dead_lettered_at` integer,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`gateway_channel_id`) REFERENCES `gateway_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_session_map_id`) REFERENCES `thread_session_map`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_message_deliveries_message_map_unique` ON `teams_message_deliveries` (`message_id`,`thread_session_map_id`);
--> statement-breakpoint
CREATE INDEX `teams_message_deliveries_due_idx` ON `teams_message_deliveries` (`status`,`next_attempt_at`,`delivery_id`);
--> statement-breakpoint
CREATE INDEX `teams_message_deliveries_claim_idx` ON `teams_message_deliveries` (`status`,`claim_expires_at`,`delivery_id`);
