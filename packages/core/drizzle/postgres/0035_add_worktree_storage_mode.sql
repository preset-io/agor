-- Branch storage mode (PR 1 of branch-vs-worktree migration)
--
-- Design doc: docs/internal/branch-vs-worktree-migration-analysis-2026-05-20.md
-- PR: #1234 (design), this migration: feat(branch): allow self-standing clones
--
-- Adds two opt-in columns on `worktrees`:
--   storage_mode = 'worktree' | 'clone' (NOT NULL, default 'worktree')
--   clone_depth  = NULL | positive int   (only meaningful when storage_mode='clone')
--
-- Default keeps existing behaviour — every existing row stays on the legacy
-- `git worktree add` path. Flipping the default to 'clone' is a separate,
-- sequenced PR (see §8 of the design doc).

ALTER TABLE "worktrees" ADD COLUMN "storage_mode" text NOT NULL DEFAULT 'worktree';--> statement-breakpoint

ALTER TABLE "worktrees" ADD CONSTRAINT "worktrees_storage_mode_check"
  CHECK ("storage_mode" IN ('worktree', 'clone'));--> statement-breakpoint

ALTER TABLE "worktrees" ADD COLUMN "clone_depth" integer;
