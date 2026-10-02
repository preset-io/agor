import type { AgorClient } from '@agor-live/client';
import { agorStore } from '../store/agorStore';
import { sessionMcpCreated, sessionMcpRemoved } from '../store/sessionMcpActions';

export class SessionMcpNotLoadedError extends Error {
  constructor() {
    super('Attached MCP servers are still loading; try again');
    this.name = 'SessionMcpNotLoadedError';
  }
}

/**
 * Apply the difference between `currentIds` and `nextIds`. Refuses unless the
 * session's links are loaded (`sessionMcpLinks`): until then `currentIds` may
 * be partial, and a diff against it would detach links nobody saw.
 */
export async function updateSessionMcpServers(
  client: AgorClient,
  sessionId: string,
  currentIds: string[],
  nextIds: string[]
): Promise<void> {
  if (!agorStore.getState().sessionMcpLoaded.has(sessionId)) throw new SessionMcpNotLoadedError();
  const current = new Set(currentIds);
  const next = new Set(nextIds);

  await Promise.all([
    ...nextIds
      .filter((id) => !current.has(id))
      .map(async (id) => {
        await client.service(`sessions/${sessionId}/mcp-servers`).create({ mcpServerId: id });
        // The REST response confirms persistence. Apply it immediately rather
        // than making the UI depend on a subsequent websocket echo. The
        // realtime action is idempotent, so the normal socket event is a no-op.
        sessionMcpCreated({ session_id: sessionId, mcp_server_id: id });
      }),
    ...currentIds
      .filter((id) => !next.has(id))
      .map(async (id) => {
        await client.service(`sessions/${sessionId}/mcp-servers`).remove(id);
        sessionMcpRemoved({ session_id: sessionId, mcp_server_id: id });
      }),
  ]);
}
