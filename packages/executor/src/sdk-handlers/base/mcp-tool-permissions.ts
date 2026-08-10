/**
 * Per-tool MCP permission resolution.
 *
 * `mcp_servers.data.tool_permissions` is keyed on the BARE tool name exactly as
 * the MCP server advertises it (`create_pull_request`). Handlers that gate tools
 * through per-server config (Gemini `excludeTools`, Codex `disabled_tools`,
 * Copilot `tools`) use those keys directly and only need
 * `listMcpToolsWithPermission`.
 *
 * The policy half — whether a handler may be handed a server at all — lives in
 * `@agor/core/mcp`, where the scoping gate consumes it. What stays here is the
 * SDK-name machinery, because it encodes how each vendor mangles names and core
 * has no business knowing that.
 *
 * The index exists for the one handler that must decide at call time from a
 * name the SDK invented: Claude, which surfaces MCP tools as
 * `mcp__<server>__<tool>`. Lookups are therefore always server-qualified —
 * there is deliberately no bare-name fallback, because a bare key could only
 * match a qualified string by coincidence, and that coincidence would deny an
 * unrelated tool.
 */

import type { MCPServer, ToolPermission } from '@agor/core/types';

const SEPARATOR = '__';
const CLAUDE_MCP_PREFIX = `mcp${SEPARATOR}`;

/** Ranked most-permissive-first, so a larger value is the safer answer. */
const RESTRICTIVENESS: Record<ToolPermission, number> = { allow: 0, ask: 1, deny: 2 };

export interface McpToolPermissionIndex {
  /** Server name (raw and SDK-rewritten) → bare tool name → permission. */
  readonly byServer: ReadonlyMap<string, ReadonlyMap<string, ToolPermission>>;
}

export const EMPTY_MCP_TOOL_PERMISSION_INDEX: McpToolPermissionIndex = {
  byServer: new Map(),
};

/**
 * The alphabet SDKs rewrite names into before embedding them in a tool name.
 *
 * Deliberately narrower than any single SDK's: a character we leave in but the
 * SDK rewrites would make a lookup miss, and a miss reads as "unconfigured",
 * i.e. allow.
 */
function sanitizeToToolNameAlphabet(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Indexing the rewritten server forms alongside the raw one keeps lookups
 * working for servers named e.g. "preset sdx" or "my.server". Codex also
 * lowercases, so that variant is indexed too.
 */
export function mcpToolNameAliasesForServer(name: string): string[] {
  const sanitized = sanitizeToToolNameAlphabet(name);
  return [name, sanitized, sanitized.toLowerCase()];
}

/**
 * Both halves of a namespaced tool name get rewritten, not just the server.
 *
 * `tool_permissions` is keyed on the bare name exactly as the MCP server
 * advertises it, and a server is free to advertise `repo.create`. Claude builds
 * `mcp__<rewritten server>__<rewritten tool>` and matches rules against that,
 * so a permission stored under the raw key would never bind — the same silent
 * fail-open the server half already guards against.
 *
 * No lowercase variant here: the rewrite that produces the name being matched
 * preserves case, and folding it would let a `Foo` denial capture an unrelated
 * `foo` on the same server.
 */
export function mcpToolNameAliasesForTool(name: string): string[] {
  return [name, sanitizeToToolNameAlphabet(name)];
}

export function buildMcpToolPermissionIndex(servers: MCPServer[]): McpToolPermissionIndex {
  const byServer = new Map<string, Map<string, ToolPermission>>();

  for (const server of servers) {
    const configured = server.tool_permissions;
    if (!configured || Object.keys(configured).length === 0) continue;

    for (const serverAlias of new Set(mcpToolNameAliasesForServer(server.name))) {
      // Two servers can share an alias ("foo.bar" and "foo_bar" both rewrite to
      // "foo_bar"). Overwriting would drop the first server's denials on the
      // floor, so entries merge and the most restrictive value survives. Tool
      // aliases collide the same way and merge on the same rule.
      let tools = byServer.get(serverAlias);
      if (!tools) {
        tools = new Map<string, ToolPermission>();
        byServer.set(serverAlias, tools);
      }
      for (const [toolName, permission] of Object.entries(configured)) {
        for (const toolAlias of new Set(mcpToolNameAliasesForTool(toolName))) {
          const current = tools.get(toolAlias);
          if (!current || RESTRICTIVENESS[permission] > RESTRICTIVENESS[current]) {
            tools.set(toolAlias, permission);
          }
        }
      }
    }
  }

  return { byServer };
}

/**
 * Resolve the configured permission for a tool name as an SDK surfaced it.
 *
 * Returns `undefined` when nothing is configured — callers must treat that as
 * "unchanged behaviour", never as an implicit allow or deny.
 */
export function resolveMcpToolPermission(
  index: McpToolPermissionIndex,
  sdkToolName: string
): ToolPermission | undefined {
  const qualified = sdkToolName.startsWith(CLAUDE_MCP_PREFIX)
    ? sdkToolName.slice(CLAUDE_MCP_PREFIX.length)
    : sdkToolName;

  // Longest prefix wins so a server named "github" can't shadow "github_enterprise".
  let matchedServerName: string | undefined;
  for (const serverName of index.byServer.keys()) {
    if (!qualified.startsWith(`${serverName}${SEPARATOR}`)) continue;
    if (!matchedServerName || serverName.length > matchedServerName.length) {
      matchedServerName = serverName;
    }
  }

  if (!matchedServerName) return undefined;

  const bareName = qualified.slice(matchedServerName.length + SEPARATOR.length);
  return index.byServer.get(matchedServerName)?.get(bareName);
}
