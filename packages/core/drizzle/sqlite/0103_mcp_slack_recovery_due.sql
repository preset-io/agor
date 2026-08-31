ALTER TABLE `tasks` ADD COLUMN `mcp_slack_recovery_due_at` integer;--> statement-breakpoint
CREATE INDEX `tasks_mcp_slack_recovery_due_idx` ON `tasks` (`mcp_slack_recovery_due_at`,`task_id`) WHERE `mcp_slack_recovery_due_at` IS NOT NULL;
