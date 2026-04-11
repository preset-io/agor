-- Add 'session' to the others_can CHECK constraint
-- PR #951 added the 'session' permission tier to TypeScript types but
-- did not update the SQLite CHECK constraint from migration 0016.
-- SQLite requires table recreation to modify CHECK constraints on existing columns.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_worktrees` (
	`worktree_id` text(36) PRIMARY KEY NOT NULL,
	`repo_id` text(36) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`created_by` text NOT NULL DEFAULT 'anonymous',
	`name` text NOT NULL,
	`ref` text NOT NULL,
	`ref_type` text,
	`worktree_unique_id` integer NOT NULL,
	`start_command` text,
	`stop_command` text,
	`nuke_command` text,
	`health_check_url` text,
	`app_url` text,
	`logs_command` text,
	`board_id` text(36),
	`schedule_enabled` integer DEFAULT false NOT NULL,
	`schedule_cron` text,
	`schedule_last_triggered_at` integer,
	`schedule_next_run_at` integer,
	`needs_attention` integer DEFAULT true NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`archived_by` text(36),
	`filesystem_status` text,
	`others_can` text DEFAULT 'view' CHECK(`others_can` IN ('none', 'view', 'session', 'prompt', 'all')),
	`unix_group` text,
	`others_fs_access` text DEFAULT 'read' CHECK(`others_fs_access` IN ('none', 'read', 'write')),
	`data` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`repo_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_worktrees` (
	`worktree_id`, `repo_id`, `created_at`, `updated_at`, `created_by`,
	`name`, `ref`, `ref_type`, `worktree_unique_id`,
	`start_command`, `stop_command`, `nuke_command`,
	`health_check_url`, `app_url`, `logs_command`,
	`board_id`, `schedule_enabled`, `schedule_cron`,
	`schedule_last_triggered_at`, `schedule_next_run_at`,
	`needs_attention`, `archived`, `archived_at`, `archived_by`,
	`filesystem_status`, `others_can`, `unix_group`, `others_fs_access`, `data`
)
SELECT
	`worktree_id`, `repo_id`, `created_at`, `updated_at`, `created_by`,
	`name`, `ref`, `ref_type`, `worktree_unique_id`,
	`start_command`, `stop_command`, `nuke_command`,
	`health_check_url`, `app_url`, `logs_command`,
	`board_id`, `schedule_enabled`, `schedule_cron`,
	`schedule_last_triggered_at`, `schedule_next_run_at`,
	`needs_attention`, `archived`, `archived_at`, `archived_by`,
	`filesystem_status`, `others_can`, `unix_group`, `others_fs_access`, `data`
FROM `worktrees`;--> statement-breakpoint
DROP TABLE `worktrees`;--> statement-breakpoint
ALTER TABLE `__new_worktrees` RENAME TO `worktrees`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- Recreate indexes
CREATE INDEX IF NOT EXISTS `worktrees_repo_idx` ON `worktrees` (`repo_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worktrees_name_idx` ON `worktrees` (`name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worktrees_ref_idx` ON `worktrees` (`ref`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worktrees_board_idx` ON `worktrees` (`board_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worktrees_created_idx` ON `worktrees` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worktrees_updated_idx` ON `worktrees` (`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worktrees_repo_name_unique` ON `worktrees` (`repo_id`, `name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worktrees_schedule_enabled_idx` ON `worktrees` (`schedule_enabled`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worktrees_board_schedule_idx` ON `worktrees` (`board_id`, `schedule_enabled`);
