CREATE TABLE `completion_subscriptions` (
	`subscription_id` text(36) PRIMARY KEY NOT NULL,
	`propagation_mode` text DEFAULT 'root' NOT NULL,
	`join_policy` text DEFAULT 'designated_child' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`requested_by_user_id` text(36) NOT NULL,
	`origin_session_id` text(36) NOT NULL,
	`origin_task_id` text(36) NOT NULL,
	`callback_session_id` text(36),
	`root_session_id` text(36),
	`root_task_id` text(36),
	`active_session_id` text(36),
	`active_task_id` text(36),
	`path` text NOT NULL,
	`max_depth` integer DEFAULT 8 NOT NULL,
	`terminal_status` text,
	`terminal_snapshot` text,
	`delivery_task_id` text(36),
	`delivery_attempt_count` integer DEFAULT 0 NOT NULL,
	`next_delivery_at` integer,
	`last_delivery_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`delegated_at` integer,
	`terminal_at` integer,
	`delivered_at` integer,
	FOREIGN KEY (`callback_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`root_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`root_task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`active_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`active_task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`delivery_task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `completion_subscriptions_root_task_unique` ON `completion_subscriptions` (`root_task_id`);
--> statement-breakpoint
CREATE INDEX `completion_subscriptions_active_task_idx` ON `completion_subscriptions` (`active_task_id`,`state`);
--> statement-breakpoint
CREATE INDEX `completion_subscriptions_callback_idx` ON `completion_subscriptions` (`callback_session_id`);
--> statement-breakpoint
CREATE INDEX `completion_subscriptions_delivery_due_idx` ON `completion_subscriptions` (`state`,`next_delivery_at`,`subscription_id`);
