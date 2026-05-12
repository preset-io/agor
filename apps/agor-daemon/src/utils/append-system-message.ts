/**
 * appendSystemMessage
 *
 * Appends a synthetic message to a session's transcript and broadcasts it via
 * the FeathersJS messages service (triggering real-time WebSocket events to all
 * connected clients). Used by startup reconciliation, spawn-failure handling,
 * env-var validation, and btw result injection.
 *
 * Returns the created Message. Callers that need to update a task's
 * message_range.end_index (e.g. startup.ts) can read it from message.index.
 */

import type { Database } from '@agor/core/db';
import { generateId, SessionRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  ContentBlock,
  Message,
  MessageID,
  MessageType,
  Params,
  SessionID,
  TaskID,
} from '@agor/core/types';
import { MessageRole } from '@agor/core/types';

export interface AppendSystemMessageOptions {
  app: Application;
  db: Database;
  sessionId: string;
  taskId?: string;
  content: string | ContentBlock[];
  /** Falls back to the first 200 chars of string content when omitted */
  contentPreview?: string;
  /** Defaults to 'system' */
  type?: Extract<MessageType, 'system' | 'daemon_restart' | 'daemon_crash'>;
  /** Defaults to MessageRole.SYSTEM */
  role?: Message['role'];
  metadata?: Message['metadata'];
  /** FeathersJS request params forwarded to the service create call */
  params?: Params;
}

export async function appendSystemMessage(opts: AppendSystemMessageOptions): Promise<Message> {
  const {
    app,
    db,
    sessionId,
    taskId,
    content,
    contentPreview,
    type = 'system',
    role = MessageRole.SYSTEM,
    metadata,
    params,
  } = opts;

  const index = await new SessionRepository(db).countMessages(sessionId);
  const preview = contentPreview ?? (typeof content === 'string' ? content.substring(0, 200) : '');

  const message: Message = {
    message_id: generateId() as MessageID,
    session_id: sessionId as SessionID,
    task_id: taskId as TaskID | undefined,
    type,
    role,
    index,
    timestamp: new Date().toISOString(),
    content_preview: preview,
    content,
    ...(metadata ? { metadata } : {}),
  };

  const created = await app.service('messages').create(message, params ?? {});

  return created as Message;
}
