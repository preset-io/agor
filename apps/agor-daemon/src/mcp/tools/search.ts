import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from '../server.js';
import type { ToolRegistry } from '../tool-registry.js';

export function registerSearchTools(server: McpServer, registry: ToolRegistry): void {
  server.registerTool(
    'agor_search_tools',
    {
      description:
        'Search for available Agor MCP tools by keyword. Returns tool names, descriptions, and input schemas so you know how to call them. Use this to discover tools before calling them.',
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
}
