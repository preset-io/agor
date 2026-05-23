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
-- `git worktree add` path. No code path consults these columns yet outside
-- the new create-time branch added by this PR; flipping the default is a
-- separate, sequenced PR (see §8 of the design doc).
--
-- Note: SQLite has no native enum type — the CHECK constraint enforces the
-- domain. Drizzle's text-with-enum maps to this exact shape.

ALTER TABLE `worktrees` ADD COLUMN `storage_mode` text NOT NULL DEFAULT 'worktree'
  CHECK (`storage_mode` IN ('worktree', 'clone'));--> statement-breakpoint

ALTER TABLE `worktrees` ADD COLUMN `clone_depth` integer;
