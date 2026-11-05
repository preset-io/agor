import type { AgorClient, User, UserPreferences } from '@agor-live/client';

/**
 * Preferences patch as a whole object: re-read the user right before the write so a setting
 * changed elsewhere (another tab, Settings) survives, then lay `partial` over it.
 */
export async function patchUserPreferences(
  client: AgorClient,
  userId: string,
  partial: Partial<UserPreferences>
): Promise<User> {
  const latest = (await client.service('users').get(userId)) as User;
  return (await client
    .service('users')
    .patch(userId, { preferences: { ...latest.preferences, ...partial } })) as User;
}

/** Hide or unhide a global MCP server's connect row for this user. */
export async function setMcpServerHidden(
  client: AgorClient,
  userId: string,
  mcpServerId: string,
  hidden: boolean
): Promise<User> {
  const latest = (await client.service('users').get(userId)) as User;
  const current = new Set(latest.preferences?.hidden_mcp_server_ids ?? []);
  if (hidden) current.add(mcpServerId);
  else current.delete(mcpServerId);
  return (await client.service('users').patch(userId, {
    preferences: { ...latest.preferences, hidden_mcp_server_ids: [...current] },
  })) as User;
}
