import type { SessionID, TaskID } from '@agor/core/types';
import { PermissionScope } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../permissions/permission-service.js';
import { markCoordinatorTerminationAbort } from '../../termination-state.js';
import type { MessagesService, SessionsPatchClient, TasksService } from '../base/index.js';
import {
  type CopilotPermissionRequest,
  createPermissionHandler,
  type PermissionDeps,
} from './permission-mapper.js';

describe('createPermissionHandler', () => {
  const sessionId = 'test-session' as SessionID;
  const taskId = 'test-task' as TaskID;

  afterEach(() => vi.useRealTimers());

  function createDeps(
    interactionMode: 'interactive' | 'unattended' = 'interactive',
    timeoutMs = 60_000
  ) {
    const emitted = vi.fn().mockResolvedValue(undefined);
    const activity = vi.fn();
    const permissionService = new PermissionService(emitted, timeoutMs, interactionMode, activity);
    const waitForDecision = vi.spyOn(permissionService, 'waitForDecision');
    const tasksService = {
      patch: vi.fn<TasksService['patch']>(),
    } as unknown as TasksService;
    const messagesRepoFindBySessionId = vi
      .fn<PermissionDeps['messagesRepo']['findBySessionId']>()
      .mockResolvedValue([]);
    const messagesRepo = {
      findBySessionId: messagesRepoFindBySessionId,
    } as unknown as PermissionDeps['messagesRepo'];
    const messagesService = {
      create: vi.fn<MessagesService['create']>(),
      patch: vi.fn<MessagesService['patch']>(),
    } satisfies MessagesService;
    const sessionsService = {
      patch: vi.fn<SessionsPatchClient['patch']>(),
    } satisfies SessionsPatchClient;
    const deps = {
      abortController: new AbortController(),
      permissionService,
      tasksService,
      sessionsRepo: {} as unknown as PermissionDeps['sessionsRepo'],
      messagesRepo,
      messagesService,
      sessionsService,
    } satisfies PermissionDeps;
    return {
      deps,
      permissionService,
      emitted,
      activity,
      waitForDecision,
      messagesRepoFindBySessionId,
    };
  }

  function request(label: string): CopilotPermissionRequest {
    return { kind: 'shell', command: label, toolCallId: `call-${label}` };
  }

  function resolveLatestPermission(
    permissionService: PermissionService,
    emitted: ReturnType<typeof vi.fn>,
    allow = true
  ): void {
    const emittedRequest = emitted.mock.calls
      .filter(([event]) => event === 'permission:request')
      .at(-1)?.[1] as { requestId: string };
    permissionService.resolvePermission({
      requestId: emittedRequest.requestId,
      taskId,
      allow,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'test-user',
    });
  }

  it('restores a task to running after interactive permission approval', async () => {
    const { deps, permissionService, emitted } = createDeps();
    const handler = createPermissionHandler(sessionId, taskId, 'ask', deps);
    const pendingResult = handler(request('ls'), { sessionId });
    await vi.waitFor(() => expect(deps.messagesService.create).toHaveBeenCalledOnce());
    resolveLatestPermission(permissionService, emitted);

    const result = await pendingResult;

    expect(result).toEqual({ kind: 'approved' });
    expect(deps.tasksService.patch).toHaveBeenNthCalledWith(1, taskId, {
      status: 'awaiting_permission',
    });
    expect(deps.tasksService.patch).toHaveBeenNthCalledWith(2, taskId, { status: 'running' });
    expect(deps.messagesService.patch).toHaveBeenCalledWith(
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
    const { deps, permissionService, emitted } = createDeps();
    const handler = createPermissionHandler(sessionId, taskId, 'ask', deps);
    const pendingResult = handler(request('ls'), { sessionId });
    await vi.waitFor(() => expect(deps.messagesService.create).toHaveBeenCalledOnce());
    resolveLatestPermission(permissionService, emitted, false);

    await expect(pendingResult).resolves.toEqual({
      kind: 'denied-interactively-by-user',
      feedback: 'Permission denied for: Shell: ls',
    });
    expect(deps.tasksService.patch).toHaveBeenNthCalledWith(1, taskId, {
      status: 'awaiting_permission',
    });
    expect(deps.tasksService.patch).toHaveBeenNthCalledWith(2, taskId, { status: 'running' });
    expect(deps.sessionsService.patch).toHaveBeenLastCalledWith(sessionId, {
      status: 'running',
      ready_for_prompt: false,
    });
    expect(deps.abortController.signal.aborted).toBe(false);
    expect(deps.messagesService.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        content: expect.objectContaining({
          status: 'denied',
          approved_by: 'test-user',
        }),
      })
    );
  });

  it('serializes three requests with exactly one artifact, event, waiter, and decision each', async () => {
    const { deps, permissionService, emitted, activity, waitForDecision } = createDeps();
    const handler = createPermissionHandler(sessionId, taskId, 'ask', deps);
    const requests = [
      handler(request('first'), { sessionId }),
      handler(request('second'), { sessionId }),
      handler(request('third'), { sessionId }),
    ];

    await vi.waitFor(() => expect(deps.messagesService.create).toHaveBeenCalledTimes(1));
    expect(activity.mock.calls.filter(([event]) => event.type === 'waiting_started')).toHaveLength(
      1
    );
    resolveLatestPermission(permissionService, emitted);
    await vi.waitFor(() => expect(deps.messagesService.create).toHaveBeenCalledTimes(2));
    expect(activity.mock.calls.filter(([event]) => event.type === 'waiting_started')).toHaveLength(
      2
    );
    expect(activity.mock.calls.filter(([event]) => event.type === 'waiting_finished')).toHaveLength(
      1
    );
    resolveLatestPermission(permissionService, emitted);
    await vi.waitFor(() => expect(deps.messagesService.create).toHaveBeenCalledTimes(3));
    resolveLatestPermission(permissionService, emitted);

    await expect(Promise.all(requests)).resolves.toEqual([
      { kind: 'approved' },
      { kind: 'approved' },
      { kind: 'approved' },
    ]);
    expect(deps.messagesService.create).toHaveBeenCalledTimes(3);
    expect(deps.messagesService.patch).toHaveBeenCalledTimes(3);
    expect(deps.tasksService.patch).toHaveBeenCalledTimes(6);
    expect(deps.sessionsService.patch).toHaveBeenCalledTimes(6);
    expect(emitted.mock.calls.filter(([event]) => event === 'permission:request')).toHaveLength(3);
    expect(waitForDecision).toHaveBeenCalledTimes(3);
    expect(activity.mock.calls.filter(([event]) => event.type === 'waiting_started')).toHaveLength(
      3
    );
    expect(activity.mock.calls.filter(([event]) => event.type === 'waiting_finished')).toHaveLength(
      3
    );
  });

  it('creates no message, status, event, waiter, or waiting pulse when unattended', async () => {
    const { deps, emitted, activity, waitForDecision } = createDeps('unattended');
    const handler = createPermissionHandler(sessionId, taskId, 'ask', deps);

    await expect(handler(request('unattended'), { sessionId })).resolves.toMatchObject({
      kind: 'denied-interactively-by-user',
    });
    expect(deps.messagesRepo.findBySessionId).not.toHaveBeenCalled();
    expect(deps.messagesService.create).not.toHaveBeenCalled();
    expect(deps.messagesService.patch).not.toHaveBeenCalled();
    expect(deps.tasksService.patch).not.toHaveBeenCalled();
    expect(deps.sessionsService.patch).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();
    expect(waitForDecision).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  });

  it('releases queued requests after an active artifact error', async () => {
    const { deps, messagesRepoFindBySessionId } = createDeps();
    messagesRepoFindBySessionId.mockRejectedValueOnce(new Error('artifact failed'));
    const handler = createPermissionHandler(sessionId, taskId, 'ask', deps);

    await expect(
      Promise.all([
        handler(request('first'), { sessionId }),
        handler(request('second'), { sessionId }),
      ])
    ).resolves.toEqual([
      expect.objectContaining({
        kind: 'denied-interactively-by-user',
        feedback: 'artifact failed',
      }),
      expect.objectContaining({ kind: 'denied-interactively-by-user' }),
    ]);
    expect(deps.messagesRepo.findBySessionId).toHaveBeenCalledOnce();
  });

  it('releases and invalidates queued requests after an active timeout', async () => {
    vi.useFakeTimers();
    const { deps } = createDeps('interactive', 1);
    const handler = createPermissionHandler(sessionId, taskId, 'ask', deps);
    const requests = [
      handler(request('first'), { sessionId }),
      handler(request('second'), { sessionId }),
    ];
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    await expect(Promise.all(requests)).resolves.toEqual([
      expect.objectContaining({
        kind: 'denied-interactively-by-user',
        feedback: expect.stringMatching(/timed out/i),
      }),
      expect.objectContaining({ kind: 'denied-interactively-by-user' }),
    ]);
    expect(deps.messagesService.create).toHaveBeenCalledOnce();
  });

  it('releases and invalidates queued requests when the Task terminates', async () => {
    const { deps } = createDeps();
    const handler = createPermissionHandler(sessionId, taskId, 'ask', deps);
    const requests = [
      handler(request('first'), { sessionId }),
      handler(request('second'), { sessionId }),
    ];
    await vi.waitFor(() => expect(deps.messagesService.create).toHaveBeenCalledOnce());
    markCoordinatorTerminationAbort(deps.abortController);
    deps.abortController.abort();

    await expect(Promise.all(requests)).resolves.toEqual([
      expect.objectContaining({ kind: 'denied-interactively-by-user' }),
      expect.objectContaining({ kind: 'denied-interactively-by-user' }),
    ]);
    expect(deps.messagesService.create).toHaveBeenCalledOnce();
  });
});
