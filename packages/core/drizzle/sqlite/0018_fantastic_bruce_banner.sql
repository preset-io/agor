-- This migration was originally auto-generated as a duplicate of 0016_gorgeous_talkback
-- due to a merge conflict during PR #366 (Unix user integration + worktree RBAC).
--
-- Migration 0016 already created:
-- - worktree_owners table
-- - worktrees.others_can, unix_group, others_fs_access columns (with CHECK constraints)
--
-- This migration (0018) only adds what's truly new: unix_username column on sessions table
-- (The other columns were already added in 0016 and are not repeated here)

ALTER TABLE `sessions` ADD `unix_username` text;