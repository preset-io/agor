ALTER TABLE `messages` ADD `parent_tool_use_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `scheduled_run_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `scheduled_from_worktree` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `sessions_scheduled_flag_idx` ON `sessions` (`scheduled_from_worktree`);--> statement-breakpoint
ALTER TABLE `worktrees` ADD `schedule_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `schedule_cron` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `schedule_last_triggered_at` integer;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `schedule_next_run_at` integer;--> statement-breakpoint
CREATE INDEX `worktrees_schedule_enabled_idx` ON `worktrees` (`schedule_enabled`);--> statement-breakpoint
CREATE INDEX `worktrees_board_schedule_idx` ON `worktrees` (`board_id`,`schedule_enabled`);