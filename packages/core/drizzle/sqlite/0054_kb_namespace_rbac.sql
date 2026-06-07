-- Add Knowledge namespace RBAC boundary. Existing namespaces stay workspace-writable
-- to preserve current document-centric sharing behavior until service enforcement lands.
ALTER TABLE `kb_namespaces` ADD COLUMN `others_can` text DEFAULT 'write' NOT NULL;--> statement-breakpoint
CREATE TABLE `kb_namespace_acl` (
	`namespace_acl_id` text(36) PRIMARY KEY NOT NULL,
	`namespace_id` text(36) NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text(36) NOT NULL,
	`permission` text NOT NULL,
	`created_by` text(36),
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`namespace_id`) REFERENCES `kb_namespaces`(`namespace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE INDEX `kb_namespace_acl_namespace_idx` ON `kb_namespace_acl` (`namespace_id`);--> statement-breakpoint
CREATE INDEX `kb_namespace_acl_subject_idx` ON `kb_namespace_acl` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `kb_namespace_acl_namespace_subject_idx` ON `kb_namespace_acl` (`namespace_id`,`subject_type`,`subject_id`);
