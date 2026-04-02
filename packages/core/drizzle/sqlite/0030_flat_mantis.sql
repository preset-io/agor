ALTER TABLE `boards` ADD `archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `boards` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `boards` ADD `archived_by` text(36);