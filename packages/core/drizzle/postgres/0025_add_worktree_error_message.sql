-- Add error_message column to worktrees table
-- Stores the reason why worktree creation failed (git worktree add error details)
ALTER TABLE "worktrees" ADD COLUMN "error_message" text;
