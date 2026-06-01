-- Rename `worktree*` → `branch*` across tables, columns, and indexes.
--
-- Tied to the v0.20.0 release: the long-deferred "Branch is the primary
-- concept; the native git-worktree is just one storage backing for a
-- Branch" naming. App code, MCP tools, REST routes, and TypeScript types
-- are renamed in lockstep — see CHANGELOG.md.
--
-- Surviving `worktree` references after this migration:
--   • `branches.storage_mode = 'worktree' | 'clone'` — the enum literal
--     refers to the actual `git worktree add` primitive and stays.
--   • The on-disk path `~/.agor/worktrees/<repo>/<name>` is unchanged in
--     this release (renaming would force a filesystem migration; the dir
--     name is decoupled from the conceptual entity).
--
-- ALTER TABLE … RENAME and ALTER TABLE … RENAME COLUMN are O(1) metadata
-- operations on SQLite 3.25+; no row rewrite, no long lock. FKs and
-- intra-schema references update automatically. Indexes do NOT auto-rename
-- on SQLite (no ALTER INDEX RENAME), so they're dropped + recreated below.

-- ===== Table renames =====
ALTER TABLE `worktrees` RENAME TO `branches`;--> statement-breakpoint
ALTER TABLE `worktree_owners` RENAME TO `branch_owners`;--> statement-breakpoint

-- ===== Column renames =====
-- branches (was worktrees)
ALTER TABLE `branches` RENAME COLUMN `worktree_id` TO `branch_id`;--> statement-breakpoint
ALTER TABLE `branches` RENAME COLUMN `worktree_unique_id` TO `branch_unique_id`;--> statement-breakpoint

-- branch_owners (was worktree_owners)
ALTER TABLE `branch_owners` RENAME COLUMN `worktree_id` TO `branch_id`;--> statement-breakpoint

-- cross-table FKs
ALTER TABLE `sessions` RENAME COLUMN `worktree_id` TO `branch_id`;--> statement-breakpoint
ALTER TABLE `sessions` RENAME COLUMN `scheduled_from_worktree` TO `scheduled_from_branch`;--> statement-breakpoint
ALTER TABLE `serialized_sessions` RENAME COLUMN `worktree_id` TO `branch_id`;--> statement-breakpoint
ALTER TABLE `artifacts` RENAME COLUMN `worktree_id` TO `branch_id`;--> statement-breakpoint
ALTER TABLE `board_objects` RENAME COLUMN `worktree_id` TO `branch_id`;--> statement-breakpoint
ALTER TABLE `board_comments` RENAME COLUMN `worktree_id` TO `branch_id`;--> statement-breakpoint
ALTER TABLE `gateway_channels` RENAME COLUMN `target_worktree_id` TO `target_branch_id`;--> statement-breakpoint
ALTER TABLE `thread_session_map` RENAME COLUMN `worktree_id` TO `branch_id`;--> statement-breakpoint

-- ===== Index renames (drop + recreate; SQLite lacks ALTER INDEX RENAME) =====
DROP INDEX IF EXISTS `worktrees_repo_idx`;--> statement-breakpoint
CREATE INDEX `branches_repo_idx` ON `branches` (`repo_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `worktrees_name_idx`;--> statement-breakpoint
CREATE INDEX `branches_name_idx` ON `branches` (`name`);--> statement-breakpoint
DROP INDEX IF EXISTS `worktrees_ref_idx`;--> statement-breakpoint
CREATE INDEX `branches_ref_idx` ON `branches` (`ref`);--> statement-breakpoint
DROP INDEX IF EXISTS `worktrees_board_idx`;--> statement-breakpoint
CREATE INDEX `branches_board_idx` ON `branches` (`board_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `worktrees_created_idx`;--> statement-breakpoint
CREATE INDEX `branches_created_idx` ON `branches` (`created_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `worktrees_updated_idx`;--> statement-breakpoint
CREATE INDEX `branches_updated_idx` ON `branches` (`updated_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `worktrees_repo_name_unique`;--> statement-breakpoint
CREATE INDEX `branches_repo_name_unique` ON `branches` (`repo_id`,`name`);--> statement-breakpoint
DROP INDEX IF EXISTS `worktrees_schedule_enabled_idx`;--> statement-breakpoint
CREATE INDEX `branches_schedule_enabled_idx` ON `branches` (`schedule_enabled`);--> statement-breakpoint
DROP INDEX IF EXISTS `worktrees_board_schedule_idx`;--> statement-breakpoint
CREATE INDEX `branches_board_schedule_idx` ON `branches` (`board_id`,`schedule_enabled`);--> statement-breakpoint

DROP INDEX IF EXISTS `sessions_worktree_idx`;--> statement-breakpoint
CREATE INDEX `sessions_branch_idx` ON `sessions` (`branch_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `serialized_sessions_worktree_idx`;--> statement-breakpoint
CREATE INDEX `serialized_sessions_branch_idx` ON `serialized_sessions` (`branch_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `artifacts_worktree_idx`;--> statement-breakpoint
CREATE INDEX `artifacts_branch_idx` ON `artifacts` (`branch_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `board_objects_worktree_idx`;--> statement-breakpoint
CREATE INDEX `board_objects_branch_idx` ON `board_objects` (`branch_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `board_comments_worktree_idx`;--> statement-breakpoint
CREATE INDEX `board_comments_branch_idx` ON `board_comments` (`branch_id`);--> statement-breakpoint

-- ===== Data migration: enum-literal values =====
-- `sessions.archived_reason` flips 'worktree_archived' → 'branch_archived'.
-- The DB column is plain TEXT (no CHECK constraint per
-- context/guides/creating-database-migrations.md); enum is enforced at the
-- app/Drizzle/Zod layer.
UPDATE `sessions`
  SET `archived_reason` = 'branch_archived'
  WHERE `archived_reason` = 'worktree_archived';--> statement-breakpoint

-- `board_comments.data.position.relative.parent_type` is a JSON-stored
-- enum on the comments blob. Rewrite legacy 'worktree' values to 'branch'.
UPDATE `board_comments`
  SET `data` = json_set(`data`, '$.position.relative.parent_type', 'branch')
  WHERE json_extract(`data`, '$.position.relative.parent_type') = 'worktree';
