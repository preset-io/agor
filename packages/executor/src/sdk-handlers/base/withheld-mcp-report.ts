import { generateId } from '@agor/core';
import type { MessageID, SessionID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import type { AgorClient } from '../../services/feathers-client.js';

/**
 * Put a withheld MCP server where an operator will see it.
 *
 * `tool_permissions` has no UI, so an executor log is the only trace that a
 * server was dropped — and from inside the session, a server that silently
 * disappears is indistinguishable from one that is broken.
 */
export async function reportWithheldMcpServer(
  client: AgorClient,
  sessionId: SessionID,
  serverName: string,
  reason: string
): Promise<void> {
  try {
    const existing = await client.service('messages').find({
      query: { session_id: sessionId, $sort: { index: 1 } },
    });
    const messages = Array.isArray(existing) ? existing : existing.data;

    await client.service('messages').create({
      message_id: generateId() as MessageID,
      session_id: sessionId,
      type: 'system' as const,
      role: MessageRole.SYSTEM,
      index: messages.length,
      timestamp: new Date().toISOString(),
      content_preview: `MCP server "${serverName}" withheld by tool permissions`,
      content: `MCP server "${serverName}" was withheld from this session: ${reason}`,
    });
  } catch (error) {
    console.warn(`[MCP] Could not report withheld server "${serverName}":`, error);
  }
}
