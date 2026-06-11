import type { AgorClient } from '@agor-live/client';

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
      .map((id) => client.service(`sessions/${sessionId}/mcp-servers`).create({ mcpServerId: id })),
    ...currentIds
      .filter((id) => !next.has(id))
      .map((id) => client.service(`sessions/${sessionId}/mcp-servers`).remove(id)),
  ]);
}
