CREATE TABLE `tenant_cors_settings` (
	`settings_id` text PRIMARY KEY DEFAULT 'current' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`origins` text NOT NULL,
	`updated_by` text(36),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `tenant_cors_audit_events` (
	`event_id` text(36) PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`added_origins` text NOT NULL,
	`removed_origins` text NOT NULL,
	`actor_user_id` text(36),
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_cors_audit_revision_unique` ON `tenant_cors_audit_events` (`revision`);
--> statement-breakpoint
CREATE INDEX `tenant_cors_audit_created_at_idx` ON `tenant_cors_audit_events` (`created_at`);
