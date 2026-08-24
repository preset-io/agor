-- Cross-dialect schema mirror. Standalone continues to use process-local
-- device attempts and does not read this table.
CREATE TABLE `codex_device_auth_attempts` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`attempt_generation` integer NOT NULL,
	`envelope_version` integer NOT NULL,
	`is_current` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'starting' NOT NULL,
	`sealed_material` text,
	`poll_interval_ms` integer,
	`poll_next_at` integer,
	`poll_claim_id` text,
	`poll_claim_generation` integer DEFAULT 0 NOT NULL,
	`poll_lease_expires_at` integer,
	`exchange_claim_id` text,
	`failure_code` text,
	`plan_type` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`exchange_started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codex_device_auth_attempts_current_user_uq`
	ON `codex_device_auth_attempts` (`user_id`) WHERE `is_current` = 1;
--> statement-breakpoint
CREATE INDEX `codex_device_auth_attempts_user_idx`
	ON `codex_device_auth_attempts` (`user_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `codex_device_auth_attempts_poll_idx`
	ON `codex_device_auth_attempts` (`status`, `poll_next_at`, `poll_lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `codex_device_auth_attempts_maintenance_idx`
	ON `codex_device_auth_attempts` (`status`, `expires_at`, `exchange_started_at`, `finished_at`);
