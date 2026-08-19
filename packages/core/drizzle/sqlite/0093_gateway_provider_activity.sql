-- SQLite schema parity only. Discord remains gated off for SQLite.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_gateway_provider_actions` (
  `id` text PRIMARY KEY NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `gateway_channel_id` text NOT NULL REFERENCES `gateway_channels`(`id`) ON DELETE CASCADE,
  `channel_type` text NOT NULL,
  `provider_installation_id` text NOT NULL,
  `provider_config_generation` integer NOT NULL,
  `kind` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `thread_session_map_id` text REFERENCES `thread_session_map`(`id`) ON DELETE SET NULL,
  `session_id` text REFERENCES `sessions`(`session_id`) ON DELETE SET NULL,
  `task_id` text REFERENCES `tasks`(`task_id`) ON DELETE SET NULL,
  `message_id` text REFERENCES `messages`(`message_id`) ON DELETE SET NULL,
  `gateway_inbound_event_id` text REFERENCES `gateway_inbound_events`(`id`) ON DELETE SET NULL,
  `params` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `not_before` integer NOT NULL,
  `drop_after` integer,
  `claim_token` text,
  `claim_generation` integer DEFAULT 0 NOT NULL,
  `claim_expires_at` integer,
  `claim_listener_token` text,
  `claim_listener_generation` integer,
  `claim_instance_id` text,
  `claim_boot_id` text,
  `last_error_code` text,
  `result_metadata` text,
  `completed_at` integer,
  `dead_lettered_at` integer,
  `canceled_at` integer,
  CONSTRAINT `gateway_provider_actions_idempotency_key_bounds` CHECK (length(CAST(`idempotency_key` AS BLOB)) BETWEEN 1 AND 200),
  CONSTRAINT `gateway_provider_actions_params_bounds` CHECK (length(CAST(`params` AS BLOB)) <= 512),
  CONSTRAINT `gateway_provider_actions_result_bounds` CHECK (`result_metadata` IS NULL OR length(CAST(`result_metadata` AS BLOB)) <= 256),
  CONSTRAINT `gateway_provider_actions_lifecycle_bounds` CHECK (`provider_config_generation` > 0 AND `attempts` >= 0 AND `claim_generation` >= 0),
  CONSTRAINT `gateway_provider_actions_kind_check` CHECK (`kind` IN ('deliver_message', 'discord_progress')),
  CONSTRAINT `gateway_provider_actions_shape_check` CHECK ((`kind` = 'deliver_message' AND `message_id` IS NOT NULL AND `drop_after` IS NULL) OR (`kind` = 'discord_progress' AND `message_id` IS NULL AND ((json_extract(`params`, '$.state') = 'done' AND `drop_after` IS NULL) OR (json_extract(`params`, '$.state') <> 'done' AND `drop_after` IS NOT NULL)))),
  CONSTRAINT `gateway_provider_actions_status_check` CHECK (`status` IN ('pending', 'processing', 'retry', 'completed', 'dead_letter', 'canceled'))
);
--> statement-breakpoint
INSERT INTO `__new_gateway_provider_actions` (
  `id`, `created_at`, `updated_at`, `gateway_channel_id`, `channel_type`,
  `provider_installation_id`, `provider_config_generation`, `kind`, `idempotency_key`,
  `thread_session_map_id`, `session_id`, `task_id`, `message_id`, `gateway_inbound_event_id`,
  `params`, `status`, `attempts`, `not_before`, `drop_after`, `claim_token`,
  `claim_generation`, `claim_expires_at`, `claim_listener_token`,
  `claim_listener_generation`, `claim_instance_id`, `claim_boot_id`,
  `last_error_code`, `result_metadata`, `completed_at`, `dead_lettered_at`, `canceled_at`
)
SELECT
  `id`, `created_at`, `updated_at`, `gateway_channel_id`, `channel_type`,
  `provider_installation_id`, `provider_config_generation`, `kind`, `idempotency_key`,
  `thread_session_map_id`, `session_id`, `task_id`, `message_id`, `gateway_inbound_event_id`,
  `params`, `status`, `attempts`, `not_before`, NULL, `claim_token`,
  `claim_generation`, `claim_expires_at`, `claim_listener_token`,
  `claim_listener_generation`, `claim_instance_id`, `claim_boot_id`,
  `last_error_code`,
  CASE WHEN `result_metadata` IS NULL THEN NULL ELSE json_set(`result_metadata`, '$.kind', 'deliver_message') END,
  `completed_at`, `dead_lettered_at`, `canceled_at`
FROM `gateway_provider_actions`;
--> statement-breakpoint
DROP TABLE `gateway_provider_actions`;
--> statement-breakpoint
ALTER TABLE `__new_gateway_provider_actions` RENAME TO `gateway_provider_actions`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_provider_actions_channel_generation_key_unique`
  ON `gateway_provider_actions` (`gateway_channel_id`, `provider_config_generation`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX `gateway_provider_actions_backlog_idx`
  ON `gateway_provider_actions` (`gateway_channel_id`, `status`, `not_before`, `id`);
--> statement-breakpoint
CREATE INDEX `gateway_provider_actions_claim_idx`
  ON `gateway_provider_actions` (`gateway_channel_id`, `status`, `claim_expires_at`, `id`);
--> statement-breakpoint
CREATE INDEX `gateway_provider_actions_activity_expiry_idx`
  ON `gateway_provider_actions` (`gateway_channel_id`, `kind`, `drop_after`, `status`);
