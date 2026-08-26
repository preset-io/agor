-- Offline/big-bang RBAC remodel. The migration deliberately does not retain a
-- runtime fallback to the legacy owner/grant/default fields.
ALTER TABLE `boards` ADD COLUMN `primary_owner_user_id` text;
--> statement-breakpoint
ALTER TABLE `branches` ADD COLUMN `primary_owner_user_id` text;
--> statement-breakpoint
ALTER TABLE `branches` ADD COLUMN `permission_binding` text DEFAULT 'override' NOT NULL;
--> statement-breakpoint
UPDATE `boards`
SET `primary_owner_user_id` = CASE
  WHEN EXISTS (SELECT 1 FROM `users` WHERE `users`.`user_id` = `boards`.`created_by`) THEN `created_by`
  ELSE (SELECT bo.`user_id` FROM `board_owners` bo JOIN `users` u ON u.`user_id` = bo.`user_id`
        WHERE bo.`board_id` = `boards`.`board_id` ORDER BY bo.`created_at`, bo.`user_id` LIMIT 1)
END;
--> statement-breakpoint
UPDATE `branches`
SET `primary_owner_user_id` = CASE
  WHEN EXISTS (SELECT 1 FROM `users` WHERE `users`.`user_id` = `branches`.`created_by`) THEN `created_by`
  ELSE (SELECT bo.`user_id` FROM `branch_owners` bo JOIN `users` u ON u.`user_id` = bo.`user_id`
        WHERE bo.`branch_id` = `branches`.`branch_id` ORDER BY bo.`created_at`, bo.`user_id` LIMIT 1)
END;
--> statement-breakpoint
-- Fail closed instead of silently assigning an administrator when attribution is impossible.
CREATE TEMP TABLE `_rbac_owner_preflight` (`ok` integer NOT NULL CHECK (`ok` = 1));
--> statement-breakpoint
INSERT INTO `_rbac_owner_preflight` (`ok`)
SELECT 0 FROM `boards` WHERE `primary_owner_user_id` IS NULL
UNION ALL
SELECT 0 FROM `branches` WHERE `primary_owner_user_id` IS NULL;
--> statement-breakpoint
DROP TABLE `_rbac_owner_preflight`;
--> statement-breakpoint
UPDATE `branches` SET `permission_binding` = CASE WHEN `permission_source` = 'board' AND `board_id` IS NOT NULL THEN 'inherit' ELSE 'override' END;
--> statement-breakpoint

