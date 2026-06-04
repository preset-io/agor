CREATE TABLE `groups` (
  `group_id` text(36) PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `slug` text NOT NULL,
  `description` text,
  `archived` integer DEFAULT false NOT NULL,
  `created_by` text(36),
  `created_at` integer NOT NULL,
  `updated_at` integer,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_slug_idx` ON `groups` (`slug`);
--> statement-breakpoint
CREATE INDEX `groups_archived_idx` ON `groups` (`archived`);
--> statement-breakpoint
CREATE TABLE `group_memberships` (
  `group_id` text(36) NOT NULL,
  `user_id` text(36) NOT NULL,
  `added_by` text(36),
  `created_at` integer NOT NULL,
  PRIMARY KEY(`group_id`, `user_id`),
  FOREIGN KEY (`group_id`) REFERENCES `groups`(`group_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`added_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `group_memberships_user_idx` ON `group_memberships` (`user_id`);
--> statement-breakpoint
CREATE TABLE `branch_group_grants` (
  `branch_id` text(36) NOT NULL,
  `group_id` text(36) NOT NULL,
  `can` text DEFAULT 'view' NOT NULL,
  `fs_access` text,
  `created_by` text(36),
  `created_at` integer NOT NULL,
  `updated_at` integer,
  PRIMARY KEY(`branch_id`, `group_id`),
  FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`group_id`) REFERENCES `groups`(`group_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `branch_group_grants_group_idx` ON `branch_group_grants` (`group_id`);
