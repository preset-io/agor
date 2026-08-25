ALTER TABLE `sessions` ADD COLUMN `scheduler_init_failure_code` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `scheduler_init_failure_stage` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `scheduler_init_attempt_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `scheduler_init_retry_at` integer;
--> statement-breakpoint
DROP INDEX `sessions_scheduler_init_pending_idx`;
--> statement-breakpoint
CREATE INDEX `sessions_scheduler_init_pending_idx` ON `sessions` (`created_at`,`session_id`) WHERE `sessions`.`scheduled_from_branch` = true AND `sessions`.`scheduled_run_at` IS NOT NULL AND `sessions`.`scheduler_init_completed_at` IS NULL AND (`sessions`.`scheduler_init_failure_code` IS NULL OR `sessions`.`scheduler_init_retry_at` IS NOT NULL);
