ALTER TABLE `tasks` ADD `runtime_owner_daemon_id` text(36);--> statement-breakpoint
ALTER TABLE `tasks` ADD `runtime_owner_fence` text(36);--> statement-breakpoint
ALTER TABLE `tasks` ADD `runtime_lease_expires_at` integer;
