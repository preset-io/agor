import type { AgorClient } from '@agor-live/client';
import { sessionMcpCreated, sessionMcpRemoved } from '../store/sessionMcpActions';

export async function updateSessionMcpServers(
  client: AgorClient,
  sessionId: string,
  currentIds: string[],
  nextIds: string[]
): Promise<void> {
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
