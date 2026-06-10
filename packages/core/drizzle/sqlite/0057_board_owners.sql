CREATE TABLE `board_owners` (
  `board_id` text(36) NOT NULL,
  `user_id` text(36) NOT NULL,
  `created_at` integer,
  PRIMARY KEY(`board_id`, `user_id`),
  FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `board_owners_user_idx` ON `board_owners` (`user_id`);
