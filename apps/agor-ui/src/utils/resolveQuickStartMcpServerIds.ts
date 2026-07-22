/**
 * MCP server inheritance for quick-start session creation.
 *
 * Mirrors the branch > user-default precedence `NewSessionModal` already
 * uses when a form field is left untouched (see its `mcpServerIds` fallback
 * in `handleCreate`), and the server-side `resolveSessionDefaults` walk —
 * just without the "explicit override" tier, since quick-start has no form
 * for the user to override anything in.
 */

import type { Branch, User } from '@agor-live/client';

export function resolveQuickStartMcpServerIds(
  user: Pick<User, 'default_mcp_server_ids'> | null | undefined,
  branch: Pick<Branch, 'mcp_server_ids'> | null | undefined
): string[] {
  const branchMcpIds = branch?.mcp_server_ids;
  if (branchMcpIds && branchMcpIds.length > 0) return branchMcpIds;
  return user?.default_mcp_server_ids ?? [];
}
