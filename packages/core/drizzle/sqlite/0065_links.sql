CREATE TABLE `links` (
	`link_id` text(36) PRIMARY KEY NOT NULL,
	`branch_id` text(36),
	`session_id` text(36),
	`source_message_id` text(36),
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`url` text,
	`ref_uri` text,
	`file_path` text,
	`target_key` text NOT NULL,
	`title` text,
	`mime_type` text,
	`metadata` text,
	`created_by` text(36),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `links_branch_id_idx` ON `links` (`branch_id`);--> statement-breakpoint
CREATE INDEX `links_session_id_idx` ON `links` (`session_id`);--> statement-breakpoint
CREATE INDEX `links_source_message_id_idx` ON `links` (`source_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `links_branch_target_idx` ON `links` (`branch_id`,`target_key`) WHERE `links`.`branch_id` is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `links_session_target_idx` ON `links` (`session_id`,`target_key`) WHERE `links`.`session_id` is not null;
