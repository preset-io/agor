-- Artifacts format refactor (2026-05-09).
--
-- - Drop `use_local_bundler` (the self-hosted Sandpack bundler is gone).
-- - Add `sandpack_config` (JSON) — author-controlled SandpackProvider props.
-- - Add `required_env_vars` (JSON array) — env var NAMES the artifact needs.
-- - Add `agor_grants` (JSON object) — declarative daemon capabilities.
-- - Add `artifact_trust_grants` table for the TOFU consent flow.
--
-- Backwards compatibility is intentionally NOT preserved. Old artifacts get
-- empty defaults; the daemon detects the legacy format on read and surfaces a
-- self-service upgrade prompt to the user. See
-- `docs/internal/artifacts-roadmap-2026-05-09.md`.

PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `__new_artifacts` (
	`artifact_id` text(36) PRIMARY KEY NOT NULL,
	`worktree_id` text(36),
	`board_id` text(36) NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`path` text,
	`template` text DEFAULT 'react' NOT NULL,
	`build_status` text DEFAULT 'unknown' NOT NULL,
	`build_errors` text,
	`content_hash` text,
	`files` text,
	`dependencies` text,
	`entry` text,
	`sandpack_config` text,
	`required_env_vars` text,
	`agor_grants` text,
	`public` integer DEFAULT true NOT NULL,
	`created_by` text(36),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

INSERT INTO `__new_artifacts`(
	"artifact_id", "worktree_id", "board_id", "name", "description", "path",
	"template", "build_status", "build_errors", "content_hash", "files",
	"dependencies", "entry", "public", "created_by", "created_at",
	"updated_at", "archived", "archived_at"
)
SELECT
	"artifact_id", "worktree_id", "board_id", "name", "description", "path",
	"template", "build_status", "build_errors", "content_hash", "files",
	"dependencies", "entry", "public", "created_by", "created_at",
	"updated_at", "archived", "archived_at"
FROM `artifacts`;--> statement-breakpoint

DROP TABLE `artifacts`;--> statement-breakpoint
ALTER TABLE `__new_artifacts` RENAME TO `artifacts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint

CREATE INDEX `artifacts_worktree_idx` ON `artifacts` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `artifacts_board_idx` ON `artifacts` (`board_id`);--> statement-breakpoint
CREATE INDEX `artifacts_archived_idx` ON `artifacts` (`archived`);--> statement-breakpoint
CREATE INDEX `artifacts_public_idx` ON `artifacts` (`public`);--> statement-breakpoint

CREATE TABLE `artifact_trust_grants` (
	`grant_id` text(36) PRIMARY KEY NOT NULL,
	`user_id` text(36) NOT NULL,
	`scope_type` text NOT NULL,
	`scope_value` text,
	`env_vars_set` text NOT NULL,
	`agor_grants_set` text NOT NULL,
	`granted_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

CREATE INDEX `artifact_trust_grants_user_idx` ON `artifact_trust_grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `artifact_trust_grants_scope_idx` ON `artifact_trust_grants` (`scope_type`, `scope_value`);
