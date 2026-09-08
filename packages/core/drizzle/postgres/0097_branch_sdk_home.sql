-- Per-branch SDK home intent (design §9.2). NULL = inherit today's behavior
-- (no relocated SDK home); 'per_branch' = this branch has its own SDK home under
-- `branch-homes/<branchId>`. Stored as an intent enum, never a path — the path
-- is derived from branch_id by a single resolver. Sticky once set (design §8B.3).
-- Nullable ADD COLUMN with no default is a metadata-only change (no table
-- rewrite); the enum is validated at the app layer.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "sdk_home" text;
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
