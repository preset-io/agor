ALTER TABLE `mcp_servers` ADD COLUMN `catalog_entry_name` text;--> statement-breakpoint
UPDATE `mcp_servers` SET `catalog_entry_name` = json_extract(`data`, '$.catalog_entry_name') WHERE `source` = 'catalog';--> statement-breakpoint
INSERT OR IGNORE INTO `session_mcp_servers` (`session_id`,`mcp_server_id`,`enabled`,`added_at`)
SELECT sm.`session_id`, winner.`mcp_server_id`, sm.`enabled`, sm.`added_at`
FROM `session_mcp_servers` sm
JOIN `mcp_servers` loser ON loser.`mcp_server_id` = sm.`mcp_server_id`
JOIN `mcp_servers` winner ON winner.`mcp_server_id` = (
  SELECT x.`mcp_server_id` FROM `mcp_servers` x
  WHERE x.`source`='catalog' AND x.`owner_user_id` IS loser.`owner_user_id` AND x.`catalog_entry_name`=loser.`catalog_entry_name`
  ORDER BY COALESCE(x.`updated_at`, x.`created_at`) DESC, x.`mcp_server_id` DESC LIMIT 1
)
WHERE loser.`source`='catalog' AND loser.`catalog_entry_name` IS NOT NULL AND loser.`mcp_server_id` <> winner.`mcp_server_id`;--> statement-breakpoint
DELETE FROM `session_mcp_servers` WHERE `mcp_server_id` IN (
 SELECT loser.`mcp_server_id` FROM `mcp_servers` loser WHERE loser.`source`='catalog' AND loser.`catalog_entry_name` IS NOT NULL AND loser.`mcp_server_id` <> (
  SELECT x.`mcp_server_id` FROM `mcp_servers` x WHERE x.`source`='catalog' AND x.`owner_user_id` IS loser.`owner_user_id` AND x.`catalog_entry_name`=loser.`catalog_entry_name` ORDER BY COALESCE(x.`updated_at`,x.`created_at`) DESC,x.`mcp_server_id` DESC LIMIT 1));--> statement-breakpoint
DELETE FROM `mcp_servers` WHERE `source`='catalog' AND `catalog_entry_name` IS NOT NULL AND `mcp_server_id` <> (
 SELECT x.`mcp_server_id` FROM `mcp_servers` x WHERE x.`source`='catalog' AND x.`owner_user_id` IS `mcp_servers`.`owner_user_id` AND x.`catalog_entry_name`=`mcp_servers`.`catalog_entry_name` ORDER BY COALESCE(x.`updated_at`,x.`created_at`) DESC,x.`mcp_server_id` DESC LIMIT 1);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_catalog_owner_uq` ON `mcp_servers` (coalesce(`owner_user_id`,''),`catalog_entry_name`) WHERE `source`='catalog' AND `catalog_entry_name` IS NOT NULL;
