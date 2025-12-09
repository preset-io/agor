-- Add unix_group column to repos table
-- This group controls access to the repo's .git/ directory
-- Users who have access to ANY worktree in the repo get added to this group
-- Enables git operations (commit, push, etc) by granting .git/ access

ALTER TABLE "repos" ADD COLUMN "unix_group" text;
