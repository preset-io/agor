-- Per-branch SDK home intent (design §9.2). NULL = inherit today's behavior
-- (no relocated SDK home); 'per_branch' = this branch has its own SDK home under
-- `branch-homes/<branchId>`. Stored as an intent enum, never a path — the path
-- is derived from branch_id by a single resolver. Sticky once set (design §8B.3).
-- No CHECK constraint: extending the enum later must not force a SQLite table
-- rebuild; the value is validated at the app layer.
ALTER TABLE `branches` ADD `sdk_home` text;
