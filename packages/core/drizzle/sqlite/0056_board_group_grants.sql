CREATE TABLE `board_group_grants` (
  `board_id` text(36) NOT NULL,
  `group_id` text(36) NOT NULL,
  `can` text DEFAULT 'view' NOT NULL,
  `fs_access` text,
  `created_by` text(36),
  `created_at` integer NOT NULL,
  `updated_at` integer,
  PRIMARY KEY(`board_id`, `group_id`),
  FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`group_id`) REFERENCES `groups`(`group_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE INDEX `board_group_grants_group_idx` ON `board_group_grants` (`group_id`);
