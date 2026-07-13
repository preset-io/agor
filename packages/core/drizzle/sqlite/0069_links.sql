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
	`target_object_type` text,
	`target_object_id` text(36),
	`target_key` text NOT NULL,
	`is_pinned` integer DEFAULT false NOT NULL,
	`title` text,
	`mime_type` text,
	`metadata` text,
	`created_by` text(36),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `links_owner_xor_check` CHECK (((`branch_id` is not null) and (`session_id` is null)) or ((`branch_id` is null) and (`session_id` is not null))),
	CONSTRAINT `links_target_xor_check` CHECK ((case when `url` is not null and trim(`url`) <> '' then 1 else 0 end + case when `ref_uri` is not null and trim(`ref_uri`) <> '' then 1 else 0 end + case when `file_path` is not null and trim(`file_path`) <> '' then 1 else 0 end) = 1),
	CONSTRAINT `links_target_object_pair_check` CHECK (((`target_object_type` is null) and (`target_object_id` is null)) or ((`target_object_type` is not null) and (`target_object_id` is not null))),
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `links_branch_id_idx` ON `links` (`branch_id`);--> statement-breakpoint
CREATE INDEX `links_session_id_idx` ON `links` (`session_id`);--> statement-breakpoint
CREATE INDEX `links_source_message_id_idx` ON `links` (`source_message_id`);--> statement-breakpoint
CREATE INDEX `links_target_object_idx` ON `links` (`target_object_type`,`target_object_id`);--> statement-breakpoint
CREATE INDEX `links_branch_pinned_idx` ON `links` (`branch_id`,`is_pinned`);--> statement-breakpoint
CREATE INDEX `links_session_pinned_idx` ON `links` (`session_id`,`is_pinned`);--> statement-breakpoint
CREATE UNIQUE INDEX `links_branch_target_idx` ON `links` (`branch_id`,`target_key`) WHERE `links`.`branch_id` is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `links_session_target_idx` ON `links` (`session_id`,`target_key`) WHERE `links`.`session_id` is not null;
