/**
 * Utility for resolving human-friendly display names for MCP proxy tools.
 *
 * Different SDKs format MCP tool names differently:
 * - Claude Code: mcp__{server}__{tool}  (e.g., mcp__agor__agor_execute_tool)
 * - Codex:       {server}.{tool}        (e.g., agor.agor_execute_tool)
 *
 * With FastMCP's progressive discovery pattern, all tool calls go through
 * two proxy tools (execute_tool and search_tools), making the raw names
 * uninformative. This utility extracts the actual inner tool name from
 * the call arguments when available.
 */

/**
 * Parse an MCP-namespaced tool name into its server and tool parts.
 * Supports both Claude Code (mcp__server__tool) and Codex (server.tool) formats.
 *
 * @example parseMcpToolName("mcp__agor__agor_execute_tool") → { server: "agor", tool: "agor_execute_tool" }
 * @example parseMcpToolName("agor.agor_execute_tool") → { server: "agor", tool: "agor_execute_tool" }
 * @example parseMcpToolName("Read") → null
 */
function parseMcpToolName(rawName: string): { server: string; tool: string } | null {
  // Claude Code format: mcp__{server}__{tool}
  // Splits on the first __ after "mcp__" — server names should not contain "__"
  if (rawName.startsWith('mcp__')) {
    const rest = rawName.slice(5); // Remove "mcp__"
    const sepIndex = rest.indexOf('__');
    if (sepIndex === -1) return null;

    return {
      server: rest.slice(0, sepIndex),
      tool: rest.slice(sepIndex + 2),
    };
  }

  // Codex format: {server}.{tool}
  // Only match if there's exactly one dot and the tool part looks like a tool name
  const dotIndex = rawName.indexOf('.');
  if (dotIndex > 0 && dotIndex < rawName.length - 1) {
    return {
      server: rawName.slice(0, dotIndex),
      tool: rawName.slice(dotIndex + 1),
    };
  }

  return null;
}

/**
 * Resolve a display-friendly tool name, extracting inner tool names from
 * MCP execute/search proxy tools when possible.
 *
 * When input IS available (from message content blocks):
 * - mcp__agor__agor_execute_tool + input.tool_name="agor_worktrees_create"
 *   → "agor_worktrees_create"
 * - agor.agor_execute_tool + input.tool_name="agor_worktrees_create"
 *   → "agor_worktrees_create"
 * - mcp__agor__agor_search_tools + input.query="worktrees"
 *   → "search_tools: worktrees"
 *
 * When input is NOT available (real-time streaming events):
 * - mcp__agor__agor_execute_tool → "agor_execute_tool"
 * - agor.agor_execute_tool → "agor_execute_tool"
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
    if (parsed.tool.endsWith('execute_tool') && typeof input.tool_name === 'string') {
      return input.tool_name;
    }

    // Search-style proxy: show what's being searched for
    if (parsed.tool.endsWith('search_tools')) {
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

  // Fallback: strip the server prefix to show just the tool name
  return parsed.tool;
}

/**
 * Check if a tool name is an MCP tool (has the mcp__ prefix or server.tool format).
 */
export function isMcpTool(rawName: string): boolean {
  return rawName.startsWith('mcp__') || parseMcpToolName(rawName) !== null;
}
