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
      inputSchema: z
        .object({
          tool_name: z.string().describe('The tool name to execute (e.g. "agor_worktrees_list")'),
          arguments: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Arguments to pass to the tool, matching its input schema'),
        })
        .passthrough(),
    },
    async (args) => {
      const toolName = args.tool_name;

      // Access the internal registered tools map (private SDK field, cast required)
      type RegisteredToolsMap = Record<
        string,
        {
          enabled: boolean;
          inputSchema?: unknown;
          handler: (args: unknown, extra: unknown) => Promise<unknown>;
        }
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
        // Build tool arguments — handle both properly nested and flattened formats.
        // Agents sometimes place tool parameters at the top level alongside tool_name
        // instead of nesting them under the "arguments" key (due to the confusing
        // double-nesting of MCP's own "arguments" field and our "arguments" param).
        let toolArgs: Record<string, unknown> = args.arguments ?? {};

        if (Object.keys(toolArgs).length === 0) {
          // No nested arguments provided — check for flattened params at top level
          const allArgs = args as Record<string, unknown>;
          const extraArgs: Record<string, unknown> = {};
          for (const key of Object.keys(allArgs)) {
            if (key !== 'tool_name' && key !== 'arguments') {
              extraArgs[key] = allArgs[key];
            }
          }
          if (Object.keys(extraArgs).length > 0) {
            toolArgs = extraArgs;
          }
        }

        // Validate through target tool's input schema. The proxy bypasses the SDK's
        // normal validateToolInput step, so we need to parse explicitly to get proper
        // type coercion and validation error messages.
        type ZodLike = { safeParse: (data: unknown) => { success: boolean; data?: unknown } };
        const inputSchema = tool.inputSchema as ZodLike | undefined;
        if (inputSchema && typeof inputSchema.safeParse === 'function') {
          const parseResult = inputSchema.safeParse(toolArgs);
          if (parseResult.success) {
            toolArgs = parseResult.data as Record<string, unknown>;
          }
          // If validation fails, still try with raw args — the handler may do its own validation
        }

        // Invoke the tool handler with the resolved arguments
        const result = await tool.handler(toolArgs, {});
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
