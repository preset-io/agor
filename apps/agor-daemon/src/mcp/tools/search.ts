import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mcpPositiveIntWithDefault, mcpRequiredString } from '../schema.js';
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

const DISCOVERY_HINT =
  'Discover tool names with agor_search_tools (call with no args for domains, or with { "query": "sessions" }). Get an exact schema with agor_get_tool_details({ "tool_name": "..." }).';

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
      const parsedArgs = parseResult.data as Record<string, unknown>;
      const unknownArgs = Object.keys(toolArgs).filter((key) => !Object.hasOwn(parsedArgs, key));
      if (unknownArgs.length > 0) {
        throw new Error(
          `Invalid arguments for tool ${toolName}: unknown argument${unknownArgs.length === 1 ? '' : 's'} ${unknownArgs.map((arg) => `"${arg}"`).join(', ')}. ` +
            `Call agor_get_tool_details({ "tool_name": "${toolName}" }) for the exact schema.`
        );
      }
      return parsedArgs;
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

function resolveProxyToolName(args: Record<string, unknown>): string {
  const toolName = typeof args.tool_name === 'string' ? args.tool_name : undefined;
  if (!toolName) {
    const keys = Object.keys(args);
    throw new Error(
      `Missing required agor_execute_tool field "tool_name". ` +
        `Use { "tool_name": "agor_branches_list", "arguments": { ... } }. ` +
        `${DISCOVERY_HINT} ` +
        `Received top-level keys: ${keys.length > 0 ? keys.join(', ') : '(none)'}.`
    );
  }

  return toolName;
}

export function registerSearchTools(server: McpServer, registry: ToolRegistry): void {
  server.registerTool(
    'agor_search_tools',
    {
      description:
        'Search and browse available Agor MCP tools. Call with no args to see domain overview. Use query/domain filters to find matching tools. Returns concise tool summaries by default; use agor_get_tool_details for exact input schemas.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            'Search keywords (e.g. "branch create", "cards", "environment"). Omit to browse by domain.'
          ),
        domain: z
          .string()
          .optional()
          .describe(
            'Filter by domain (e.g. "sessions", "branches", "boards", "cards", "environment").'
          ),
        detail: z
          .enum(['list', 'full'])
          .optional()
          .describe(
            'Detail level. Prefer "list" (default) for concise results. "full" is retained for compatibility; prefer agor_get_tool_details for exact schemas.'
          ),
        read_only: z.boolean().optional().describe('Filter to read-only tools only'),
        destructive: z.boolean().optional().describe('Filter to destructive tools only'),
        max_results: mcpPositiveIntWithDefault('max_results', 10).describe(
          'Max results to return (default: 10)'
        ),
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
          hint: 'Use query/domain params to find specific tools. Then call agor_get_tool_details with the selected tool_name for the exact schema.',
        });
      }

      const results = registry.search(args.query, {
        maxResults: args.max_results ?? 10,
        domain: args.domain,
        readOnly: args.read_only,
        destructive: args.destructive,
      });

      const fullDetailsRequested = detail === 'full';
      const fullDetailsReturned = fullDetailsRequested && results.length === 1;
      const tools = fullDetailsReturned ? results : ToolRegistry.toSummaries(results);

      return textResult({
        total_available: registry.size,
        domains,
        results_count: results.length,
        tools,
        hint:
          fullDetailsRequested && !fullDetailsReturned
            ? 'detail:"full" only returns schemas after the result set is narrowed to one tool. Use max_results:1 or, preferably, agor_get_tool_details({ tool_name }) for one exact schema at a time.'
            : fullDetailsReturned
              ? 'Use agor_execute_tool with this tool_name and arguments matching inputSchema.'
              : 'Call agor_get_tool_details({ tool_name }) for the exact input schema before executing.',
      });
    }
  );

  server.registerTool(
    'agor_get_tool_details',
    {
      description:
        'Get exact details for one Agor MCP tool, including its input schema and annotations. Use this after agor_search_tools selects a tool and before agor_execute_tool calls it.',
      inputSchema: z.object({
        tool_name: mcpRequiredString(
          'tool_name',
          'The tool name to inspect (e.g. "agor_sessions_list")',
          {
            example: '{ "tool_name": "agor_sessions_list" }',
          }
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const tool = registry.get(args.tool_name);
      if (!tool) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: `Tool "${args.tool_name}" not found.`,
                how_to_find_tools:
                  'Call agor_search_tools with no args for domains, or with { "query": "keyword" } / { "domain": "sessions" } to find tool names.',
              }),
            },
          ],
          isError: true,
        };
      }

      return textResult({
        tool,
        usage: {
          execute_with: {
            tool_name: tool.name,
            arguments: '<object matching inputSchema>',
          },
          note: 'Call agor_execute_tool with this tool_name and arguments matching inputSchema.',
        },
      });
    }
  );

  server.registerTool(
    'agor_execute_tool',
    {
      description:
        'Execute one Agor MCP tool by name. Expected shape: { "tool_name": "agor_sessions_list", "arguments": { ... } }. Use agor_search_tools to find tools and agor_get_tool_details for the exact schema.',
      inputSchema: z
        .object({
          tool_name: mcpRequiredString(
            'tool_name',
            'The tool name to execute (e.g. "agor_branches_list")',
            {
              example:
                '{ "tool_name": "agor_branches_list", "arguments": { ... } }. Use agor_search_tools to find tool names and agor_get_tool_details for schemas.',
            }
          ),
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
      const proxyArgs = args as Record<string, unknown>;
      let toolName: string | undefined;

      try {
        toolName = resolveProxyToolName(proxyArgs);

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
                  error: `Tool "${toolName}" not found.`,
                  how_to_find_tools:
                    'Call agor_search_tools with no args for domains, or with { "query": "keyword" } / { "domain": "sessions" }. Then call agor_get_tool_details({ "tool_name": "..." }) for the exact schema.',
                }),
              },
            ],
            isError: true,
          };
        }

        const toolArgs = resolveToolArgs(proxyArgs, tool, toolName);
        const result = await tool.handler(toolArgs, {});
        return result as { content: Array<{ type: 'text'; text: string }> };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
                ...(toolName && { tool: toolName }),
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
