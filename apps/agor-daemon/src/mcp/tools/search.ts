import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { coerceJsonRecord, textResult } from '../server.js';
import { ToolRegistry } from '../tool-registry.js';

/**
 * Registered tool entry from the SDK's internal _registeredTools map.
 * Cast required because this is a private SDK field.
 */
interface RegisteredTool {
  enabled: boolean;
  inputSchema?: {
    safeParse: (data: unknown) => { success: boolean; data?: unknown; error?: unknown };
  };
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
}

/**
 * Resolve tool arguments for the agor_execute_tool proxy.
 *
 * Handles two formats agents may use:
 *   1. Properly nested:  { tool_name: "X", arguments: { boardId: "..." } }
 *   2. Flattened:        { tool_name: "X", boardId: "..." }
 *
 * When `arguments` is empty/missing, extra top-level keys (preserved via
 * .passthrough()) are collected as a fallback.
 *
 * If the target tool has an inputSchema, the resolved args are validated
 * through it — mirroring the SDK's own validateToolInput step that the
 * proxy would otherwise bypass.
 */
function resolveToolArgs(
  proxyArgs: Record<string, unknown>,
  tool: RegisteredTool,
  toolName: string
): Record<string, unknown> {
  // Defense-in-depth: coerce stringified arguments even if Zod preprocess
  // already handled it (e.g. if the SDK bypasses schema validation).
  let toolArgs: Record<string, unknown> =
    (coerceJsonRecord(proxyArgs.arguments) as Record<string, unknown>) ?? {};

  if (Object.keys(toolArgs).length === 0) {
    // No nested arguments — check for flattened params at top level
    const extraArgs: Record<string, unknown> = {};
    for (const key of Object.keys(proxyArgs)) {
      if (key !== 'tool_name' && key !== 'arguments') {
        extraArgs[key] = proxyArgs[key];
      }
    }
    if (Object.keys(extraArgs).length > 0) {
      toolArgs = extraArgs;
    }
  }

  // Validate through target tool's input schema. The proxy bypasses the SDK's
  // normal validateToolInput step, so we parse explicitly for type coercion
  // and proper error messages.
  if (tool.inputSchema && typeof tool.inputSchema.safeParse === 'function') {
    const parseResult = tool.inputSchema.safeParse(toolArgs);
    if (parseResult.success) {
      return parseResult.data as Record<string, unknown>;
    }
    // Surface validation errors instead of letting them manifest as
    // confusing downstream failures (e.g. "Board not found: undefined").
    const errorDetail =
      parseResult.error && typeof parseResult.error === 'object' && 'message' in parseResult.error
        ? (parseResult.error as { message: string }).message
        : JSON.stringify(parseResult.error);
    throw new Error(`Invalid arguments for tool ${toolName}: ${errorDetail}`);
  }

  return toolArgs;
}

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
            .preprocess(
              // Some MCP clients double-serialize nested objects as JSON strings.
              // Coerce back to an object before Zod validates against z.record().
              coerceJsonRecord,
              z.record(z.string(), z.unknown())
            )
            .optional()
            .describe('Arguments to pass to the tool, matching its input schema'),
        })
        .passthrough(),
    },
    async (args) => {
      const toolName = args.tool_name;

      const registeredTools = (
        server as unknown as { _registeredTools: Record<string, RegisteredTool> }
      )._registeredTools;

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
        const toolArgs = resolveToolArgs(args as Record<string, unknown>, tool, toolName);
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
