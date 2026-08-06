import type { MessageID, SessionID, TaskID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { buildInitialUserMessage } from './build-initial-user-message.js';

describe('buildInitialUserMessage', () => {
  it('preserves a stable identity for idempotent producer recovery', () => {
    const messageId = 'stable-initial-message' as MessageID;
    const message = buildInitialUserMessage({
      messageId,
      sessionId: 'session-1' as SessionID,
      taskId: 'task-1' as TaskID,
      index: 0,
      timestamp: '2026-08-06T00:00:00.000Z',
      content: 'recover me',
    });

    expect(message).toMatchObject({
      message_id: messageId,
      task_id: 'task-1',
      role: 'user',
      content: 'recover me',
    });
  });
});
