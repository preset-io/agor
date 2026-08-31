SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "branch_permission_configs"
  ADD COLUMN "allow_shared_session_prompts" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DROP TABLE "branch_session_sharing_grants";
--> statement-breakpoint
DROP TABLE "branch_session_sharing_rules";
--> statement-breakpoint
DELETE FROM "app_variables"
WHERE "namespace" = 'workspace_preferences'
  AND "key" = 'personal_session_sharing_enabled';
--> statement-breakpoint
UPDATE "branches"
SET "data" = "data" - 'dangerously_allow_session_sharing'
WHERE "data" ? 'dangerously_allow_session_sharing';
--> statement-breakpoint
UPDATE "boards"
SET "data" = "data" - 'default_dangerously_allow_session_sharing'
WHERE "data" ? 'default_dangerously_allow_session_sharing';
