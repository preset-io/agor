-- Branch storage mode (part of the worktree → clone storage migration).
--
-- Design doc: docs/internal/branch-vs-worktree-migration-analysis-2026-05-20.md
--
-- Adds two opt-in columns on `worktrees`:
--   storage_mode = 'worktree' | 'clone' (NOT NULL, default 'worktree')
--   clone_depth  = NULL | positive int   (only meaningful when storage_mode='clone')
--
-- Default keeps existing behaviour — every existing row stays on the legacy
-- `git worktree add` path.
--
-- No CHECK constraint on storage_mode: enum domains are validated at the
-- application layer (Drizzle schema enum, Zod, service hooks) to mirror the
-- SQLite side (see context/guides/creating-database-migrations.md §"Avoid
-- CHECK constraints for enum-like columns on SQLite"). Keeps the two
-- dialects symmetric so behavioural drift can't sneak in.

ALTER TABLE "worktrees" ADD COLUMN "storage_mode" text NOT NULL DEFAULT 'worktree';--> statement-breakpoint

ALTER TABLE "worktrees" ADD COLUMN "clone_depth" integer;
