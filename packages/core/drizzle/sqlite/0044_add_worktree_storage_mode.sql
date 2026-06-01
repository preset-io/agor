-- Branch storage mode (part of the worktree → clone storage migration).
--
-- Design doc: docs/internal/branch-vs-worktree-migration-analysis-2026-05-20.md
--
-- Adds two opt-in columns on `worktrees`:
--   storage_mode = 'worktree' | 'clone' (NOT NULL, default 'worktree')
--   clone_depth  = NULL | positive int   (only meaningful when storage_mode='clone')
--
-- Default keeps existing behaviour — every existing row stays on the legacy
-- `git worktree add` path. No code path consults these columns yet outside
-- the create + remove branches added by this PR; flipping the default is a
-- separate, sequenced PR (see §8 of the design doc).
--
-- No CHECK constraints on storage_mode: per
-- context/guides/creating-database-migrations.md §"Avoid CHECK constraints
-- for enum-like columns on SQLite", enum domains are validated at the
-- application layer (Drizzle schema enum, Zod, service hooks). Adding a
-- value later would otherwise force a full table-recreation migration on
-- SQLite. Postgres-side mirror keeps the same posture for consistency.

ALTER TABLE `worktrees` ADD COLUMN `storage_mode` text NOT NULL DEFAULT 'worktree';--> statement-breakpoint

ALTER TABLE `worktrees` ADD COLUMN `clone_depth` integer;
