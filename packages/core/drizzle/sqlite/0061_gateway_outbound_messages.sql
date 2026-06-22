CREATE TABLE `gateway_outbound_messages` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`gateway_channel_id` text(36) NOT NULL,
	`channel_type` text NOT NULL,
	`platform_channel_id` text NOT NULL,
	`platform_message_id` text NOT NULL,
	`platform_thread_id` text NOT NULL,
	`platform_permalink` text,
	`target_branch_id` text(36) NOT NULL,
	`emitted_by_user_id` text(36) NOT NULL,
	`emitted_by_session_id` text(36),
	`emitted_by_task_id` text(36),
	`emitted_by_schedule_id` text(36),
	`message_text` text NOT NULL,
	`message_preview` text NOT NULL,
	`metadata` text,
	`consumed_by_session_id` text(36),
	`consumed_at` integer,
	FOREIGN KEY (`gateway_channel_id`) REFERENCES `gateway_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`emitted_by_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`emitted_by_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`emitted_by_task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`emitted_by_schedule_id`) REFERENCES `schedules`(`schedule_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`consumed_by_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_gateway_outbound_channel_thread` ON `gateway_outbound_messages` (`gateway_channel_id`,`platform_thread_id`);
--> statement-breakpoint
CREATE INDEX `idx_gateway_outbound_emitted_session` ON `gateway_outbound_messages` (`emitted_by_session_id`);
--> statement-breakpoint
CREATE INDEX `idx_gateway_outbound_emitted_schedule` ON `gateway_outbound_messages` (`emitted_by_schedule_id`);
--> statement-breakpoint
CREATE INDEX `idx_gateway_outbound_branch_created` ON `gateway_outbound_messages` (`target_branch_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_gateway_outbound_consumed` ON `gateway_outbound_messages` (`consumed_at`);
