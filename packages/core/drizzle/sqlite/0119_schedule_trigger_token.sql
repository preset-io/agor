ALTER TABLE `schedules` ADD `trigger_token_hash` text;
--> statement-breakpoint
ALTER TABLE `schedules` ADD `trigger_token_created_at` integer;
--> statement-breakpoint
ALTER TABLE `schedules` ADD `last_triggered_at` integer;
--> statement-breakpoint
ALTER TABLE `schedules` ADD `trigger_pending_at` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `schedules_trigger_token_hash_unique` ON `schedules` (`trigger_token_hash`);
--> statement-breakpoint
CREATE INDEX `schedules_trigger_pending_idx` ON `schedules` (`trigger_pending_at`) WHERE "schedules"."trigger_pending_at" IS NOT NULL;
