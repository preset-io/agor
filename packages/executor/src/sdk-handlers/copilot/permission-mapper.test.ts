import type { SessionID, TaskID } from '@agor/core/types';
import { PermissionScope } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { MessagesRepository, SessionRepository } from '../../db/feathers-repositories.js';
import { PermissionService } from '../../permissions/permission-service.js';
import type { TasksService } from '../base/index.js';
import { type CopilotPermissionRequest, createPermissionHandler } from './permission-mapper.js';

describe('createPermissionHandler', () => {
  it('restores a task to running after interactive permission approval', async () => {
    const sessionId = 'test-session' as SessionID;
    const taskId = 'test-task' as TaskID;
    const permissionService = new PermissionService(vi.fn());
    vi.spyOn(permissionService, 'waitForDecision').mockResolvedValue({
      requestId: 'request-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'test-user',
    });
    const tasksService: TasksService = {
      get: vi.fn(),
      patch: vi.fn().mockResolvedValue(undefined),
      emit: vi.fn(),
    };
    const handler = createPermissionHandler(sessionId, taskId, 'ask', {
      permissionService,
      tasksService,
      sessionsRepo: {} as SessionRepository,
      messagesRepo: {
        findBySessionId: vi.fn().mockResolvedValue([]),
      } as unknown as MessagesRepository,
      permissionLocks: new Map(),
    });

    const result = await handler({
      kind: 'shell',
      command: 'ls',
      toolCallId: 'call-1',
    } as CopilotPermissionRequest);

    expect(result).toEqual({ kind: 'approved' });
    expect(tasksService.patch).toHaveBeenNthCalledWith(1, taskId, {
      status: 'awaiting_permission',
    });
    expect(tasksService.patch).toHaveBeenNthCalledWith(2, taskId, { status: 'running' });
  });
});
