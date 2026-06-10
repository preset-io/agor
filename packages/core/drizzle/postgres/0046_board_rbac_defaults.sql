-- Add board-level permission defaults and branch permission source.
-- Existing branches default to override so board changes do not affect them.
ALTER TABLE "branches" ADD COLUMN "permission_source" text DEFAULT 'override' NOT NULL;
