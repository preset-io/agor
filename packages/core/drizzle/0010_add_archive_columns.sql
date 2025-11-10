-- Migration 0010: Add archive columns to worktrees and sessions
-- Implements soft delete functionality for data retention and analytics
--
-- Changes:
-- - Add archive state columns to worktrees (archived, archived_at, archived_by, filesystem_status)
-- - Add archive state columns to sessions (archived, archived_reason)
-- - Add indexes for efficient archive filtering

PRAGMA foreign_keys=OFF;--> statement-breakpoint

-- ===== WORKTREES TABLE =====

-- Recreate worktrees table with archive columns
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
  -- Archive columns (new)
  `archived` integer DEFAULT false NOT NULL,
  `archived_at` integer,
  `archived_by` text(36),
  `filesystem_status` text CHECK(`filesystem_status` IN ('preserved', 'cleaned', 'deleted')),
  FOREIGN KEY (`repo_id`) REFERENCES `repos`(`repo_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint

-- Copy existing data (all worktrees start as non-archived)
INSERT INTO `worktrees_new` (
  worktree_id, repo_id, created_at, updated_at, created_by, name, ref,
  worktree_unique_id, board_id, data, schedule_enabled, schedule_cron,
  schedule_last_triggered_at, schedule_next_run_at, start_command,
  stop_command, health_check_url, app_url, logs_command, needs_attention,
  archived
)
SELECT
  worktree_id, repo_id, created_at, updated_at, created_by, name, ref,
  worktree_unique_id, board_id, data, schedule_enabled, schedule_cron,
  schedule_last_triggered_at, schedule_next_run_at, start_command,
  stop_command, health_check_url, app_url, logs_command, needs_attention,
  0 as archived  -- Default: not archived
FROM `worktrees`;--> statement-breakpoint

DROP TABLE `worktrees`;--> statement-breakpoint
ALTER TABLE `worktrees_new` RENAME TO `worktrees`;--> statement-breakpoint

-- Recreate existing indexes
CREATE INDEX `worktrees_repo_idx` ON `worktrees` (`repo_id`);--> statement-breakpoint
CREATE INDEX `worktrees_name_idx` ON `worktrees` (`name`);--> statement-breakpoint
CREATE INDEX `worktrees_ref_idx` ON `worktrees` (`ref`);--> statement-breakpoint
CREATE INDEX `worktrees_board_idx` ON `worktrees` (`board_id`);--> statement-breakpoint
CREATE INDEX `worktrees_created_idx` ON `worktrees` (`created_at`);--> statement-breakpoint
CREATE INDEX `worktrees_updated_idx` ON `worktrees` (`updated_at`);--> statement-breakpoint
CREATE INDEX `worktrees_repo_name_unique` ON `worktrees` (`repo_id`,`name`);--> statement-breakpoint
CREATE INDEX `worktrees_schedule_enabled_idx` ON `worktrees` (`schedule_enabled`);--> statement-breakpoint
CREATE INDEX `worktrees_board_schedule_idx` ON `worktrees` (`board_id`,`schedule_enabled`);--> statement-breakpoint

-- Add new archive index
CREATE INDEX `worktrees_archived_idx` ON `worktrees` (`archived`);--> statement-breakpoint

-- ===== SESSIONS TABLE =====

-- Recreate sessions table with archive columns
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
  -- Archive columns (new)
  `archived` integer DEFAULT false NOT NULL,
  `archived_reason` text CHECK(`archived_reason` IN ('worktree_archived', 'manual')),
  `data` text NOT NULL,
  FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`forked_from_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint

-- Copy existing data (all sessions start as non-archived)
INSERT INTO `sessions_new` (
  session_id, created_at, updated_at, created_by, status, agentic_tool,
  board_id, parent_session_id, forked_from_session_id, worktree_id,
  scheduled_run_at, scheduled_from_worktree, ready_for_prompt,
  archived, data
)
SELECT
  session_id, created_at, updated_at, created_by, status, agentic_tool,
  board_id, parent_session_id, forked_from_session_id, worktree_id,
  scheduled_run_at, scheduled_from_worktree, ready_for_prompt,
  0 as archived,  -- Default: not archived
  data
FROM `sessions`;--> statement-breakpoint

DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `sessions_new` RENAME TO `sessions`;--> statement-breakpoint

-- Recreate existing indexes
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);--> statement-breakpoint
CREATE INDEX `sessions_worktree_idx` ON `sessions` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `sessions_board_idx` ON `sessions` (`board_id`);--> statement-breakpoint
CREATE INDEX `sessions_created_idx` ON `sessions` (`created_at`);--> statement-breakpoint
CREATE INDEX `sessions_parent_idx` ON `sessions` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `sessions_forked_from_idx` ON `sessions` (`forked_from_session_id`);--> statement-breakpoint

-- Add new archive index
CREATE INDEX `sessions_archived_idx` ON `sessions` (`archived`);--> statement-breakpoint

PRAGMA foreign_keys=ON;
