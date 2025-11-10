ALTER TABLE `sessions` ADD `archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `archived_reason` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `archived_by` text(36);--> statement-breakpoint
ALTER TABLE `worktrees` ADD `filesystem_status` text;