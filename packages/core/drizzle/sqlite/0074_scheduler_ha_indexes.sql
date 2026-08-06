-- Durable completion marker for recoverable scheduler initialization. Existing
-- scheduled Sessions predate recovery and are treated as already complete.
ALTER TABLE `sessions` ADD COLUMN `scheduler_init_completed_at` integer;
--> statement-breakpoint
UPDATE `sessions`
SET `scheduler_init_completed_at` = COALESCE(`updated_at`, `created_at`)
WHERE `scheduled_from_branch` = 1;
--> statement-breakpoint
CREATE INDEX `sessions_scheduler_init_pending_idx`
  ON `sessions` (`created_at`, `session_id`)
  WHERE `scheduled_from_branch` = 1
    AND `scheduled_run_at` IS NOT NULL
    AND `scheduler_init_completed_at` IS NULL;
--> statement-breakpoint

-- Recovery may attach the same MCP server from more than one scheduler process.
-- Remove legacy duplicates before turning the misleading non-unique "pk" index
-- into the idempotency constraint its name and repository contract imply.
UPDATE `session_mcp_servers`
SET `enabled` = (
  SELECT MAX(source.`enabled`)
  FROM `session_mcp_servers` AS source
  WHERE source.`session_id` = `session_mcp_servers`.`session_id`
    AND source.`mcp_server_id` = `session_mcp_servers`.`mcp_server_id`
);
--> statement-breakpoint
DELETE FROM `session_mcp_servers`
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM `session_mcp_servers`
  GROUP BY `session_id`, `mcp_server_id`
);
--> statement-breakpoint
DROP INDEX IF EXISTS `session_mcp_servers_pk`;
--> statement-breakpoint
CREATE UNIQUE INDEX `session_mcp_servers_pk`
  ON `session_mcp_servers` (`session_id`, `mcp_server_id`);
