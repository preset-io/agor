/**
 * Utility for resolving human-friendly display names for MCP proxy tools.
 *
 * MCP tools in Claude Code follow the naming convention: mcp__{server}__{tool}
 * e.g., mcp__agor__agor_execute_tool, mcp__agor__agor_search_tools
 *
 * With FastMCP's progressive discovery pattern, all tool calls go through
 * two proxy tools (execute_tool and search_tools), making the raw names
 * uninformative. This utility extracts the actual inner tool name from
 * the call arguments when available.
 */

/**
 * Parse an MCP-namespaced tool name into its server and tool parts.
 *
 * @example parseMcpToolName("mcp__agor__agor_execute_tool") → { server: "agor", tool: "agor_execute_tool" }
 * @example parseMcpToolName("Read") → null
 */
function parseMcpToolName(rawName: string): { server: string; tool: string } | null {
  // MCP tools always start with "mcp__" and have exactly 3 segments
  if (!rawName.startsWith('mcp__')) return null;

  const rest = rawName.slice(5); // Remove "mcp__"
  const sepIndex = rest.indexOf('__');
  if (sepIndex === -1) return null;

  return {
    server: rest.slice(0, sepIndex),
    tool: rest.slice(sepIndex + 2),
  };
}

/**
 * Resolve a display-friendly tool name, extracting inner tool names from
 * MCP execute/search proxy tools when possible.
 *
 * When input IS available (from message content blocks):
 * - mcp__agor__agor_execute_tool + input.tool_name="agor_worktrees_create"
 *   → "agor_worktrees_create"
 * - mcp__agor__agor_search_tools + input.query="worktrees"
 *   → "search_tools: worktrees"
 * - mcp__agor__agor_search_tools + input.domain="sessions"
 *   → "search_tools: sessions"
 *
 * When input is NOT available (real-time streaming events):
 * - mcp__agor__agor_execute_tool → "agor_execute_tool"
 * - mcp__slack__some_tool → "some_tool"
 *
 * Non-MCP tools pass through unchanged:
 * - "Read" → "Read"
 * - "Bash" → "Bash"
 */
export function getToolDisplayName(rawName: string, input?: Record<string, unknown>): string {
  const parsed = parseMcpToolName(rawName);

  // Not an MCP tool — return as-is
  if (!parsed) return rawName;

  // With input available, try to extract the inner tool name
  if (input) {
    // Execute-style proxy: extract the actual tool being called
    if (parsed.tool.includes('execute_tool') && typeof input.tool_name === 'string') {
      return input.tool_name;
    }

    // Search-style proxy: show what's being searched for
    if (parsed.tool.includes('search_tool')) {
      if (typeof input.query === 'string') {
        return `search_tools: ${input.query}`;
      }
      if (typeof input.domain === 'string') {
        return `search_tools: ${input.domain}`;
      }
      // No specific query — show "search_tools: browse"
      return 'search_tools: browse';
    }
  }

  // Fallback: strip the mcp__{server}__ prefix to show just the tool name
  return parsed.tool;
}

/**
 * Check if a tool name is an MCP tool (has the mcp__ prefix).
 */
export function isMcpTool(rawName: string): boolean {
  return rawName.startsWith('mcp__');
}
