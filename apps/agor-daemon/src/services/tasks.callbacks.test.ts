import { runWithTenantDatabaseScope } from '@agor/core/db';
import {
  type GatewayTerminalDeliveryReceipt,
  type MessageID,
  type Session,
  type Task,
  type TaskID,
  TaskStatus,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { completionCallbackTaskId } from '../utils/durable-task-id.js';
import { SessionsService } from './sessions';
import { TasksService } from './tasks';

const childSessionId = '018f0000-0000-7000-8000-000000000101' as Session['session_id'];
const parentSessionId = '018f0000-0000-7000-8000-000000000102' as Session['session_id'];
const taskId = '018f0000-0000-7000-8000-000000000201' as TaskID;
const callbackTaskId = '018f0000-0000-7000-8000-000000000301' as TaskID;
const userId = '018f0000-0000-7000-8000-000000000401' as Task['created_by'];
const durableCallbackTaskId = completionCallbackTaskId(taskId, parentSessionId);
const tenantParams = { tenant: { tenant_id: 'tenant-1', source: 'explicit' } } as never;

type TaskParams = Parameters<TasksService['reconcileTerminalTask']>[2];
type PendingGatewayTerminalDeliveryReceipt = Extract<
  GatewayTerminalDeliveryReceipt,
  { status: 'pending' }
>;
type TasksServicePrivateMethods = {
  runAfterTenantDatabaseCommit(label: string, work: () => Promise<void>): Promise<void>;
  projectTerminalSession(
    task: Task,
    status: Task['status'],
    session: Session,
    params?: TaskParams
  ): Promise<Session>;
  dispatchCompletionCallbacks(
    task: Task,
    childSession: Session,
    params?: TaskParams
  ): Promise<void>;
};

function privateTasksService(service: TasksService): TasksServicePrivateMethods {
  return service as unknown as TasksServicePrivateMethods;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: taskId,
    session_id: childSessionId,
    created_by: userId,
    full_prompt: 'investigate duplicate callbacks',
    status: TaskStatus.RUNNING,
    message_range: {
      start_index: 0,
      end_index: 2,
      start_timestamp: '2026-01-01T00:00:00.000Z',
    },
    tool_use_count: 3,
    git_state: {
      ref_at_start: 'main',
      sha_at_start: 'abc123',
    },
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: childSessionId,
    branch_id: undefined,
    created_by: userId,
    agentic_tool: 'claude-code',
    status: 'running',
    title: 'Child session',
    description: 'Child session',
    tasks: [taskId],
    ready_for_prompt: false,
    archived: false,
    genealogy: {
      parent_session_id: parentSessionId,
      children: [],
    },
    callback_config: {
      enabled: true,
      callback_session_id: parentSessionId,
      callback_created_by: userId,
      callback_mode: 'once',
      include_last_message: true,
    },
    git_state: {},
    contextFiles: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function makeService(
  options: {
    task?: Partial<Task>;
    childSession?: Partial<Session>;
    parentSession?: Partial<Session>;
  } = {}
) {
  const initialTask = makeTask(options.task);
  const tasksById = new Map<string, Task>([[initialTask.task_id, initialTask]]);
  const childSession = makeSession(options.childSession);
  const parentSession = makeSession({
    session_id: parentSessionId,
    status: 'idle',
    title: 'Parent session',
    tasks: [],
    ready_for_prompt: true,
    genealogy: { children: [childSessionId] },
    callback_config: undefined,
    ...options.parentSession,
  });

  const repository = {
    findById: vi.fn(async (id: string) => tasksById.get(id) ?? null),
    update: vi.fn(async (id: string, updates: Partial<Task>) => {
      const current = tasksById.get(id) ?? makeTask({ task_id: id as Task['task_id'] });
      const updated = { ...current, ...updates } as Task;
      tasksById.set(id, updated);
      return updated;
    }),
    create: vi.fn(),
    findAll: vi.fn(async () => [...tasksById.values()]),
    delete: vi.fn(),
    markTerminalConsequencesComplete: vi.fn(async (id: string) => {
      const current = tasksById.get(id)!;
      const updated = {
        ...current,
        metadata: {
          ...(current.metadata ?? {}),
          terminal_consequences_completed_at: '2026-01-01T00:00:07.000Z',
        },
      } as Task;
      tasksById.set(id, updated);
      return updated;
    }),
  };

  const callbackTask = makeTask({
    task_id: durableCallbackTaskId,
    session_id: parentSessionId,
    status: TaskStatus.QUEUED,
  });
  const createPending = vi.fn(
    async (
      sourceTaskId: string,
      targetSessionId: string,
      data: { full_prompt: string; created_by: string; metadata: Task['metadata'] }
    ) => {
      const source = tasksById.get(sourceTaskId)!;
      const existing = source.metadata?.callback_dispatches?.some(
        (receipt) => receipt.target_session_id === targetSessionId
      );
      if (existing) return { created: false, task: callbackTask };
      source.metadata = {
        ...(source.metadata ?? {}),
        callback_dispatches: [
          ...(source.metadata?.callback_dispatches ?? []),
          {
            event: 'task_completion',
            target_session_id: targetSessionId as never,
            queued_task_id: durableCallbackTaskId,
            dispatched_at: '2026-01-01T00:00:06.000Z',
          },
        ],
      };
      return {
        created: true,
        task: { ...callbackTask, full_prompt: data.full_prompt, metadata: data.metadata },
      };
    }
  );
  const createBtwResultMessageOnce = vi.fn(
    async (
      sourceTaskId: string,
      targetSessionId: Session['session_id'],
      message: Record<string, unknown>
    ) => {
      const source = tasksById.get(sourceTaskId)!;
      const existing = source.metadata?.btw_result_delivery;
      if (existing) {
        return {
          created: false,
          message: {
            ...message,
            message_id: existing.message_id,
            session_id: targetSessionId,
            index: 0,
          },
        };
      }
      source.metadata = {
        ...(source.metadata ?? {}),
        btw_result_delivery: {
          parent_session_id: targetSessionId,
          message_id: message.message_id as MessageID,
          delivered_at: message.timestamp as string,
        },
      };
      return {
        created: true,
        message: { ...message, session_id: targetSessionId, index: 0 },
      };
    }
  );

  const sessionsPatch = vi.fn(async (id: string, updates: Partial<Session>) => {
    const target = id === parentSessionId ? parentSession : childSession;
    Object.assign(target, updates);
    return { ...target };
  });
  const triggerQueueProcessing = vi.fn(async (): Promise<void> => undefined);
  const gatewayFinalize = vi.fn(async () => undefined);
  const gatewayDeliver = vi.fn();
  const messagesFind = vi.fn(async () => [
    {
      role: 'assistant',
      index: 2,
      content: [{ type: 'text', text: 'Final child result' }],
    },
  ]);

  const service = Object.create(TasksService.prototype) as TasksService;
  Reflect.set(service, 'repository', repository);
  Reflect.set(service, 'taskRepo', {
    ...repository,
    createCompletionCallbackOnce: createPending,
    createBtwResultMessageOnce,
  });
  Reflect.set(service, 'id', 'task_id');
  Reflect.set(service, 'emit', vi.fn());
  Reflect.set(service, 'db', { run: vi.fn() });
  const appService = vi.fn((name: string) => {
    if (name === 'sessions') {
      return {
        get: vi.fn(async (id: string) => (id === parentSessionId ? parentSession : childSession)),
        patch: sessionsPatch,
        triggerQueueProcessing,
      };
    }
    if (name === 'messages') return { find: messagesFind };
    if (name === 'branches') return { get: vi.fn() };
    if (name === 'gateway') {
      return {
        finalizeTask: gatewayFinalize,
        deliverTerminalTaskAfterCommit: gatewayDeliver,
        updateProgress: vi.fn(),
      };
    }
    throw new Error(`unexpected service ${name}`);
  });
  Reflect.set(service, 'app', { service: appService });

  return {
    service,
    repository,
    createPending,
    createBtwResultMessageOnce,
    sessionsPatch,
    triggerQueueProcessing,
    messagesFind,
    gatewayFinalize,
    gatewayDeliver,
    markTerminalConsequencesComplete: repository.markTerminalConsequencesComplete,
    getStoredTask: (id: string = taskId) => {
      const stored = tasksById.get(id);
      if (!stored) throw new Error(`missing Task ${id}`);
      return stored;
    },
    childSession,
    appService,
  };
}

async function reconcile(
  service: TasksService,
  status: Task['status'],
  updates: Partial<Task> = {}
): Promise<boolean> {
  const current = (await service.get(taskId)) as Task;
  return service.reconcileTerminalTask({ ...current, ...updates, status }, status, tenantParams);
}

describe('TasksService completion callbacks', () => {
  it('redacts caught values from post-commit orchestration logs', async () => {
    const markerSecret = 'TASK-POST-COMMIT-MARKER-SECRET';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = Object.create(TasksService.prototype) as TasksService;

    await privateTasksService(service).runAfterTenantDatabaseCommit(
      'publish termination settlement',
      async () => {
        throw new Error(markerSecret);
      }
    );

    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('operation="publish termination settlement"')
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(markerSecret);
    warning.mockRestore();
  });

  it('propagates queue-processor failure to terminal consequence reconciliation', async () => {
    const sessions = Object.create(SessionsService.prototype) as SessionsService;
    sessions.setQueueProcessor(async () => {
      throw new Error('claimed queue preparation failed');
    });

    await expect(sessions.triggerQueueProcessing(childSessionId)).rejects.toThrow(
      'claimed queue preparation failed'
    );
  });

  it('re-observes an older termination without reverting the newer Session projection', async () => {
    const newerTaskId = callbackTaskId;
    const { service, sessionsPatch, gatewayFinalize } = makeService({
      childSession: { tasks: [taskId, newerTaskId] as never },
    });

    await service.reconcileTerminalTask(
      makeTask({
        status: TaskStatus.FAILED,
        termination_request: {
          cause: 'heartbeat_lost',
          requested_at: '2026-01-01T00:00:04.000Z',
        },
      }),
      TaskStatus.FAILED,
      tenantParams
    );

    expect(sessionsPatch).not.toHaveBeenCalledWith(
      childSessionId,
      expect.objectContaining({ runtime_projection: expect.anything() }),
      expect.anything()
    );
    await vi.waitFor(() =>
      expect(gatewayFinalize).toHaveBeenCalledWith(
        expect.objectContaining({ task_id: taskId, state: 'failed' })
      )
    );
  });

  it('preserves an acknowledged ready flag when repairing the same terminal projection', async () => {
    const { service, sessionsPatch, childSession } = makeService({
      childSession: {
        ready_for_prompt: false,
        runtime_projection: {
          terminal_task_id: taskId as never,
          applied_at: '2026-01-01T00:00:06.000Z',
        },
      },
    });

    await privateTasksService(service).projectTerminalSession(
      makeTask({ status: TaskStatus.COMPLETED }),
      TaskStatus.COMPLETED,
      childSession,
      {}
    );

    expect(sessionsPatch).toHaveBeenCalledWith(
      childSessionId,
      expect.not.objectContaining({ ready_for_prompt: true }),
      {}
    );
  });

  it('does not inject a BTW result twice after terminal reconciliation is retried', async () => {
    const { service, childSession, messagesFind, getStoredTask } = makeService({
      task: {
        metadata: {
          btw_result_delivery: {
            parent_session_id: parentSessionId,
            message_id: '018f0000-0000-7000-8000-000000000501' as MessageID,
            delivered_at: '2026-01-01T00:00:05.000Z',
          },
        },
      },
      childSession: {
        fork_origin: 'btw',
        genealogy: {
          forked_from_session_id: parentSessionId,
          children: [],
        },
      },
    });

    await (
      service as unknown as {
        injectBtwResultMessage(task: Task, session: Session): Promise<void>;
      }
    ).injectBtwResultMessage(getStoredTask()!, childSession);

    expect(messagesFind).not.toHaveBeenCalled();
  });

  it('delivers a BTW result from the retained cooperative settlement before archiving', async () => {
    const {
      service,
      childSession,
      createBtwResultMessageOnce,
      sessionsPatch,
      markTerminalConsequencesComplete,
    } = makeService({
      childSession: {
        fork_origin: 'btw',
        genealogy: { forked_from_session_id: parentSessionId, children: [] },
        callback_config: undefined,
      },
    });
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
      termination_request: {
        cause: 'runtime_settlement',
        requested_at: '2026-01-01T00:00:04.000Z',
        executor_quiesced_at: '2026-01-01T00:00:05.000Z',
        executor_settlement: { status: TaskStatus.COMPLETED },
      },
    });

    await service.reconcileTerminalTask(completedTask, TaskStatus.COMPLETED, {
      ...(tenantParams as object),
      repairTerminalConsequences: true,
    } as never);

    expect(createBtwResultMessageOnce).toHaveBeenCalledOnce();
    expect(sessionsPatch).toHaveBeenCalledWith(
      childSession.session_id,
      { archived: true, archived_reason: 'btw_completed' },
      expect.anything()
    );
    expect(markTerminalConsequencesComplete).toHaveBeenCalledWith(completedTask.task_id);
  });

  it.each([
    [TaskStatus.STOPPED, 'user_stop'],
    [TaskStatus.FAILED, 'heartbeat_lost'],
  ] as const)(
    'does not deliver a BTW result after %s forced termination',
    async (status, cause) => {
      const { service, createBtwResultMessageOnce } = makeService({
        childSession: {
          fork_origin: 'btw',
          genealogy: { forked_from_session_id: parentSessionId, children: [] },
          callback_config: undefined,
        },
      });
      const terminatedTask = makeTask({
        status,
        completed_at: '2026-01-01T00:00:05.000Z',
        termination_request: {
          cause,
          requested_at: '2026-01-01T00:00:04.000Z',
        },
      });

      await service.reconcileTerminalTask(terminatedTask, status, {
        ...(tenantParams as object),
        repairTerminalConsequences: true,
      } as never);

      expect(createBtwResultMessageOnce).not.toHaveBeenCalled();
    }
  );

  it('keeps BTW consequences incomplete across message and archive failures without duplicates', async () => {
    const {
      service,
      childSession,
      createBtwResultMessageOnce,
      sessionsPatch,
      markTerminalConsequencesComplete,
    } = makeService({
      childSession: {
        fork_origin: 'btw',
        genealogy: { forked_from_session_id: parentSessionId, children: [] },
        callback_config: undefined,
      },
    });
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });
    createBtwResultMessageOnce.mockRejectedValueOnce(new Error('message insert failed'));

    await expect(
      service.reconcileTerminalTask(completedTask, TaskStatus.COMPLETED, {
        ...(tenantParams as object),
        repairTerminalConsequences: true,
      } as never)
    ).rejects.toThrow('message insert failed');
    expect(markTerminalConsequencesComplete).not.toHaveBeenCalled();

    sessionsPatch
      .mockResolvedValueOnce(childSession)
      .mockRejectedValueOnce(new Error('archive failed'));
    await expect(
      service.reconcileTerminalTask(completedTask, TaskStatus.COMPLETED, {
        ...(tenantParams as object),
        repairTerminalConsequences: true,
      } as never)
    ).rejects.toThrow('archive failed');
    expect(markTerminalConsequencesComplete).not.toHaveBeenCalled();

    await service.reconcileTerminalTask(completedTask, TaskStatus.COMPLETED, {
      ...(tenantParams as object),
      repairTerminalConsequences: true,
    } as never);
    expect(createBtwResultMessageOnce).toHaveBeenCalledTimes(2);
    expect(markTerminalConsequencesComplete).toHaveBeenCalledOnce();
  });

  it('defers callback dispatch until after the tenant transaction commits', async () => {
    const events: string[] = [];
    const { service, createPending, gatewayFinalize } = makeService();
    const tx = {
      execute: vi.fn(async () => []),
    };
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        events.push('tx:start');
        const result = await callback(tx);
        events.push('tx:committed');
        return result;
      }),
    };
    createPending.mockImplementationOnce(async (_source, _target, data) => {
      events.push('callback:queued');
      return {
        created: true,
        task: {
          ...makeTask({
            task_id: callbackTaskId,
            session_id: parentSessionId,
            status: TaskStatus.QUEUED,
          }),
          full_prompt: data.full_prompt,
          metadata: data.metadata,
        },
      };
    });
    await runWithTenantDatabaseScope(db as never, 'tenant-1', async () => {
      await reconcile(service, TaskStatus.COMPLETED, {
        completed_at: '2026-01-01T00:00:05.000Z',
      });

      events.push('patch:returned');
      expect(createPending).not.toHaveBeenCalled();
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    expect(events.slice(0, 4)).toEqual([
      'tx:start',
      'patch:returned',
      'tx:committed',
      'callback:queued',
    ]);
    await vi.waitFor(() =>
      expect(gatewayFinalize).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: childSessionId,
          task_id: taskId,
          state: 'done',
        })
      )
    );
  });

  it('queues exactly one templated callback with last-message metadata for a completed subsession task', async () => {
    const {
      service,
      createPending,
      sessionsPatch,
      triggerQueueProcessing,
      messagesFind,
      getStoredTask,
    } = makeService();

    await reconcile(service, TaskStatus.COMPLETED, {
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    expect(createPending).toHaveBeenCalledWith(
      taskId,
      parentSessionId,
      expect.objectContaining({
        metadata: expect.objectContaining({
          is_agor_callback: true,
          source: 'agor',
          child_session_id: childSessionId,
          child_task_id: taskId,
          queued_by_user_id: userId,
        }),
      })
    );
    const callbackPrompt = createPending.mock.calls[0][2].full_prompt as string;
    expect(callbackPrompt).toContain('[Agor] Child session');
    expect(callbackPrompt).toContain('**Result:**');
    expect(callbackPrompt).toContain('Final child result');
    expect(callbackPrompt).toContain(taskId);
    expect(callbackPrompt).not.toContain('## Original Prompt');
    expect(callbackPrompt).not.toContain('investigate duplicate callbacks');
    expect(messagesFind).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(triggerQueueProcessing).toHaveBeenCalledWith(parentSessionId, tenantParams)
    );
    await vi.waitFor(() =>
      expect(sessionsPatch).toHaveBeenCalledWith(
        childSessionId,
        expect.objectContaining({ callback_config: expect.objectContaining({ enabled: false }) })
      )
    );
    await vi.waitFor(() =>
      expect(getStoredTask().metadata?.callback_dispatches).toEqual([
        expect.objectContaining({
          event: 'task_completion',
          target_session_id: parentSessionId,
          queued_task_id: durableCallbackTaskId,
        }),
      ])
    );
  });

  it('uses the same terminal callback for a failed task', async () => {
    const { service, createPending } = makeService();

    await reconcile(service, TaskStatus.FAILED, {
      completed_at: '2026-01-01T00:00:05.000Z',
      error_message: 'SDK activity stalled (progress_stalled).',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    expect(createPending.mock.calls[0][2].full_prompt).toContain('failed');
  });

  it('includeOriginalPrompt=false queues one templated callback without an original prompt section', async () => {
    const { service, createPending } = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'once',
          include_original_prompt: false,
          include_last_message: true,
        },
      },
      task: {
        full_prompt: 'original prompt should not appear when disabled',
      },
    });

    await reconcile(service, TaskStatus.COMPLETED, {
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    const callbackPrompt = createPending.mock.calls[0][2].full_prompt as string;
    expect(callbackPrompt).toContain('[Agor] Child session');
    expect(callbackPrompt).toContain('**Result:**');
    expect(callbackPrompt).toContain('Final child result');
    expect(callbackPrompt).not.toContain('## Original Prompt');
    expect(callbackPrompt).not.toContain('original prompt should not appear when disabled');
  });

  it('includeOriginalPrompt=true queues one templated callback with an explicit original prompt section', async () => {
    const originalPrompt = [
      'Investigate callback duplication.',
      'Keep this second line in the callback body.',
    ].join('\n');
    const { service, createPending } = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'once',
          include_original_prompt: true,
          include_last_message: true,
        },
      },
      task: { full_prompt: originalPrompt },
    });

    await reconcile(service, TaskStatus.COMPLETED, {
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    const callbackPrompt = createPending.mock.calls[0][2].full_prompt as string;
    expect(callbackPrompt).toContain('[Agor] Child session');
    expect(callbackPrompt).toContain('## Original Prompt');
    expect(callbackPrompt).toContain(originalPrompt);
    expect(callbackPrompt).toContain('**Result:**');
    expect(callbackPrompt).toContain('Final child result');
  });

  it('uses the same single templated patch completion path for sessions.create callbacks without spawn genealogy', async () => {
    const { service, createPending, sessionsPatch } = makeService({
      childSession: {
        genealogy: { children: [] },
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'once',
          include_original_prompt: true,
          include_last_message: true,
        },
      },
      task: { full_prompt: 'remote session initial prompt' },
    });

    await reconcile(service, TaskStatus.COMPLETED, {
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    const callbackPrompt = createPending.mock.calls[0][2].full_prompt as string;
    expect(callbackPrompt).toContain('[Agor] Child session');
    expect(callbackPrompt).toContain('## Original Prompt');
    expect(callbackPrompt).toContain('remote session initial prompt');
    expect(callbackPrompt).toContain('Final child result');
    await vi.waitFor(() =>
      expect(sessionsPatch).toHaveBeenCalledWith(
        childSessionId,
        expect.objectContaining({ callback_config: expect.objectContaining({ enabled: false }) })
      )
    );
  });

  it('relies on the atomic callback receipt when concurrent reconciliations race', async () => {
    const { service, createPending, childSession, triggerQueueProcessing } = makeService();
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await Promise.all([
      privateTasksService(service).dispatchCompletionCallbacks(completedTask, childSession, {}),
      privateTasksService(service).dispatchCompletionCallbacks(completedTask, childSession, {}),
    ]);

    expect(createPending).toHaveBeenCalledTimes(2);
    // Both repair attempts may wake the target queue. The queue processor is
    // idempotent; the durable callback receipt is what prevents a duplicate Task.
    expect(triggerQueueProcessing).toHaveBeenCalledTimes(2);
  });

  it("callbackMode='once' prevents a repeat callback after the first firing", async () => {
    const { service, createPending, childSession } = makeService();
    const firstTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await privateTasksService(service).dispatchCompletionCallbacks(firstTask, childSession, {});

    expect(createPending).toHaveBeenCalledTimes(1);
    expect(childSession.callback_config?.enabled).toBe(false);

    createPending.mockClear();

    const secondTask = makeTask({
      task_id: '018f0000-0000-7000-8000-000000000202' as Task['task_id'],
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:01:05.000Z',
      metadata: undefined,
    });

    await privateTasksService(service).dispatchCompletionCallbacks(secondTask, childSession, {});

    expect(createPending).not.toHaveBeenCalled();
  });

  it("callbackMode='once' does not disable when callback queueing fails before firing", async () => {
    const { service, createPending, sessionsPatch, childSession } = makeService();
    createPending.mockRejectedValueOnce(new Error('queue failed'));
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await expect(
      privateTasksService(service).dispatchCompletionCallbacks(completedTask, childSession, {})
    ).rejects.toThrow('queue failed');

    expect(createPending).toHaveBeenCalledTimes(1);
    expect(
      sessionsPatch.mock.calls.filter(
        ([id, updates]) =>
          id === childSessionId && (updates as Partial<Session>).callback_config?.enabled === false
      )
    ).toHaveLength(0);
    expect(childSession.callback_config?.enabled).toBe(true);
  });

  it('leaves consequence completion repairable when claimed queue preparation fails', async () => {
    const { service, triggerQueueProcessing, markTerminalConsequencesComplete, childSession } =
      makeService({
        childSession: { callback_config: undefined, genealogy: { children: [] } },
      });
    triggerQueueProcessing.mockRejectedValueOnce(new Error('queue preparation failed'));
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await expect(
      service.reconcileTerminalTask(completedTask, TaskStatus.COMPLETED, {
        ...(tenantParams as object),
        repairTerminalConsequences: true,
      } as never)
    ).rejects.toThrow('queue preparation failed');

    expect(triggerQueueProcessing).toHaveBeenCalledWith(childSession.session_id, expect.anything());
    expect(markTerminalConsequencesComplete).not.toHaveBeenCalled();
  });

  it('records consequence completion only after queue continuation succeeds', async () => {
    const { service, triggerQueueProcessing, markTerminalConsequencesComplete, childSession } =
      makeService({
        childSession: { callback_config: undefined, genealogy: { children: [] } },
      });
    let releaseQueue!: () => void;
    triggerQueueProcessing.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseQueue = resolve;
        })
    );
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    const reconciliation = service.reconcileTerminalTask(completedTask, TaskStatus.COMPLETED, {
      ...(tenantParams as object),
      repairTerminalConsequences: true,
    } as never);

    await vi.waitFor(() =>
      expect(triggerQueueProcessing).toHaveBeenCalledWith(
        childSession.session_id,
        expect.anything()
      )
    );
    expect(markTerminalConsequencesComplete).not.toHaveBeenCalled();

    releaseQueue();
    await expect(reconciliation).resolves.toBe(true);
    expect(markTerminalConsequencesComplete).toHaveBeenCalledWith(completedTask.task_id);
  });

  it('completes consequences and continues delivery independently after durable gateway intent', async () => {
    const gatewayReceipt: PendingGatewayTerminalDeliveryReceipt = {
      mapping_id: 'mapping-1' as PendingGatewayTerminalDeliveryReceipt['mapping_id'],
      channel_id: 'channel-1' as PendingGatewayTerminalDeliveryReceipt['channel_id'],
      thread_id: 'thread-1',
      status: 'pending',
      intended_at: '2026-01-01T00:00:05.000Z',
    };
    const { service, gatewayFinalize, gatewayDeliver, markTerminalConsequencesComplete } =
      makeService({
        task: { metadata: { gateway_terminal_delivery: gatewayReceipt } },
        childSession: { callback_config: undefined, genealogy: { children: [] } },
      });
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
      metadata: { gateway_terminal_delivery: gatewayReceipt },
    });

    await expect(
      service.reconcileTerminalTask(completedTask, TaskStatus.COMPLETED, {
        ...(tenantParams as object),
        repairTerminalConsequences: true,
      } as never)
    ).resolves.toBe(true);

    expect(gatewayFinalize).toHaveBeenCalledOnce();
    expect(markTerminalConsequencesComplete).toHaveBeenCalledWith(completedTask.task_id);
    expect(gatewayDeliver).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: completedTask.task_id }),
      expect.anything()
    );
  });

  it('completes terminal consequences when the fleet queue worker owns continuation', async () => {
    const { service, triggerQueueProcessing, gatewayDeliver, markTerminalConsequencesComplete } =
      makeService({
        childSession: { callback_config: undefined, genealogy: { children: [] } },
      });
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await service.reconcileTerminalTask(completedTask, TaskStatus.COMPLETED, {
      ...(tenantParams as object),
      suppressTerminalQueueProcessing: true,
    } as never);

    expect(triggerQueueProcessing).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(markTerminalConsequencesComplete).toHaveBeenCalledWith(completedTask.task_id)
    );
    expect(gatewayDeliver).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: completedTask.task_id }),
      expect.anything()
    );
  });

  it('retries target queue processing when callback creation was already committed', async () => {
    const { service, createPending, triggerQueueProcessing, childSession } = makeService({
      task: {
        metadata: {
          callback_dispatches: [
            {
              event: 'task_completion',
              target_session_id: parentSessionId,
              queued_task_id: callbackTaskId,
              dispatched_at: '2026-01-01T00:00:06.000Z',
            },
          ],
        },
      },
    });
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
      metadata: {
        callback_dispatches: [
          {
            event: 'task_completion',
            target_session_id: parentSessionId,
            queued_task_id: callbackTaskId,
            dispatched_at: '2026-01-01T00:00:06.000Z',
          },
        ],
      },
    });

    await privateTasksService(service).dispatchCompletionCallbacks(completedTask, childSession, {});

    expect(createPending).toHaveBeenCalledTimes(1);
    expect(triggerQueueProcessing).toHaveBeenCalledWith(parentSessionId, {});
  });

  it('does not queue or trigger target processing when callbacks are disabled', async () => {
    const { service, createPending, triggerQueueProcessing, childSession } = makeService({
      childSession: {
        callback_config: {
          enabled: false,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'once',
        },
      },
    });
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await privateTasksService(service).dispatchCompletionCallbacks(completedTask, childSession, {});

    expect(createPending).not.toHaveBeenCalled();
    expect(triggerQueueProcessing).not.toHaveBeenCalledWith(parentSessionId, {});
  });

  it('uses legacy genealogy parent fallback when callback_session_id is absent', async () => {
    const { service, createPending, childSession } = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_created_by: userId,
          callback_mode: 'persistent',
        },
      },
    });
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await privateTasksService(service).dispatchCompletionCallbacks(completedTask, childSession, {});

    expect(createPending).toHaveBeenCalledWith(
      completedTask.task_id,
      parentSessionId,
      expect.anything()
    );
  });

  it('delivers a task-level callback without mutating session callback configuration', async () => {
    const callerSessionId = '018f0000-0000-7000-8000-000000000777' as Session['session_id'];
    const { service, createPending, sessionsPatch, childSession, appService } = makeService({
      childSession: { genealogy: { children: [] }, callback_config: undefined },
      task: {
        metadata: {
          completion_callback: {
            target_session_id: callerSessionId,
            requested_from_session_id: callerSessionId,
            requested_by_user_id: userId,
          },
        },
      },
    });
    appService.mockImplementation((name: string) => {
      if (name === 'sessions') {
        return {
          get: vi.fn(async (id: string) =>
            id === childSessionId
              ? childSession
              : makeSession({ session_id: id as Session['session_id'], created_by: userId })
          ),
          patch: sessionsPatch,
          triggerQueueProcessing: vi.fn(async () => undefined),
        };
      }
      if (name === 'messages') return { find: vi.fn(async () => []) };
      if (name === 'branches') return { get: vi.fn() };
      if (name === 'gateway') {
        return {
          finalizeTask: vi.fn(async () => undefined),
          deliverTerminalTaskAfterCommit: vi.fn(),
          updateProgress: vi.fn(),
        };
      }
      throw new Error(`unexpected service ${name}`);
    });

    await reconcile(service, TaskStatus.COMPLETED, {
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    expect(createPending).toHaveBeenCalledWith(
      taskId,
      callerSessionId,
      expect.objectContaining({
        metadata: expect.objectContaining({ child_task_id: taskId }),
      })
    );
    expect(sessionsPatch).not.toHaveBeenCalledWith(
      childSessionId,
      expect.objectContaining({ callback_config: expect.anything() })
    );
  });

  it('coalesces task-level and session-level callbacks to the same destination', async () => {
    const { service, createPending, sessionsPatch } = makeService({
      task: {
        metadata: {
          completion_callback: {
            target_session_id: parentSessionId,
            requested_from_session_id: parentSessionId,
            requested_by_user_id: userId,
          },
        },
      },
    });

    await reconcile(service, TaskStatus.COMPLETED, {
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(sessionsPatch).toHaveBeenCalledWith(
        childSessionId,
        expect.objectContaining({ callback_config: expect.objectContaining({ enabled: false }) })
      )
    );
  });
});
