PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_worktree_owners` (
	`worktree_id` text(36) NOT NULL,
	`user_id` text(36) NOT NULL,
	`created_at` integer,
	PRIMARY KEY(`worktree_id`, `user_id`),
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_worktree_owners`("worktree_id", "user_id", "created_at") SELECT "worktree_id", "user_id", "created_at" FROM `worktree_owners`;--> statement-breakpoint
DROP TABLE `worktree_owners`;--> statement-breakpoint
ALTER TABLE `__new_worktree_owners` RENAME TO `worktree_owners`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `users` ADD `must_change_password` integer DEFAULT false NOT NULL;