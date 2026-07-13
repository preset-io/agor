ALTER TABLE `schedules` ADD `mcp_server_ids` text;
--> statement-breakpoint
UPDATE `schedules`
SET `mcp_server_ids` = json_extract(`agentic_tool_config`, '$.mcp_server_ids'),
    `agentic_tool_config` = json_remove(`agentic_tool_config`, '$.mcp_server_ids')
WHERE json_type(`agentic_tool_config`, '$.mcp_server_ids') = 'array';
--> statement-breakpoint
ALTER TABLE `gateway_channels` ADD `mcp_server_ids` text;
--> statement-breakpoint
UPDATE `gateway_channels`
SET `mcp_server_ids` = json_extract(`agentic_config`, '$.mcpServerIds'),
    `agentic_config` = json_remove(`agentic_config`, '$.mcpServerIds')
WHERE json_type(`agentic_config`, '$.mcpServerIds') = 'array';
