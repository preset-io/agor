CREATE TABLE `refresh_token_families` (
  `family_id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `current_token_hash` text NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `revoked_at` integer,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `refresh_token_families_user_idx` ON `refresh_token_families` (`user_id`);
