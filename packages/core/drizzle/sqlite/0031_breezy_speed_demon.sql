CREATE TABLE `artifacts` (
	`artifact_id` text(36) PRIMARY KEY NOT NULL,
	`worktree_id` text(36) NOT NULL,
	`board_id` text(36) NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`path` text NOT NULL,
	`template` text DEFAULT 'react' NOT NULL,
	`build_status` text DEFAULT 'unknown' NOT NULL,
	`build_errors` text,
	`content_hash` text,
	`created_by` text(36),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifacts_worktree_idx` ON `artifacts` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `artifacts_board_idx` ON `artifacts` (`board_id`);--> statement-breakpoint
CREATE INDEX `artifacts_archived_idx` ON `artifacts` (`archived`);