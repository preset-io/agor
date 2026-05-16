CREATE TABLE `notifications` (
	`notification_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`recipient_user_id` text(36) NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`preview` text,
	`link_url` text,
	`source_session_id` text(36),
	`source_worktree_id` text(36),
	`source_board_id` text(36),
	`source_comment_id` text(36),
	`source_task_id` text(36),
	`source_user_id` text(36),
	`read_at` integer,
	`expires_at` integer,
	`scope` text DEFAULT 'user' NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_comment_id`) REFERENCES `board_comments`(`comment_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `notifications_recipient_created_idx` ON `notifications` (`recipient_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_read_idx` ON `notifications` (`recipient_user_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_source_type_idx` ON `notifications` (`recipient_user_id`,`source_session_id`,`type`);--> statement-breakpoint
CREATE INDEX `notifications_source_session_idx` ON `notifications` (`source_session_id`);--> statement-breakpoint
CREATE INDEX `notifications_source_worktree_idx` ON `notifications` (`source_worktree_id`);
