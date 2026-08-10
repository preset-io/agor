-- Registry lifecycle state, promoted out of the `data` blob so the browse read
-- can exclude withdrawn servers in SQL. A blob key cannot be filtered, so a
-- retired curated row still matched every query and still sorted first.
ALTER TABLE `mcp_catalog_entries` ADD `registry_status` text;
--> statement-breakpoint
UPDATE `mcp_catalog_entries`
SET `registry_status` = json_extract(`data`, '$.registry_status')
WHERE json_extract(`data`, '$.registry_status') IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `mcp_catalog_entries_registry_status_idx`
  ON `mcp_catalog_entries` (`registry_status`);
