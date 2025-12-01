-- RBAC: Worktree ownership and permissions
CREATE TABLE IF NOT EXISTS `worktree_owners` (
	`worktree_id` text(36) NOT NULL,
	`user_id` text(36) NOT NULL,
	`created_at` integer DEFAULT (datetime('now')),
	PRIMARY KEY(`worktree_id`, `user_id`),
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `users_unix_username_idx` ON `users` (`unix_username`);
--> statement-breakpoint
ALTER TABLE `worktrees` ADD `others_can` text DEFAULT 'view' CHECK(`others_can` IN ('none', 'view', 'prompt', 'all'));--> statement-breakpoint
ALTER TABLE `worktrees` ADD `unix_group` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `others_fs_access` text DEFAULT 'read' CHECK(`others_fs_access` IN ('none', 'read', 'write'));