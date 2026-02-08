CREATE TABLE `gateway_channels` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text(36) DEFAULT 'anonymous' NOT NULL,
	`name` text NOT NULL,
	`channel_type` text NOT NULL,
	`target_worktree_id` text(36) NOT NULL,
	`agor_user_id` text(36) NOT NULL,
	`channel_key` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_message_at` integer,
	`config` text NOT NULL,
	FOREIGN KEY (`target_worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_channels_channel_key_unique` ON `gateway_channels` (`channel_key`);--> statement-breakpoint
CREATE INDEX `idx_gateway_channel_key` ON `gateway_channels` (`channel_key`);--> statement-breakpoint
CREATE INDEX `idx_gateway_enabled_type` ON `gateway_channels` (`enabled`,`channel_type`);--> statement-breakpoint
CREATE TABLE `thread_session_map` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`last_message_at` integer NOT NULL,
	`channel_id` text(36) NOT NULL,
	`thread_id` text NOT NULL,
	`session_id` text(36) NOT NULL,
	`worktree_id` text(36) NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`metadata` text,
	FOREIGN KEY (`channel_id`) REFERENCES `gateway_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `uniq_thread_map_channel_thread` ON `thread_session_map` (`channel_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_thread_map_session_id` ON `thread_session_map` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_thread_map_channel_status` ON `thread_session_map` (`channel_id`,`status`);