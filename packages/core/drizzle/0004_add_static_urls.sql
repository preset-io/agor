-- Migration 0004: Add environment/URL fields to worktrees
-- Uses SQLite table recreation pattern for idempotency (works even if columns exist)
-- This is the standard SQLite approach since ALTER TABLE doesn't support IF NOT EXISTS
--
-- When we add Postgres support, we can use dialect detection:
-- Postgres: ALTER TABLE ADD COLUMN IF NOT EXISTS (native support)
-- SQLite: Table recreation (as below)

PRAGMA foreign_keys=OFF;--> statement-breakpoint

-- Create new table with all columns through migration 0004
-- (includes baseline from 0000 + schedule fields from 0002 + new environment fields)
CREATE TABLE IF NOT EXISTS `worktrees_new` (
  `worktree_id` text(36) PRIMARY KEY NOT NULL,
  `repo_id` text(36) NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer,
  `created_by` text(36) DEFAULT 'anonymous' NOT NULL,
  `name` text NOT NULL,
  `ref` text NOT NULL,
  `worktree_unique_id` integer NOT NULL,
  `board_id` text(36),
  `data` text NOT NULL,
  `schedule_enabled` integer DEFAULT false NOT NULL,
  `schedule_cron` text,
  `schedule_last_triggered_at` integer,
  `schedule_next_run_at` integer,
  `start_command` text,
  `stop_command` text,
  `health_check_url` text,
  `app_url` text,
  `logs_command` text,
  FOREIGN KEY (`repo_id`) REFERENCES `repos`(`repo_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint

-- Copy all existing data (only copy columns we know exist from 0000+0002)
-- New columns (start_command, stop_command, etc.) will be NULL in new table
INSERT INTO `worktrees_new` (
  worktree_id, repo_id, created_at, updated_at, created_by,
  name, ref, worktree_unique_id, board_id, data,
  schedule_enabled, schedule_cron, schedule_last_triggered_at, schedule_next_run_at
)
SELECT
  worktree_id, repo_id, created_at, updated_at, created_by,
  name, ref, worktree_unique_id, board_id, data,
  schedule_enabled, schedule_cron, schedule_last_triggered_at, schedule_next_run_at
FROM `worktrees`;--> statement-breakpoint

DROP TABLE `worktrees`;--> statement-breakpoint
ALTER TABLE `worktrees_new` RENAME TO `worktrees`;--> statement-breakpoint

PRAGMA foreign_keys=ON;--> statement-breakpoint

-- Recreate all indexes (from 0000 + 0002)
CREATE INDEX `worktrees_repo_idx` ON `worktrees` (`repo_id`);--> statement-breakpoint
CREATE INDEX `worktrees_name_idx` ON `worktrees` (`name`);--> statement-breakpoint
CREATE INDEX `worktrees_ref_idx` ON `worktrees` (`ref`);--> statement-breakpoint
CREATE INDEX `worktrees_board_idx` ON `worktrees` (`board_id`);--> statement-breakpoint
CREATE INDEX `worktrees_created_idx` ON `worktrees` (`created_at`);--> statement-breakpoint
CREATE INDEX `worktrees_updated_idx` ON `worktrees` (`updated_at`);--> statement-breakpoint
CREATE INDEX `worktrees_repo_name_unique` ON `worktrees` (`repo_id`,`name`);--> statement-breakpoint
CREATE INDEX `worktrees_schedule_enabled_idx` ON `worktrees` (`schedule_enabled`);--> statement-breakpoint
CREATE INDEX `worktrees_board_schedule_idx` ON `worktrees` (`board_id`,`schedule_enabled`);
