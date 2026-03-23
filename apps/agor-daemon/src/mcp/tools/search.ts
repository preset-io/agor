import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from '../server.js';
import type { ToolRegistry } from '../tool-registry.js';

export function registerSearchTools(server: McpServer, registry: ToolRegistry): void {
  server.registerTool(
    'agor_search_tools',
    {
      description:
        'Search for available Agor MCP tools by keyword. Returns tool names, descriptions, and input schemas so you know how to call them. Call agor_execute_tool to invoke a discovered tool.',
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            'Search keywords (e.g. "worktree create", "cards", "environment", "board zone")'
          ),
        max_results: z.number().optional().describe('Max results to return (default: 10)'),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const results = registry.search(args.query, args.max_results ?? 10);
      return textResult({
        total_available: registry.size,
        results_count: results.length,
        tools: results,
      });
    }
  );

  server.registerTool(
    'agor_execute_tool',
    {
      description:
        'Execute an Agor MCP tool by name. Use agor_search_tools first to discover available tools and their input schemas, then call this to invoke them.',
      inputSchema: z.object({
        tool_name: z.string().describe('The tool name to execute (e.g. "agor_worktrees_list")'),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Arguments to pass to the tool, matching its input schema'),
      }),
    },
    async (args) => {
      const toolName = args.tool_name;

      // Access the internal registered tools map
      // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK internals for proxy dispatch
      const registeredTools = (server as any)._registeredTools as Record<
        string,
        { enabled: boolean; handler: (args: unknown, extra: unknown) => Promise<unknown> }
      >;

      const tool = registeredTools[toolName];
      if (!tool) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: `Tool "${toolName}" not found. Use agor_search_tools to discover available tools.`,
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        // Invoke the tool handler directly with provided arguments
        const result = await tool.handler(args.arguments ?? {}, {});
        return result as { content: Array<{ type: 'text'; text: string }> };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
                tool: toolName,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
