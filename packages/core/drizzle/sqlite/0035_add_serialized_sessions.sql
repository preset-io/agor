-- Add session_md5 column to tasks table
ALTER TABLE `tasks` ADD COLUMN `session_md5` text;--> statement-breakpoint

-- Create serialized_sessions table for stateless_fs_mode
CREATE TABLE `serialized_sessions` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`session_id` text(36) NOT NULL,
	`worktree_id` text(36) NOT NULL,
	`task_id` text(36),
	`turn_index` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL,
	`md5` text NOT NULL,
	`status` text NOT NULL,
	`payload` blob,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint

-- Create indexes
CREATE INDEX IF NOT EXISTS `serialized_sessions_session_turn_idx` ON `serialized_sessions` (`session_id`, `turn_index`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `serialized_sessions_worktree_idx` ON `serialized_sessions` (`worktree_id`);
