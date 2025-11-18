-- Migration 0009: Reconcile missing columns from migrations 0006-0008
-- This migration is idempotent using SQLite's table recreation pattern.
-- It safely adds columns even if they already exist.
--
-- Context: Migrations 0006 and 0007 were removed from the journal to resolve
-- a hash mismatch issue with migration 0004. This migration consolidates their
-- changes along with 0008.

PRAGMA foreign_keys=OFF;--> statement-breakpoint

-- Add ready_for_prompt to sessions (from 0006)
-- Recreate sessions table with new column
CREATE TABLE `sessions_new` (
  `session_id` text(36) PRIMARY KEY NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer,
  `created_by` text(36) DEFAULT 'anonymous' NOT NULL,
  `status` text NOT NULL,
  `agentic_tool` text NOT NULL,
  `board_id` text(36),
  `parent_session_id` text(36),
  `forked_from_session_id` text(36),
  `worktree_id` text(36) NOT NULL,
  `scheduled_run_at` integer,
  `scheduled_from_worktree` integer DEFAULT false NOT NULL,
  `ready_for_prompt` integer DEFAULT 0 NOT NULL,
  `data` text NOT NULL,
  FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`forked_from_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint

-- Copy data (columns known to exist before this migration)
INSERT INTO `sessions_new` (
  session_id, created_at, updated_at, created_by, status, agentic_tool,
  board_id, parent_session_id, forked_from_session_id, worktree_id,
  scheduled_run_at, scheduled_from_worktree, data
)
SELECT
  session_id, created_at, updated_at, created_by, status, agentic_tool,
  board_id, parent_session_id, forked_from_session_id, worktree_id,
  scheduled_run_at, scheduled_from_worktree, data
FROM `sessions`;--> statement-breakpoint

DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `sessions_new` RENAME TO `sessions`;--> statement-breakpoint

-- Recreate indexes
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);--> statement-breakpoint
CREATE INDEX `sessions_worktree_idx` ON `sessions` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `sessions_board_idx` ON `sessions` (`board_id`);--> statement-breakpoint
CREATE INDEX `sessions_created_idx` ON `sessions` (`created_at`);--> statement-breakpoint
CREATE INDEX `sessions_parent_idx` ON `sessions` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `sessions_forked_from_idx` ON `sessions` (`forked_from_session_id`);--> statement-breakpoint

-- Add needs_attention to worktrees (from 0007)
-- Recreate worktrees table with new column
CREATE TABLE `worktrees_new` (
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
  `needs_attention` integer DEFAULT 0 NOT NULL,
  FOREIGN KEY (`repo_id`) REFERENCES `repos`(`repo_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint

-- Copy data (columns known to exist before this migration)
INSERT INTO `worktrees_new` (
  worktree_id, repo_id, created_at, updated_at, created_by, name, ref,
  worktree_unique_id, board_id, data, schedule_enabled, schedule_cron,
  schedule_last_triggered_at, schedule_next_run_at, start_command,
  stop_command, health_check_url, app_url, logs_command
)
SELECT
  worktree_id, repo_id, created_at, updated_at, created_by, name, ref,
  worktree_unique_id, board_id, data, schedule_enabled, schedule_cron,
  schedule_last_triggered_at, schedule_next_run_at, start_command,
  stop_command, health_check_url, app_url, logs_command
FROM `worktrees`;--> statement-breakpoint

DROP TABLE `worktrees`;--> statement-breakpoint
ALTER TABLE `worktrees_new` RENAME TO `worktrees`;--> statement-breakpoint

-- Recreate indexes
CREATE INDEX `worktrees_repo_idx` ON `worktrees` (`repo_id`);--> statement-breakpoint
CREATE INDEX `worktrees_name_idx` ON `worktrees` (`name`);--> statement-breakpoint
CREATE INDEX `worktrees_ref_idx` ON `worktrees` (`ref`);--> statement-breakpoint
CREATE INDEX `worktrees_board_idx` ON `worktrees` (`board_id`);--> statement-breakpoint
CREATE INDEX `worktrees_created_idx` ON `worktrees` (`created_at`);--> statement-breakpoint
CREATE INDEX `worktrees_updated_idx` ON `worktrees` (`updated_at`);--> statement-breakpoint
CREATE INDEX `worktrees_repo_name_unique` ON `worktrees` (`repo_id`,`name`);--> statement-breakpoint
CREATE INDEX `worktrees_schedule_enabled_idx` ON `worktrees` (`schedule_enabled`);--> statement-breakpoint
CREATE INDEX `worktrees_board_schedule_idx` ON `worktrees` (`board_id`,`schedule_enabled`);--> statement-breakpoint

PRAGMA foreign_keys=ON;
