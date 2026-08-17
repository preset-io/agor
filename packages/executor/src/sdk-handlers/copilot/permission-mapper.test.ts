import type { SessionID, TaskID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { createPermissionHandler } from './permission-mapper.js';

describe('createPermissionHandler', () => {
  it('restores a task to running after interactive permission approval', async () => {
    const sessionId = 'test-session' as SessionID;
    const taskId = 'test-task' as TaskID;
    const tasksService = { patch: vi.fn().mockResolvedValue(undefined) };
    const messagesService = {
      create: vi.fn().mockResolvedValue(undefined),
      patch: vi.fn().mockResolvedValue(undefined),
    };
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
      messagesRepo: { getNextIndexBySessionId: vi.fn().mockResolvedValue(0) } as any,
      messagesService: messagesService as any,
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
    expect(messagesService.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        content: expect.objectContaining({
          status: 'approved',
          approved_by: 'test-user',
        }),
      })
    );
  });

  it('denies only the tool and restores active execution', async () => {
    const sessionId = 'test-session' as SessionID;
    const taskId = 'test-task' as TaskID;
    const tasksService = { patch: vi.fn().mockResolvedValue(undefined) };
    const sessionsService = { patch: vi.fn().mockResolvedValue(undefined) };
    const messagesService = {
      create: vi.fn().mockResolvedValue(undefined),
      patch: vi.fn().mockResolvedValue(undefined),
    };
    const permissionService = {
      emitRequest: vi.fn(),
      waitForDecision: vi.fn().mockResolvedValue({
        allow: false,
        timedOut: false,
        remember: false,
        decidedBy: 'test-user',
      }),
      cancelPendingRequests: vi.fn(),
    };
    const handler = createPermissionHandler(sessionId, taskId, 'ask', {
      permissionService: permissionService as any,
      tasksService: tasksService as any,
      sessionsRepo: {} as any,
      messagesRepo: { getNextIndexBySessionId: vi.fn().mockResolvedValue(0) } as any,
      messagesService: messagesService as any,
      sessionsService: sessionsService as any,
      permissionLocks: new Map(),
    });

    const result = await handler({
      kind: 'shell',
      command: 'ls',
      toolCallId: 'call-1',
    } as any);

    expect(result).toEqual({
      kind: 'denied-interactively-by-user',
      feedback: 'Permission denied for: Shell: ls',
    });
    expect(tasksService.patch).toHaveBeenNthCalledWith(1, taskId, {
      status: 'awaiting_permission',
    });
    expect(tasksService.patch).toHaveBeenNthCalledWith(2, taskId, { status: 'running' });
    expect(permissionService.cancelPendingRequests).not.toHaveBeenCalled();
    expect(sessionsService.patch).toHaveBeenLastCalledWith(sessionId, {
      status: 'running',
      ready_for_prompt: false,
    });
    expect(messagesService.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        content: expect.objectContaining({
          status: 'denied',
          approved_by: 'test-user',
        }),
      })
    );
  });
});
