-- Standalone SQLite retains the process-local GitHub setup state authority.
-- This schema mirror is intentionally unused at runtime and keeps cross-dialect
-- migration history compatible without changing local restart semantics.
CREATE TABLE `github_install_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`intent` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `github_install_states_expires_idx`
	ON `github_install_states` (`expires_at`);
