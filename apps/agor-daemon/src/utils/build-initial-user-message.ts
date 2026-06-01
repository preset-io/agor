/**
 * buildInitialUserMessage
 *
 * Constructs the canonical "first message of a task" row written by
 * both:
 *
 *   - `/sessions/:id/prompt` (the textarea / MCP entry point) when
 *     the `daemon_writes_user_message` kill switch is enabled. Each
 *     turn opens a new task and the user prompt is its first message.
 *   - The Claude Code CLI watcher's terminal-direct branch
 *     (`buildCliEventSink`) when claude's JSONL transcript fires a
 *     `user_message` event for a turn that didn't come through
 *     `/prompt`. The watcher mints a task on the fly and writes the
 *     user row itself.
 *
 * Without this helper the two call sites would drift independently —
 * `content_preview` length, metadata shape, type discriminator, etc.
 * Keep the row shape here; the caller picks `type` ('user' vs the
 * 'system' callback variant) and supplies `metadata`.
 *
 * Pure function — no DB write, no service call. Caller does
 * `app.service('messages').create(buildInitialUserMessage(...))`.
 */

import { generateId } from '@agor/core/db';
import type { ContentBlock, Message, MessageType, SessionID, TaskID, UUID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';

const CONTENT_PREVIEW_MAX_CHARS = 200;

export interface BuildInitialUserMessageInput {
  sessionId: SessionID;
  /** Task this message opens. Optional only for v1 orphan-fallback paths. */
  taskId: TaskID | undefined;
  /** Sequential per-session index — caller owns allocation. */
  index: number;
  /** ISO 8601. */
  timestamp: string;
  /** Raw prompt content. String for textarea/CLI; array for callbacks. */
  content: string | ContentBlock[];
  /**
   * `'user'` for normal prompts, `'system'` for the Agor-callback
   * variant. The role is always `'user'` regardless.
   */
  type?: MessageType;
  /** Free-form metadata blob — `source`, `original_id`, callback flags. */
  metadata?: Message['metadata'];
}

export function buildInitialUserMessage(input: BuildInitialUserMessageInput): Message {
  const preview =
    typeof input.content === 'string'
      ? input.content.slice(0, CONTENT_PREVIEW_MAX_CHARS)
      : safeStringify(input.content).slice(0, CONTENT_PREVIEW_MAX_CHARS);
  return {
    message_id: generateId() as UUID as Message['message_id'],
    session_id: input.sessionId,
    task_id: input.taskId,
    type: input.type ?? 'user',
    role: MessageRole.USER,
    index: input.index,
    timestamp: input.timestamp,
    content_preview: preview,
    content: input.content,
    metadata: input.metadata,
  };
}

function safeStringify(value: unknown): string {
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
