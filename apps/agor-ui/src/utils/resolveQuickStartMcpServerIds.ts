/**
 * MCP server inheritance for new sessions: branch > user default, matching the
 * server-side `resolveSessionDefaults` walk below its "explicit override" tier.
 */

import type { Branch } from '@agor-live/client';

/** Display-only inheritance preview. Never send these IDs as an explicit create selection. */
export function resolveSessionMcpServerIds(
  userDefaultMcpServerIds: string[] | undefined,
  branch?: Pick<Branch, 'mcp_server_ids'> | null
): string[] | undefined {
  const branchMcpIds = branch?.mcp_server_ids;
  return branchMcpIds && branchMcpIds.length > 0 ? branchMcpIds : userDefaultMcpServerIds;
}
