PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_artifacts` (
	`artifact_id` text(36) PRIMARY KEY NOT NULL,
	`worktree_id` text(36),
	`board_id` text(36) NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`path` text,
	`template` text DEFAULT 'react' NOT NULL,
	`build_status` text DEFAULT 'unknown' NOT NULL,
	`build_errors` text,
	`content_hash` text,
	`files` text,
	`dependencies` text,
	`entry` text,
	`use_local_bundler` integer DEFAULT false NOT NULL,
	`public` integer DEFAULT true NOT NULL,
	`created_by` text(36),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_artifacts`("artifact_id", "worktree_id", "board_id", "name", "description", "path", "template", "build_status", "build_errors", "content_hash", "created_by", "created_at", "updated_at", "archived", "archived_at") SELECT "artifact_id", "worktree_id", "board_id", "name", "description", "path", "template", "build_status", "build_errors", "content_hash", "created_by", "created_at", "updated_at", "archived", "archived_at" FROM `artifacts`;--> statement-breakpoint
DROP TABLE `artifacts`;--> statement-breakpoint
ALTER TABLE `__new_artifacts` RENAME TO `artifacts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `artifacts_worktree_idx` ON `artifacts` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `artifacts_board_idx` ON `artifacts` (`board_id`);--> statement-breakpoint
CREATE INDEX `artifacts_archived_idx` ON `artifacts` (`archived`);--> statement-breakpoint
CREATE INDEX `artifacts_public_idx` ON `artifacts` (`public`);