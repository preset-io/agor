/**
 * MCP server inheritance for new sessions: branch > user default, matching the
 * server-side `resolveSessionDefaults` walk below its "explicit override" tier.
 */

import type { Branch, User } from '@agor-live/client';

/** Inherited servers for a session form; `undefined` when neither source is set, so the daemon applies its own fallback. */
export function resolveSessionMcpServerIds(
  userDefaultMcpServerIds: string[] | undefined,
  branch?: Pick<Branch, 'mcp_server_ids'> | null
): string[] | undefined {
  const branchMcpIds = branch?.mcp_server_ids;
  return branchMcpIds && branchMcpIds.length > 0 ? branchMcpIds : userDefaultMcpServerIds;
}

/** Quick-start has no form to override anything in, so it always sends an explicit list. */
export function resolveQuickStartMcpServerIds(
  user: Pick<User, 'default_mcp_server_ids'> | null | undefined,
  branch: Pick<Branch, 'mcp_server_ids'> | null | undefined
): string[] {
  return resolveSessionMcpServerIds(user?.default_mcp_server_ids, branch) ?? [];
}
