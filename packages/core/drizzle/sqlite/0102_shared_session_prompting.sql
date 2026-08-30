ALTER TABLE `branch_permission_configs`
  ADD COLUMN `allow_shared_session_prompts` integer DEFAULT false NOT NULL;
--> statement-breakpoint
DROP TABLE `branch_session_sharing_grants`;
--> statement-breakpoint
DROP TABLE `branch_session_sharing_rules`;
--> statement-breakpoint
DELETE FROM `app_variables`
WHERE `namespace` = 'workspace_preferences'
  AND `key` = 'personal_session_sharing_enabled';
--> statement-breakpoint
UPDATE `branches`
SET `data` = json_remove(`data`, '$.dangerously_allow_session_sharing')
WHERE json_type(`data`, '$.dangerously_allow_session_sharing') IS NOT NULL;
--> statement-breakpoint
UPDATE `boards`
SET `data` = json_remove(`data`, '$.default_dangerously_allow_session_sharing')
WHERE json_type(`data`, '$.default_dangerously_allow_session_sharing') IS NOT NULL;
