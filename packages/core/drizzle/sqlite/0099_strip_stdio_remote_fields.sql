-- Authentication, URLs, and HTTP headers never participate in an stdio MCP
-- connection. Older rows could retain those fields, but strict transport
-- validation now rejects the whole server before spawning it. OAuth grants and
-- the cross-dialect pending-flow mirror are likewise unusable for stdio, so
-- remove those dependent rows in the same migration transaction.
DELETE FROM `mcp_oauth_pending_flows`
WHERE `mcp_server_id` IN (
  SELECT `mcp_server_id`
  FROM `mcp_servers`
  WHERE `transport` = 'stdio'
);
--> statement-breakpoint
DELETE FROM `user_mcp_oauth_tokens`
WHERE `mcp_server_id` IN (
  SELECT `mcp_server_id`
  FROM `mcp_servers`
  WHERE `transport` = 'stdio'
);
--> statement-breakpoint
UPDATE `mcp_servers`
SET `data` = json_remove(`data`, '$.auth', '$.url', '$.headers')
WHERE `transport` = 'stdio'
  AND (
    json_type(`data`, '$.auth') IS NOT NULL
    OR json_type(`data`, '$.url') IS NOT NULL
    OR json_type(`data`, '$.headers') IS NOT NULL
  );
