-- Add agent_role to sessions table
ALTER TABLE `sessions` ADD `agent_role` text;--> statement-breakpoint

-- Create patterns table
CREATE TABLE `patterns` (
	`pattern_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`category` text NOT NULL,
	`confidence` integer DEFAULT 50 NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`created_by` text(36) DEFAULT 'anonymous' NOT NULL,
	`data` text NOT NULL
);--> statement-breakpoint

-- Create pattern_applications table
CREATE TABLE `pattern_applications` (
	`application_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`pattern_id` text(36) NOT NULL,
	`session_id` text(36) NOT NULL,
	`task_id` text(36),
	`outcome` text NOT NULL,
	`created_by` text(36) DEFAULT 'anonymous' NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`pattern_id`) REFERENCES `patterns`(`pattern_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint

-- Create indexes for patterns table
CREATE INDEX `patterns_category_idx` ON `patterns` (`category`);--> statement-breakpoint
CREATE INDEX `patterns_confidence_idx` ON `patterns` (`confidence`);--> statement-breakpoint
CREATE INDEX `patterns_usage_idx` ON `patterns` (`usage_count`);--> statement-breakpoint
CREATE INDEX `patterns_created_idx` ON `patterns` (`created_at`);--> statement-breakpoint
CREATE INDEX `patterns_created_by_idx` ON `patterns` (`created_by`);--> statement-breakpoint

-- Create indexes for pattern_applications table
CREATE INDEX `pattern_applications_pattern_idx` ON `pattern_applications` (`pattern_id`);--> statement-breakpoint
CREATE INDEX `pattern_applications_session_idx` ON `pattern_applications` (`session_id`);--> statement-breakpoint
CREATE INDEX `pattern_applications_task_idx` ON `pattern_applications` (`task_id`);--> statement-breakpoint
CREATE INDEX `pattern_applications_outcome_idx` ON `pattern_applications` (`outcome`);--> statement-breakpoint
CREATE INDEX `pattern_applications_created_idx` ON `pattern_applications` (`created_at`);
