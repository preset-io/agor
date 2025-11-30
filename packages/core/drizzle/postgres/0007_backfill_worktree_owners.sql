-- Backfill worktree_owners with creators of existing worktrees
-- This ensures all existing worktrees have at least one owner (their creator)

INSERT INTO "worktree_owners" ("worktree_id", "user_id", "created_at")
SELECT
  w.worktree_id,
  w.created_by,
  now()
FROM "worktrees" w
WHERE w.created_by IS NOT NULL
  AND w.created_by != 'anonymous'
  -- Only insert if not already an owner
  AND NOT EXISTS (
    SELECT 1 FROM "worktree_owners" wo
    WHERE wo.worktree_id = w.worktree_id
      AND wo.user_id = w.created_by
  )
ON CONFLICT DO NOTHING;