CREATE TABLE `board_access_policies` (
  `board_id` text PRIMARY KEY NOT NULL REFERENCES `boards`(`board_id`) ON DELETE CASCADE,
  `schema_version` integer DEFAULT 1 NOT NULL,
  `sharing_mode` text NOT NULL,
  `others_role` text DEFAULT 'none' NOT NULL CHECK (`others_role` IN ('none','viewer','editor','manager')),
  `revision` integer DEFAULT 1 NOT NULL,
  `updated_by` text REFERENCES `users`(`user_id`) ON DELETE SET NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `board_access_policies_updated_idx` ON `board_access_policies` (`updated_at`);
--> statement-breakpoint
CREATE TABLE `board_access_entries` (
  `entry_id` text PRIMARY KEY NOT NULL,
  `board_id` text NOT NULL REFERENCES `board_access_policies`(`board_id`) ON DELETE CASCADE,
  `user_id` text REFERENCES `users`(`user_id`) ON DELETE CASCADE,
  `group_id` text REFERENCES `groups`(`group_id`) ON DELETE CASCADE,
  `role` text NOT NULL CHECK (`role` IN ('none','viewer','editor','manager')),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK ((`user_id` IS NOT NULL) <> (`group_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `board_access_entries_board_idx` ON `board_access_entries` (`board_id`);
--> statement-breakpoint
CREATE INDEX `board_access_entries_user_idx` ON `board_access_entries` (`user_id`,`board_id`);
--> statement-breakpoint
CREATE INDEX `board_access_entries_group_idx` ON `board_access_entries` (`group_id`,`board_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_access_entries_board_user_unique` ON `board_access_entries` (`board_id`,`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_access_entries_board_group_unique` ON `board_access_entries` (`board_id`,`group_id`);
--> statement-breakpoint

CREATE TABLE `branch_permission_configs` (
  `config_id` text PRIMARY KEY NOT NULL,
  `board_id` text REFERENCES `boards`(`board_id`) ON DELETE CASCADE,
  `branch_id` text REFERENCES `branches`(`branch_id`) ON DELETE CASCADE,
  `schema_version` integer DEFAULT 1 NOT NULL,
  `sharing_mode` text NOT NULL,
  `others_role` text DEFAULT 'none' NOT NULL CHECK (`others_role` IN ('none','viewer','collaborator','manager')),
  `others_fs_access` text DEFAULT 'none' NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  `updated_by` text REFERENCES `users`(`user_id`) ON DELETE SET NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK ((`board_id` IS NOT NULL) <> (`branch_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `branch_permission_configs_board_unique` ON `branch_permission_configs` (`board_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `branch_permission_configs_branch_unique` ON `branch_permission_configs` (`branch_id`);
--> statement-breakpoint
CREATE INDEX `branch_permission_configs_updated_idx` ON `branch_permission_configs` (`updated_at`);
--> statement-breakpoint
CREATE TABLE `branch_permission_entries` (
  `entry_id` text PRIMARY KEY NOT NULL,
  `config_id` text NOT NULL REFERENCES `branch_permission_configs`(`config_id`) ON DELETE CASCADE,
  `user_id` text REFERENCES `users`(`user_id`) ON DELETE CASCADE,
  `group_id` text REFERENCES `groups`(`group_id`) ON DELETE CASCADE,
  `role` text NOT NULL CHECK (`role` IN ('none','viewer','collaborator','manager')),
  `fs_access` text DEFAULT 'none' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK ((`user_id` IS NOT NULL) <> (`group_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `branch_permission_entries_config_idx` ON `branch_permission_entries` (`config_id`);
--> statement-breakpoint
CREATE INDEX `branch_permission_entries_user_idx` ON `branch_permission_entries` (`user_id`,`config_id`);
--> statement-breakpoint
CREATE INDEX `branch_permission_entries_group_idx` ON `branch_permission_entries` (`group_id`,`config_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `branch_permission_entries_config_user_unique` ON `branch_permission_entries` (`config_id`,`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `branch_permission_entries_config_group_unique` ON `branch_permission_entries` (`config_id`,`group_id`);
--> statement-breakpoint
CREATE TABLE `branch_session_sharing_rules` (
  `config_id` text NOT NULL REFERENCES `branch_permission_configs`(`config_id`) ON DELETE CASCADE,
  `session_owner_user_id` text NOT NULL REFERENCES `users`(`user_id`) ON DELETE CASCADE,
  `enabled` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`config_id`,`session_owner_user_id`)
);
--> statement-breakpoint
CREATE INDEX `branch_session_sharing_rules_owner_idx` ON `branch_session_sharing_rules` (`session_owner_user_id`);
--> statement-breakpoint
CREATE TABLE `branch_session_sharing_grants` (
  `grant_id` text PRIMARY KEY NOT NULL,
  `config_id` text NOT NULL,
  `session_owner_user_id` text NOT NULL,
  `user_id` text REFERENCES `users`(`user_id`) ON DELETE CASCADE,
  `group_id` text REFERENCES `groups`(`group_id`) ON DELETE CASCADE,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`config_id`,`session_owner_user_id`) REFERENCES `branch_session_sharing_rules`(`config_id`,`session_owner_user_id`) ON DELETE CASCADE,
  CHECK ((`user_id` IS NOT NULL) <> (`group_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `branch_session_sharing_grants_rule_idx` ON `branch_session_sharing_grants` (`config_id`,`session_owner_user_id`);
--> statement-breakpoint
CREATE INDEX `branch_session_sharing_grants_user_idx` ON `branch_session_sharing_grants` (`user_id`,`config_id`);
--> statement-breakpoint
CREATE INDEX `branch_session_sharing_grants_group_idx` ON `branch_session_sharing_grants` (`group_id`,`config_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `branch_session_sharing_grants_rule_user_unique` ON `branch_session_sharing_grants` (`config_id`,`session_owner_user_id`,`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `branch_session_sharing_grants_rule_group_unique` ON `branch_session_sharing_grants` (`config_id`,`session_owner_user_id`,`group_id`);
--> statement-breakpoint

-- Board access: the old shared audience becomes Viewer; private boards preserve
-- only active additional owners as Manager entries.
INSERT INTO `board_access_policies`
SELECT b.`board_id`, 1,
  CASE WHEN COALESCE(json_extract(b.`data`, '$.access_mode'), 'shared') = 'shared'
         OR EXISTS (SELECT 1 FROM `board_owners` bo WHERE bo.`board_id`=b.`board_id` AND bo.`user_id`<>b.`primary_owner_user_id`)
       THEN 'shared' ELSE 'private' END,
  CASE WHEN COALESCE(json_extract(b.`data`, '$.access_mode'), 'shared') = 'shared' THEN 'viewer' ELSE 'none' END,
  1, b.`primary_owner_user_id`, COALESCE(b.`created_at`, unixepoch()*1000), COALESCE(b.`updated_at`, b.`created_at`, unixepoch()*1000)
FROM `boards` b;
--> statement-breakpoint
INSERT INTO `board_access_entries`
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-7'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
  bo.`board_id`, bo.`user_id`, NULL, 'manager',
  COALESCE(bo.`created_at`, unixepoch()*1000), COALESCE(bo.`created_at`, unixepoch()*1000)
FROM `board_owners` bo JOIN `boards` b ON b.`board_id`=bo.`board_id`
WHERE bo.`user_id`<>b.`primary_owner_user_id`;
--> statement-breakpoint
INSERT INTO `board_access_entries`
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-7'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
  bg.`board_id`, NULL, bg.`group_id`, 'viewer',
  COALESCE(bg.`created_at`, unixepoch()*1000), COALESCE(bg.`updated_at`, bg.`created_at`, unixepoch()*1000)
FROM `board_group_grants` bg JOIN `boards` b ON b.`board_id`=bg.`board_id`
WHERE bg.`can`<>'none' AND COALESCE(json_extract(b.`data`, '$.access_mode'), 'shared')='shared';
--> statement-breakpoint

-- One branch template per board. Legacy prompt is intentionally reduced to
-- Collaborator: foreign-home prompting is never inferred by migration.
INSERT INTO `branch_permission_configs`
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-7'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
  b.`board_id`, NULL, 1,
  CASE WHEN COALESCE(json_extract(b.`data`, '$.default_others_can'), 'session')<>'none'
         OR EXISTS (SELECT 1 FROM `board_owners` bo WHERE bo.`board_id`=b.`board_id` AND bo.`user_id`<>b.`primary_owner_user_id`)
         OR (COALESCE(json_extract(b.`data`, '$.access_mode'), 'shared')='shared'
             AND EXISTS (SELECT 1 FROM `board_group_grants` bg WHERE bg.`board_id`=b.`board_id` AND bg.`can`<>'none'))
       THEN 'shared' ELSE 'private' END,
  CASE COALESCE(json_extract(b.`data`, '$.default_others_can'), 'session') WHEN 'none' THEN 'none' WHEN 'view' THEN 'viewer' WHEN 'all' THEN 'manager' ELSE 'collaborator' END,
  CASE WHEN COALESCE(json_extract(b.`data`, '$.default_others_can'), 'session')='none' THEN 'none' ELSE COALESCE(json_extract(b.`data`, '$.default_others_fs_access'), 'read') END,
  1, b.`primary_owner_user_id`, COALESCE(b.`created_at`, unixepoch()*1000), COALESCE(b.`updated_at`, b.`created_at`, unixepoch()*1000)
FROM `boards` b;
--> statement-breakpoint
INSERT INTO `branch_permission_entries`
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-7'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
  c.`config_id`, bo.`user_id`, NULL, 'manager',
  'write', COALESCE(bo.`created_at`, unixepoch()*1000), COALESCE(bo.`created_at`, unixepoch()*1000)
FROM `board_owners` bo JOIN `boards` b ON b.`board_id`=bo.`board_id`
JOIN `branch_permission_configs` c ON c.`board_id`=bo.`board_id`
WHERE bo.`user_id`<>b.`primary_owner_user_id`;
--> statement-breakpoint
INSERT INTO `branch_permission_entries`
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-7'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
  c.`config_id`, NULL, bg.`group_id`, CASE bg.`can` WHEN 'view' THEN 'viewer' WHEN 'all' THEN 'manager' ELSE 'collaborator' END,
  CASE WHEN bg.`can`='none' THEN 'none' ELSE COALESCE(bg.`fs_access`,'read') END,
  COALESCE(bg.`created_at`, unixepoch()*1000), COALESCE(bg.`updated_at`, bg.`created_at`, unixepoch()*1000)
FROM `board_group_grants` bg JOIN `boards` b ON b.`board_id`=bg.`board_id`
JOIN `branch_permission_configs` c ON c.`board_id`=bg.`board_id`
WHERE bg.`can`<>'none' AND COALESCE(json_extract(b.`data`, '$.access_mode'), 'shared')='shared';
--> statement-breakpoint

-- Explicit branch packages. Inherited branches have no shadow override row.
INSERT INTO `branch_permission_configs`
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-7'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
  NULL, br.`branch_id`, 1,
  CASE WHEN COALESCE(br.`others_can`,'session')<>'none'
         OR EXISTS (SELECT 1 FROM `branch_owners` bo WHERE bo.`branch_id`=br.`branch_id` AND bo.`user_id`<>br.`primary_owner_user_id`)
         OR EXISTS (SELECT 1 FROM `branch_group_grants` bg WHERE bg.`branch_id`=br.`branch_id` AND bg.`can`<>'none')
       THEN 'shared' ELSE 'private' END,
  CASE COALESCE(br.`others_can`,'session') WHEN 'none' THEN 'none' WHEN 'view' THEN 'viewer' WHEN 'all' THEN 'manager' ELSE 'collaborator' END,
  CASE WHEN COALESCE(br.`others_can`,'session')='none' THEN 'none' ELSE COALESCE(br.`others_fs_access`,'read') END,
  1, br.`primary_owner_user_id`, COALESCE(br.`created_at`, unixepoch()*1000), COALESCE(br.`updated_at`, br.`created_at`, unixepoch()*1000)
FROM `branches` br WHERE br.`permission_binding`='override';
--> statement-breakpoint
INSERT INTO `branch_permission_entries`
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-7'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
  c.`config_id`, bo.`user_id`, NULL, 'manager',
  'write', COALESCE(bo.`created_at`, unixepoch()*1000), COALESCE(bo.`created_at`, unixepoch()*1000)
FROM `branch_owners` bo JOIN `branches` br ON br.`branch_id`=bo.`branch_id`
JOIN `branch_permission_configs` c ON c.`branch_id`=bo.`branch_id`
WHERE bo.`user_id`<>br.`primary_owner_user_id`;
--> statement-breakpoint
INSERT INTO `branch_permission_entries`
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-7'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
  c.`config_id`, NULL, bg.`group_id`, CASE bg.`can` WHEN 'view' THEN 'viewer' WHEN 'all' THEN 'manager' ELSE 'collaborator' END,
  COALESCE(bg.`fs_access`,'read'), COALESCE(bg.`created_at`, unixepoch()*1000), COALESCE(bg.`updated_at`, bg.`created_at`, unixepoch()*1000)
FROM `branch_group_grants` bg JOIN `branch_permission_configs` c ON c.`branch_id`=bg.`branch_id`
WHERE bg.`can`<>'none';
--> statement-breakpoint

-- Retire all legacy authority. Physical compatibility columns/tables remain so
-- an old binary fails closed rather than interpreting stale grants.
DELETE FROM `branch_owners`;
--> statement-breakpoint
DELETE FROM `board_owners`;
--> statement-breakpoint
DELETE FROM `branch_group_grants`;
--> statement-breakpoint
DELETE FROM `board_group_grants`;
--> statement-breakpoint
UPDATE `branches` SET `permission_source`='override', `others_can`='none', `others_fs_access`='none',
  `data`=json_remove(`data`, '$.dangerously_allow_session_sharing');
--> statement-breakpoint
UPDATE `boards` SET `data`=json_remove(`data`, '$.access_mode', '$.default_others_can', '$.default_others_fs_access', '$.default_dangerously_allow_session_sharing');
--> statement-breakpoint
CREATE TRIGGER `boards_primary_owner_immutable` BEFORE UPDATE OF `primary_owner_user_id` ON `boards`
WHEN NEW.`primary_owner_user_id` IS NOT OLD.`primary_owner_user_id`
BEGIN SELECT RAISE(ABORT, 'board primary owner is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `branches_primary_owner_immutable` BEFORE UPDATE OF `primary_owner_user_id` ON `branches`
WHEN NEW.`primary_owner_user_id` IS NOT OLD.`primary_owner_user_id`
BEGIN SELECT RAISE(ABORT, 'branch primary owner is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `boards_primary_owner_required` BEFORE INSERT ON `boards`
WHEN NEW.`primary_owner_user_id` IS NULL
BEGIN SELECT RAISE(ABORT, 'board primary owner is required'); END;
--> statement-breakpoint
CREATE TRIGGER `branches_primary_owner_required` BEFORE INSERT ON `branches`
WHEN NEW.`primary_owner_user_id` IS NULL
BEGIN SELECT RAISE(ABORT, 'branch primary owner is required'); END;
