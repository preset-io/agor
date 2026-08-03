CREATE TABLE `uploads` (
  `upload_ref` text PRIMARY KEY NOT NULL,
  `created_by` text NOT NULL,
  `session_id` text NOT NULL,
  `branch_id` text NOT NULL,
  `storage_key` text NOT NULL,
  `original_name` text NOT NULL,
  `display_name` text NOT NULL,
  `content_type` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `checksum` text,
  `status` text DEFAULT 'active' NOT NULL,
  `provenance` text NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `uploads_owner_idx` ON `uploads` (`created_by`);
--> statement-breakpoint
CREATE INDEX `uploads_session_idx` ON `uploads` (`session_id`);
--> statement-breakpoint
CREATE INDEX `uploads_expiry_idx` ON `uploads` (`expires_at`);
