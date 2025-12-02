CREATE TABLE `worktree_owners` (
	`worktree_id` text(36) NOT NULL,
	`user_id` text(36) NOT NULL,
	`created_at` integer DEFAULT (datetime('now')),
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `worktree_owners_pk` ON `worktree_owners` (`worktree_id`,`user_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `unix_username` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `others_can` text DEFAULT 'view';--> statement-breakpoint
ALTER TABLE `worktrees` ADD `unix_group` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `others_fs_access` text DEFAULT 'read';