CREATE TABLE `app_variables` (
  `variable_id` text(36) PRIMARY KEY NOT NULL,
  `namespace` text NOT NULL,
  `key` text NOT NULL,
  `value_text` text,
  `value_encrypted` text,
  `is_encrypted` integer DEFAULT false NOT NULL,
  `content_type` text DEFAULT 'text/plain' NOT NULL,
  `metadata` text,
  `updated_by` text(36),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`updated_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_variables_namespace_key_idx` ON `app_variables` (`namespace`,`key`);
--> statement-breakpoint
CREATE INDEX `app_variables_namespace_idx` ON `app_variables` (`namespace`);
