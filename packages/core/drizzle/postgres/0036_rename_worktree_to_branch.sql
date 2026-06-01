-- Rename `worktree*` → `branch*` across tables, columns, and indexes.
--
-- Mirror of sqlite/0045_rename_worktree_to_branch.sql. See that file's
-- header for migration rationale.

-- ===== Table renames =====
ALTER TABLE "worktrees" RENAME TO "branches";--> statement-breakpoint
ALTER TABLE "worktree_owners" RENAME TO "branch_owners";--> statement-breakpoint

-- ===== Column renames =====
ALTER TABLE "branches" RENAME COLUMN "worktree_id" TO "branch_id";--> statement-breakpoint
ALTER TABLE "branches" RENAME COLUMN "worktree_unique_id" TO "branch_unique_id";--> statement-breakpoint

ALTER TABLE "branch_owners" RENAME COLUMN "worktree_id" TO "branch_id";--> statement-breakpoint

ALTER TABLE "sessions" RENAME COLUMN "worktree_id" TO "branch_id";--> statement-breakpoint
ALTER TABLE "sessions" RENAME COLUMN "scheduled_from_worktree" TO "scheduled_from_branch";--> statement-breakpoint
ALTER TABLE "serialized_sessions" RENAME COLUMN "worktree_id" TO "branch_id";--> statement-breakpoint
ALTER TABLE "artifacts" RENAME COLUMN "worktree_id" TO "branch_id";--> statement-breakpoint
ALTER TABLE "board_objects" RENAME COLUMN "worktree_id" TO "branch_id";--> statement-breakpoint
ALTER TABLE "board_comments" RENAME COLUMN "worktree_id" TO "branch_id";--> statement-breakpoint
ALTER TABLE "gateway_channels" RENAME COLUMN "target_worktree_id" TO "target_branch_id";--> statement-breakpoint
ALTER TABLE "thread_session_map" RENAME COLUMN "worktree_id" TO "branch_id";--> statement-breakpoint

-- ===== Index renames (Postgres has ALTER INDEX RENAME) =====
ALTER INDEX "worktrees_repo_idx" RENAME TO "branches_repo_idx";--> statement-breakpoint
ALTER INDEX "worktrees_name_idx" RENAME TO "branches_name_idx";--> statement-breakpoint
ALTER INDEX "worktrees_ref_idx" RENAME TO "branches_ref_idx";--> statement-breakpoint
ALTER INDEX "worktrees_board_idx" RENAME TO "branches_board_idx";--> statement-breakpoint
ALTER INDEX "worktrees_created_idx" RENAME TO "branches_created_idx";--> statement-breakpoint
ALTER INDEX "worktrees_updated_idx" RENAME TO "branches_updated_idx";--> statement-breakpoint
ALTER INDEX "worktrees_repo_name_unique" RENAME TO "branches_repo_name_unique";--> statement-breakpoint
ALTER INDEX "worktrees_schedule_enabled_idx" RENAME TO "branches_schedule_enabled_idx";--> statement-breakpoint
ALTER INDEX "worktrees_board_schedule_idx" RENAME TO "branches_board_schedule_idx";--> statement-breakpoint

ALTER INDEX "sessions_worktree_idx" RENAME TO "sessions_branch_idx";--> statement-breakpoint
ALTER INDEX "serialized_sessions_worktree_idx" RENAME TO "serialized_sessions_branch_idx";--> statement-breakpoint
ALTER INDEX "artifacts_worktree_idx" RENAME TO "artifacts_branch_idx";--> statement-breakpoint
ALTER INDEX "board_objects_worktree_idx" RENAME TO "board_objects_branch_idx";--> statement-breakpoint
ALTER INDEX "board_comments_worktree_idx" RENAME TO "board_comments_branch_idx";--> statement-breakpoint

