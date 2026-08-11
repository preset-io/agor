ALTER TABLE `gateway_channels` ADD `listener_claim_token` text;
--> statement-breakpoint
ALTER TABLE `gateway_channels` ADD `listener_claimed_at` integer;
--> statement-breakpoint
ALTER TABLE `gateway_channels` ADD `listener_lease_expires_at` integer;
--> statement-breakpoint
ALTER TABLE `gateway_channels` ADD `listener_instance_id` text;
--> statement-breakpoint
ALTER TABLE `gateway_channels` ADD `listener_boot_id` text;
--> statement-breakpoint
ALTER TABLE `gateway_channels` ADD `listener_generation` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `gateway_channels` ADD `listener_checkpoint` text;
--> statement-breakpoint
ALTER TABLE `gateway_channels` ADD `listener_checkpoint_updated_at` integer;
--> statement-breakpoint
CREATE INDEX `gateway_channels_listener_lease_idx` ON `gateway_channels` (`enabled`,`listener_lease_expires_at`,`id`);
--> statement-breakpoint
CREATE TABLE `gateway_inbound_events` (
  `id` text PRIMARY KEY NOT NULL,
  `gateway_channel_id` text NOT NULL REFERENCES `gateway_channels`(`id`) ON DELETE CASCADE,
  `provider_event_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `delivery_metadata` text,
  `status` text NOT NULL,
  `processing_token` text NOT NULL,
  `processing_expires_at` integer NOT NULL,
  `session_id` text REFERENCES `sessions`(`session_id`) ON DELETE SET NULL,
  `task_id` text REFERENCES `tasks`(`task_id`) ON DELETE SET NULL,
  `received_at` integer NOT NULL,
  `completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_inbound_events_provider_unique` ON `gateway_inbound_events` (`gateway_channel_id`,`provider_event_id`);
--> statement-breakpoint
CREATE INDEX `gateway_inbound_events_recovery_idx` ON `gateway_inbound_events` (`status`,`processing_expires_at`,`id`);
