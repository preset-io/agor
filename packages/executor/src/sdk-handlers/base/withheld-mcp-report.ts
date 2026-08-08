import { generateId } from '@agor/core';
import type { MCPServer, Message, MessageID, SessionID, TaskID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import type { MessagesRepository } from '../../db/feathers-repositories.js';

/** A server the admission gate refused to hand to a handler. */
export interface WithheldMcpServer {
  name: string;
  reason: string;
}

/**
 * Collect withheld servers during scoping so they can be reported afterwards.
 *
 * `onServerWithheld` fires synchronously inside resolution, which is the wrong
 * place to write a message: the index has to be read and used without another
 * writer landing in between. Buffering keeps the callback synchronous and
 * defers the writes to a single awaited point.
 */
export function collectWithheldMcpServers(): {
  withheld: WithheldMcpServer[];
  onServerWithheld: (server: MCPServer, reason: string) => void;
} {
  const withheld: WithheldMcpServer[] = [];
  return {
    withheld,
    onServerWithheld: (server, reason) => {
      withheld.push({ name: server.name, reason });
    },
  };
}

/**
 * Put withheld MCP servers where an operator will see them.
 *
 * `tool_permissions` has no UI, so an executor log is the only trace that a
 * server was dropped — and from inside the session, a server that silently
 * disappears is indistinguishable from one that is broken.
 *
 * Written one at a time so each notice reads the index the previous one
 * created, and awaited before the turn starts so they stay clear of the
 * messages the turn itself writes.
 */
export async function reportWithheldMcpServers(
  messagesRepo: MessagesRepository,
  args: {
    sessionId: SessionID;
    taskId: TaskID;
    withheld: readonly WithheldMcpServer[];
  }
): Promise<void> {
  for (const { name, reason } of args.withheld) {
    try {
      const message: Message = {
        message_id: generateId() as MessageID,
        session_id: args.sessionId,
        task_id: args.taskId,
        type: 'system',
        role: MessageRole.SYSTEM,
        index: await messagesRepo.countBySessionId(args.sessionId),
        timestamp: new Date().toISOString(),
        content_preview: `MCP server "${name}" withheld by tool permissions`,
        content: `MCP server "${name}" was withheld from this session: ${reason}`,
      };
      await messagesRepo.create(message);
    } catch (error) {
      console.warn(`[MCP] Could not report withheld server "${name}":`, error);
    }
  }
}
