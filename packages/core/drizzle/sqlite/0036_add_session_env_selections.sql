-- Session Env Selections table (v0.5 env-var-access)
--
-- Tracks which user-owned session-scope env vars are exposed to each session
-- at spawn time. Global-scope vars are always included in the session env;
-- session-scope vars only appear when a row here says so.
--
-- Rows scope implicitly to `session.created_by`; env vars themselves still live
-- in `users.data.env_vars` (JSON map) in v0.5, so env_var_name (not an id) is
-- the natural foreign key. See `context/explorations/env-var-access.md`.
CREATE TABLE `session_env_selections` (
	`session_id` text(36) NOT NULL,
	`env_var_name` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`session_id`, `env_var_name`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `session_env_selections_session_idx` ON `session_env_selections` (`session_id`);
