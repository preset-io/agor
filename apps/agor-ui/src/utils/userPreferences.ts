import type { AgorClient, User, UserPreferences } from '@agor-live/client';

/**
 * Preferences patch as a whole object: re-read the user right before the write so a setting
 * changed elsewhere (another tab, Settings) survives, then lay `partial` over it. Pass a
 * function to derive the partial from the latest preferences.
 */
export async function patchUserPreferences(
  client: AgorClient,
  userId: string,
  partial:
    | Partial<UserPreferences>
    | ((latest: UserPreferences | undefined) => Partial<UserPreferences>)
): Promise<User> {
  const latest = (await client.service('users').get(userId)) as User;
  const next = typeof partial === 'function' ? partial(latest.preferences) : partial;
  return (await client
    .service('users')
    .patch(userId, { preferences: { ...latest.preferences, ...next } })) as User;
}

/** Hide or unhide a global MCP server's connect row for this user. */
export function setMcpServerHidden(
  client: AgorClient,
  userId: string,
  mcpServerId: string,
  hidden: boolean
): Promise<User> {
  return patchUserPreferences(client, userId, (latest) => {
    const ids = new Set(latest?.hidden_mcp_server_ids ?? []);
    if (hidden) ids.add(mcpServerId);
    else ids.delete(mcpServerId);
    return { hidden_mcp_server_ids: [...ids] };
  });
}
