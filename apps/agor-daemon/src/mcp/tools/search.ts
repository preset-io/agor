import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from '../server.js';
import { ToolRegistry } from '../tool-registry.js';

export function registerSearchTools(server: McpServer, registry: ToolRegistry): void {
  server.registerTool(
    'agor_search_tools',
    {
      description:
        'Search and browse available Agor MCP tools. Call with no args to see domains overview. Filter by domain, keyword, or annotation. Use detail="full" to get input schemas before calling agor_execute_tool.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            'Search keywords (e.g. "worktree create", "cards", "environment"). Omit to browse by domain.'
          ),
        domain: z
          .string()
          .optional()
          .describe(
            'Filter by domain (e.g. "sessions", "worktrees", "boards", "cards", "environment")'
          ),
        detail: z
          .enum(['list', 'full'])
          .optional()
          .describe(
            'Detail level: "list" returns name+description (default), "full" includes inputSchema and annotations'
          ),
        read_only: z.boolean().optional().describe('Filter to read-only tools only'),
        destructive: z.boolean().optional().describe('Filter to destructive tools only'),
        max_results: z.number().optional().describe('Max results to return (default: 10)'),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const domains = registry.listDomains();
      const detail = args.detail ?? 'list';

      // No query and no domain filter — return domains overview only
      if (
        !args.query &&
        !args.domain &&
        args.read_only === undefined &&
        args.destructive === undefined
      ) {
        return textResult({
          total_available: registry.size,
          domains,
          hint: 'Use domain or query params to discover specific tools. Use detail="full" to get input schemas.',
        });
      }

      const results = registry.search(args.query, {
        maxResults: args.max_results ?? 10,
        domain: args.domain,
        readOnly: args.read_only,
        destructive: args.destructive,
      });

      const tools = detail === 'full' ? results : ToolRegistry.toSummaries(results);

      return textResult({
        total_available: registry.size,
        domains,
        results_count: results.length,
        tools,
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

      // Access the internal registered tools map (private SDK field, cast required)
      type RegisteredToolsMap = Record<
        string,
        { enabled: boolean; handler: (args: unknown, extra: unknown) => Promise<unknown> }
      >;
      const registeredTools = (server as unknown as { _registeredTools: RegisteredToolsMap })
        ._registeredTools;

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
