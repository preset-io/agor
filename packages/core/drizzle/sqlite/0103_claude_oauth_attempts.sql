-- Standalone SQLite retains the process-local Claude OAuth sign-in state. This
-- schema mirror is intentionally unused at runtime and keeps cross-dialect
-- migration history compatible without changing local behavior.
CREATE TABLE `claude_oauth_attempts` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`state_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`attempt_generation` integer NOT NULL,
	`envelope_version` integer NOT NULL,
	`is_current` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`sealed_material` text,
	`exchange_claim_id` text,
	`failure_code` text,
	`subscription_type` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`exchange_started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claude_oauth_attempts_state_hash_unique`
	ON `claude_oauth_attempts` (`state_hash`);
--> statement-breakpoint
CREATE INDEX `claude_oauth_attempts_user_idx`
	ON `claude_oauth_attempts` (`user_id`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `claude_oauth_attempts_current_user_uq`
	ON `claude_oauth_attempts` (`user_id`)
	WHERE `is_current` = 1;
--> statement-breakpoint
CREATE INDEX `claude_oauth_attempts_maintenance_idx`
	ON `claude_oauth_attempts` (`status`, `expires_at`, `exchange_started_at`, `finished_at`);
