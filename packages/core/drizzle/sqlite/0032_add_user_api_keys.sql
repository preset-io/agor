CREATE TABLE `user_api_keys` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`user_id` text(36) NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_api_keys_user_idx` ON `user_api_keys` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_api_keys_prefix_idx` ON `user_api_keys` (`prefix`);
