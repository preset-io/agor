CREATE TABLE `session_relationships` (
	`relationship_id` text(36) PRIMARY KEY NOT NULL,
	`source_session_id` text(36) NOT NULL,
	`target_session_id` text(36) NOT NULL,
	`relationship_type` text NOT NULL,
	`created_by` text(36) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`callback_enabled` integer DEFAULT false NOT NULL,
	`callback_session_id` text(36),
	`data` text,
	FOREIGN KEY (`source_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`callback_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `session_relationships_source_idx` ON `session_relationships` (`source_session_id`);
--> statement-breakpoint
CREATE INDEX `session_relationships_target_idx` ON `session_relationships` (`target_session_id`);
--> statement-breakpoint
CREATE INDEX `session_relationships_callback_idx` ON `session_relationships` (`callback_session_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_relationships_source_target_type_unique` ON `session_relationships` (`source_session_id`,`target_session_id`,`relationship_type`);
