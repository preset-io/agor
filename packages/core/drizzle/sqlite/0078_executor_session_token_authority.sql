-- Standalone SQLite retains the process-local token authority. This schema
-- mirror is intentionally unused at runtime and keeps cross-dialect migration
-- history compatible without changing local behavior.
CREATE TABLE `executor_session_token_authorities` (
	`token_fingerprint` text PRIMARY KEY NOT NULL,
	`token_type` text NOT NULL,
	`purpose` text NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text,
	`branch_id` text,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`max_uses` integer NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `executor_session_token_authorities_session_idx`
	ON `executor_session_token_authorities` (`session_id`);
--> statement-breakpoint
CREATE INDEX `executor_session_token_authorities_expires_idx`
	ON `executor_session_token_authorities` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `executor_session_token_authorities_revoked_idx`
	ON `executor_session_token_authorities` (`revoked_at`)
	WHERE `revoked_at` IS NOT NULL;
