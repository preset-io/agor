/**
 * Policy vocabulary for `mcp_servers.data.tool_permissions`.
 *
 * This half answers "may this handler be handed this server at all?", which is
 * what the scoping gate needs. The other half — translating a tool name an SDK
 * invented back to the bare key permissions are stored under — stays with the
 * handlers, because it encodes how each vendor SDK mangles names and core has
 * no business knowing that.
 */

import type { MCPServer, ToolPermission } from '../types';

/**
 * Permissions a handler with no interactive approval flow must refuse.
 *
 * Codex and Gemini run headless — there is no channel to surface a prompt on —
 * so `ask` degrades to a refusal there rather than silently becoming `allow`.
 */
export const PERMISSIONS_BLOCKED_WITHOUT_PROMPT: readonly ToolPermission[] = ['deny', 'ask'];

/**
 * What a handler can actually do about `tool_permissions`.
 *
 * Required at the resolution boundary rather than assumed, because the way this
 * control failed the first time was silent: several handlers resolved MCP
 * servers, some enforced, and the rest kept reporting success while ignoring
 * every `deny`.
 */
export interface HandlerPermissionCapabilities {
  /**
   * Whether the handler can name a tool to drop in the config it hands its SDK
   * (`exclude`) or has no per-tool control at all (`none`).
   *
   * Deliberately not "can express a tool set". An include-list can only say
   * "all but these" by enumerating the survivors, and the only inventory
   * available here is `server.tools` — a cached discovery snapshot that no SDK
   * reads and that nothing proves is current. Enforcing from it would turn a
   * stale cache into the authoritative tool set.
   */
  toolFiltering: 'exclude' | 'none';
}

/** Bare tool names on `server` whose configured permission is one of `permissions`. */
export function listMcpToolsWithPermission(
  server: MCPServer,
  permissions: readonly ToolPermission[]
): string[] {
  const configured = server.tool_permissions;
  if (!configured) return [];

  return Object.entries(configured)
    .filter(([, permission]) => permissions.includes(permission))
    .map(([toolName]) => toolName);
}

/**
 * Whether `server`'s configured permissions can be honoured under `caps`.
 *
 * A handler that cannot honour them must not be handed the server at all —
 * attaching it anyway would expose exactly the tools someone switched off.
 */
export function canEnforceMcpToolPermissions(
  server: MCPServer,
  caps: HandlerPermissionCapabilities
): boolean {
  const gated = listMcpToolsWithPermission(server, PERMISSIONS_BLOCKED_WITHOUT_PROMPT);
  if (gated.length === 0) return true;

  switch (caps.toolFiltering) {
    case 'exclude':
      return true;
    case 'none':
      return false;
  }
}
