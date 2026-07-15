ALTER TABLE "schedules" ADD COLUMN "mcp_server_ids" jsonb;
--> statement-breakpoint
UPDATE "schedules"
SET "mcp_server_ids" = "agentic_tool_config"->'mcp_server_ids',
    "agentic_tool_config" = "agentic_tool_config" - 'mcp_server_ids'
WHERE jsonb_typeof("agentic_tool_config"->'mcp_server_ids') = 'array';
--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD COLUMN "mcp_server_ids" jsonb;
--> statement-breakpoint
UPDATE "gateway_channels"
SET "mcp_server_ids" = "agentic_config"->'mcpServerIds',
    "agentic_config" = "agentic_config" - 'mcpServerIds'
WHERE jsonb_typeof("agentic_config"->'mcpServerIds') = 'array';
