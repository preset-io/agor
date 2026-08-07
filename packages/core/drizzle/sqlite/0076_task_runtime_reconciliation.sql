ALTER TABLE `tasks` ADD `termination_coordination_token` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `dispatch_timeout_observed_at` integer;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `termination_coordination_claimed_at` integer;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `termination_coordination_expires_at` integer;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `termination_coordination_instance_id` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `termination_coordination_boot_id` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `termination_unverified_at` integer;
--> statement-breakpoint
UPDATE `tasks`
SET `termination_unverified_at` = CAST(strftime('%s', 'now') AS integer) * 1000
WHERE `status` = 'stopping'
  AND json_extract(`data`, '$.sdk_failure.termination') = 'unverified';
--> statement-breakpoint
CREATE INDEX `tasks_runtime_dispatch_idx` ON `tasks` (`started_at`, `task_id`)
  WHERE `status` = 'dispatching' AND `executor_connected_at` IS NULL
    AND `started_at` IS NOT NULL AND `dispatch_timeout_observed_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `tasks_runtime_heartbeat_idx` ON `tasks` (`last_executor_heartbeat_at`, `task_id`)
  WHERE `status` IN ('running', 'awaiting_permission', 'awaiting_input')
    AND `last_executor_heartbeat_at` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `tasks_runtime_termination_idx` ON `tasks` (`termination_coordination_expires_at`, `task_id`)
  WHERE `status` = 'stopping' AND `termination_unverified_at` IS NULL;
