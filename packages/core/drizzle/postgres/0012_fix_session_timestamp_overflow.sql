-- Fix session scheduled_run_at field to use bigint instead of integer
-- This prevents "value out of range for type integer" errors when storing
-- millisecond timestamps beyond 2038 (when 32-bit integers overflow)

ALTER TABLE "sessions"
  ALTER COLUMN "scheduled_run_at" TYPE bigint;
