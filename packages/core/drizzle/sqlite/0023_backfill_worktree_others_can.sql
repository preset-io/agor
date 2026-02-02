-- Backfill others_can for existing worktrees
-- Sets worktrees.others_can to 'view' (schema default) where NULL

UPDATE worktrees
SET others_can = 'view'
WHERE others_can IS NULL;
