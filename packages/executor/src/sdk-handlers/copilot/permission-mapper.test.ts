import type { SessionID, TaskID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { createPermissionHandler } from './permission-mapper.js';

describe('createPermissionHandler', () => {
  it('restores a task to running after interactive permission approval', async () => {
    const sessionId = 'test-session' as SessionID;
    const taskId = 'test-task' as TaskID;
    const tasksService = { patch: vi.fn().mockResolvedValue(undefined) };
    const handler = createPermissionHandler(sessionId, taskId, 'ask', {
      permissionService: {
        emitRequest: vi.fn(),
        waitForDecision: vi.fn().mockResolvedValue({
          allow: true,
          timedOut: false,
          remember: false,
          decidedBy: 'test-user',
        }),
        cancelPendingRequests: vi.fn(),
      } as any,
      tasksService: tasksService as any,
      sessionsRepo: {} as any,
      messagesRepo: { findBySessionId: vi.fn().mockResolvedValue([]) } as any,
      messagesService: {
        create: vi.fn().mockResolvedValue(undefined),
        patch: vi.fn().mockResolvedValue(undefined),
      } as any,
      sessionsService: { patch: vi.fn().mockResolvedValue(undefined) } as any,
      permissionLocks: new Map(),
    });

    const result = await handler({
      kind: 'shell',
      command: 'ls',
      toolCallId: 'call-1',
    } as any);

    expect(result).toEqual({ kind: 'approved' });
    expect(tasksService.patch).toHaveBeenNthCalledWith(1, taskId, {
      status: 'awaiting_permission',
    });
    expect(tasksService.patch).toHaveBeenNthCalledWith(2, taskId, { status: 'running' });
  });
});
