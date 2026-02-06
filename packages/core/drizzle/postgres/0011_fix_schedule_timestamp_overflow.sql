-- Fix schedule timestamp fields to use bigint instead of integer
-- This prevents "value out of range for type integer" errors when storing
-- millisecond timestamps beyond 2038 (when 32-bit integers overflow)

ALTER TABLE "worktrees"
  ALTER COLUMN "schedule_last_triggered_at" TYPE bigint,
  ALTER COLUMN "schedule_next_run_at" TYPE bigint;
