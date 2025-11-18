PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_board_comments` (
	`comment_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`board_id` text(36) NOT NULL,
	`created_by` text(36) DEFAULT 'anonymous' NOT NULL,
	`session_id` text(36),
	`task_id` text(36),
	`message_id` text(36),
	`worktree_id` text(36),
	`content` text NOT NULL,
	`content_preview` text NOT NULL,
	`parent_comment_id` text(36),
	`resolved` integer DEFAULT false NOT NULL,
	`edited` integer DEFAULT false NOT NULL,
	`reactions` text DEFAULT '[]' NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_board_comments`("comment_id", "created_at", "updated_at", "board_id", "created_by", "session_id", "task_id", "message_id", "worktree_id", "content", "content_preview", "parent_comment_id", "resolved", "edited", "reactions", "data") SELECT "comment_id", "created_at", "updated_at", "board_id", "created_by", "session_id", "task_id", "message_id", "worktree_id", "content", "content_preview", "parent_comment_id", "resolved", "edited", "reactions", "data" FROM `board_comments`;--> statement-breakpoint
DROP TABLE `board_comments`;--> statement-breakpoint
ALTER TABLE `__new_board_comments` RENAME TO `board_comments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `board_comments_board_idx` ON `board_comments` (`board_id`);--> statement-breakpoint
CREATE INDEX `board_comments_session_idx` ON `board_comments` (`session_id`);--> statement-breakpoint
CREATE INDEX `board_comments_task_idx` ON `board_comments` (`task_id`);--> statement-breakpoint
CREATE INDEX `board_comments_message_idx` ON `board_comments` (`message_id`);--> statement-breakpoint
CREATE INDEX `board_comments_worktree_idx` ON `board_comments` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `board_comments_created_by_idx` ON `board_comments` (`created_by`);--> statement-breakpoint
CREATE INDEX `board_comments_parent_idx` ON `board_comments` (`parent_comment_id`);--> statement-breakpoint
CREATE INDEX `board_comments_created_idx` ON `board_comments` (`created_at`);--> statement-breakpoint
CREATE INDEX `board_comments_resolved_idx` ON `board_comments` (`resolved`);