-- ===== Constraint renames (Postgres) =====
-- ALTER TABLE … RENAME TO doesn't rename PK/FK constraint names; without this
-- pass, fresh installs would generate Drizzle-naming-convention constraint
-- names ("branches_pkey", "branches_repo_id_repos_repo_id_fk", …) while
-- migrated installs would keep the old worktree-prefixed names — silent
-- schema drift that breaks future drizzle-kit diffs. Bring them in line.
-- All renames are guarded: instances where the FK was never created (schema
-- drift between environments) skip gracefully rather than aborting.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worktrees_pkey' AND conrelid = 'branches'::regclass) THEN
    ALTER TABLE "branches" RENAME CONSTRAINT "worktrees_pkey" TO "branches_pkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worktrees_repo_id_repos_repo_id_fk' AND conrelid = 'branches'::regclass) THEN
    ALTER TABLE "branches" RENAME CONSTRAINT "worktrees_repo_id_repos_repo_id_fk" TO "branches_repo_id_repos_repo_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worktrees_board_id_boards_board_id_fk' AND conrelid = 'branches'::regclass) THEN
    ALTER TABLE "branches" RENAME CONSTRAINT "worktrees_board_id_boards_board_id_fk" TO "branches_board_id_boards_board_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worktree_owners_worktree_id_user_id_pk' AND conrelid = 'branch_owners'::regclass) THEN
    ALTER TABLE "branch_owners" RENAME CONSTRAINT "worktree_owners_worktree_id_user_id_pk" TO "branch_owners_branch_id_user_id_pk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worktree_owners_worktree_id_worktrees_worktree_id_fk' AND conrelid = 'branch_owners'::regclass) THEN
    ALTER TABLE "branch_owners" RENAME CONSTRAINT "worktree_owners_worktree_id_worktrees_worktree_id_fk" TO "branch_owners_branch_id_branches_branch_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worktree_owners_user_id_users_user_id_fk' AND conrelid = 'branch_owners'::regclass) THEN
    ALTER TABLE "branch_owners" RENAME CONSTRAINT "worktree_owners_user_id_users_user_id_fk" TO "branch_owners_user_id_users_user_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_worktree_id_worktrees_worktree_id_fk' AND conrelid = 'sessions'::regclass) THEN
    ALTER TABLE "sessions" RENAME CONSTRAINT "sessions_worktree_id_worktrees_worktree_id_fk" TO "sessions_branch_id_branches_branch_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'serialized_sessions_worktree_id_worktrees_worktree_id_fk' AND conrelid = 'serialized_sessions'::regclass) THEN
    ALTER TABLE "serialized_sessions" RENAME CONSTRAINT "serialized_sessions_worktree_id_worktrees_worktree_id_fk" TO "serialized_sessions_branch_id_branches_branch_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_worktree_id_worktrees_worktree_id_fk' AND conrelid = 'artifacts'::regclass) THEN
    ALTER TABLE "artifacts" RENAME CONSTRAINT "artifacts_worktree_id_worktrees_worktree_id_fk" TO "artifacts_branch_id_branches_branch_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_objects_worktree_id_worktrees_worktree_id_fk' AND conrelid = 'board_objects'::regclass) THEN
    ALTER TABLE "board_objects" RENAME CONSTRAINT "board_objects_worktree_id_worktrees_worktree_id_fk" TO "board_objects_branch_id_branches_branch_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_comments_worktree_id_worktrees_worktree_id_fk' AND conrelid = 'board_comments'::regclass) THEN
    ALTER TABLE "board_comments" RENAME CONSTRAINT "board_comments_worktree_id_worktrees_worktree_id_fk" TO "board_comments_branch_id_branches_branch_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gateway_channels_target_worktree_id_worktrees_worktree_id_fk' AND conrelid = 'gateway_channels'::regclass) THEN
    ALTER TABLE "gateway_channels" RENAME CONSTRAINT "gateway_channels_target_worktree_id_worktrees_worktree_id_fk" TO "gateway_channels_target_branch_id_branches_branch_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thread_session_map_worktree_id_worktrees_worktree_id_fk' AND conrelid = 'thread_session_map'::regclass) THEN
    ALTER TABLE "thread_session_map" RENAME CONSTRAINT "thread_session_map_worktree_id_worktrees_worktree_id_fk" TO "thread_session_map_branch_id_branches_branch_id_fk";
  END IF;
END $$;--> statement-breakpoint

-- ===== Data migration: enum-literal values =====
UPDATE "sessions"
  SET "archived_reason" = 'branch_archived'
  WHERE "archived_reason" = 'worktree_archived';--> statement-breakpoint

UPDATE "board_comments"
  SET "data" = jsonb_set("data", '{position,relative,parent_type}', '"branch"'::jsonb)
  WHERE "data" -> 'position' -> 'relative' ->> 'parent_type' = 'worktree';
