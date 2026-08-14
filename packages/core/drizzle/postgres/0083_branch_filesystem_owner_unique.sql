-- A repo/name pair derives one canonical worktree root. Archived rows keep
-- ownership until their metadata is permanently deleted, preventing a second
-- row from deleting the first row's preserved filesystem.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DROP INDEX "branches_repo_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "branches_repo_name_unique" ON "branches" ("repo_id", "name");
