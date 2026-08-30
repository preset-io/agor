import { describe, expect, it, vi } from 'vitest';
import type { SessionsServiceImpl } from '../declarations.js';

import { markStoppedSessionPromptableNoDrain, stopSessionPreserveQueue } from './session-stop.js';

const findActiveTasks = async (app: any, sessionId: string, params: unknown) => {
  const result = await app
    .service('tasks')
    .find({ ...((params as object) ?? {}), query: { session_id: sessionId } });
  return Array.isArray(result) ? result : result.data;
};

const runInFreshTenantWriteDatabase = <T>(work: () => Promise<T>): Promise<T> => work();
const runInTenantDatabaseScope = <T>(work: () => Promise<T>): Promise<T> => work();

describe('markStoppedSessionPromptableNoDrain', () => {
  it('marks the session promptable without triggering queue processing', async () => {
    const calls: string[] = [];
    const params = { provider: 'rest' };
    const sessionsService = {
      patch: vi.fn(async (id, data) => {
        calls.push('patch');
        return { session_id: id, ...data };
      }),
      triggerQueueProcessing: vi.fn(async () => {
        calls.push('drain');
      }),
    } as unknown as Pick<SessionsServiceImpl, 'patch' | 'triggerQueueProcessing'>;

    await markStoppedSessionPromptableNoDrain(sessionsService, 'session-1' as never, params);

    expect(sessionsService.patch).toHaveBeenCalledWith(
      'session-1',
      { status: 'idle', ready_for_prompt: true },
      expect.objectContaining({ provider: 'rest', suppressTerminalQueueProcessing: true })
    );
    expect(sessionsService.triggerQueueProcessing).not.toHaveBeenCalled();
    expect(calls).toEqual(['patch']);
  });

  it('does not trigger the queue if the session patch fails', async () => {
    const sessionsService = {
      patch: vi.fn(async () => {
        throw new Error('patch denied');
      }),
      triggerQueueProcessing: vi.fn(async () => {}),
    } as unknown as Pick<SessionsServiceImpl, 'patch' | 'triggerQueueProcessing'>;

    await expect(
      markStoppedSessionPromptableNoDrain(sessionsService, 'session-1' as never, {})
    ).rejects.toThrow('patch denied');
    expect(sessionsService.triggerQueueProcessing).not.toHaveBeenCalled();
  });
});

describe('stopSessionPreserveQueue', () => {
  it('keeps nested reads and the idle repair inside explicit tenant database units', async () => {
    let readScopeDepth = 0;
    let writeScopeDepth = 0;
    const requireScope = (kind: 'read' | 'write') => {
      if (readScopeDepth === 0 && writeScopeDepth === 0) {
        throw new Error(`missing tenant ${kind} scope`);
      }
    };
    const runInTenantDatabaseScope = vi.fn(async <T>(work: () => Promise<T>) => {
      readScopeDepth += 1;
      try {
        return await work();
      } finally {
        readScopeDepth -= 1;
      }
    });
    const runInFreshTenantWriteDatabase = vi.fn(async <T>(work: () => Promise<T>) => {
      writeScopeDepth += 1;
      try {
        return await work();
      } finally {
        writeScopeDepth -= 1;
      }
    });
    const sessionsService = {
      get: vi.fn(async () => {
        requireScope('read');
        return {
          session_id: 'session-scoped',
          agentic_tool: 'codex',
          status: 'running',
          ready_for_prompt: false,
          tasks: [],
        };
      }),
      patch: vi.fn(async (_id, data) => {
        requireScope('write');
        return data;
      }),
    };
    const findActiveTasks = vi.fn(async () => {
      requireScope('read');
      return [];
    });

    await expect(
      stopSessionPreserveQueue(
        {
          app: {} as never,
          taskRepo: { findQueued: vi.fn().mockResolvedValue([]) } as never,
          sessionsService: sessionsService as never,
          findActiveTasks: findActiveTasks as never,
          runInTenantDatabaseScope,
          runInFreshTenantWriteDatabase,
        },
        'session-scoped' as never
      )
    ).resolves.toMatchObject({ success: true, outcome: 'stopped', status: 'idle' });

    expect(runInTenantDatabaseScope).toHaveBeenCalledTimes(2);
    expect(runInFreshTenantWriteDatabase).toHaveBeenCalledOnce();
    expect(sessionsService.patch).toHaveBeenCalledOnce();
  });

  it('treats an already-idle session as an idempotent successful Stop', async () => {
    const findQueued = vi.fn().mockResolvedValue([{ task_id: 'queued-task' }]);
    const requestTermination = vi.fn();
    await expect(
      stopSessionPreserveQueue(
        {
          app: {} as never,
          taskRepo: { findQueued } as never,
          sessionsService: {
            get: vi.fn().mockResolvedValue({ status: 'idle' }),
            patch: vi.fn(),
          } as never,
          requestTermination: requestTermination as never,
          runInTenantDatabaseScope,
          runInFreshTenantWriteDatabase,
        },
        'session-idle' as never
      )
    ).resolves.toEqual({
      success: true,
      outcome: 'already_idle',
      status: 'idle',
      reason: 'Session is already idle',
      queuedTasksPreserved: 1,
    });
    expect(findQueued).toHaveBeenCalledWith('session-idle');
    expect(requestTermination).not.toHaveBeenCalled();
  });

  it('rejects process control for a historical removed-runtime session', async () => {
    const task = {
      task_id: 'task-cli',
      session_id: 'session-cli',
      status: 'running',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const session = {
      session_id: task.session_id,
      agentic_tool: 'claude-code-cli',
      status: 'running',
      ready_for_prompt: false,
      tasks: [task.task_id],
    };
    const requestTermination = vi.fn();
    await expect(
      stopSessionPreserveQueue(
        {
          app: {
            service: () => ({ find: vi.fn().mockResolvedValue({ data: [task] }) }),
          } as never,
          taskRepo: { findQueued: vi.fn().mockResolvedValue([]) } as never,
          findActiveTasks: findActiveTasks as never,
          sessionsService: { get: vi.fn().mockResolvedValue(session), patch: vi.fn() } as never,
          requestTermination: requestTermination as never,
          runInTenantDatabaseScope,
          runInFreshTenantWriteDatabase,
        } as never,
        session.session_id as never
      )
    ).rejects.toThrow('removed experimental Claude Code CLI integration');

    expect(requestTermination).not.toHaveBeenCalled();
  });

  it('stops only the active task and preserves queued tasks for the caller to drain after the lock', async () => {
    const sessionId = 'session-1';
    const runningTask = {
      task_id: 'task-running',
      session_id: sessionId,
      status: 'running',
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
    };
    const queuedTask = {
      task_id: 'task-queued',
      session_id: sessionId,
      status: 'queued',
      queue_position: 1,
      created_at: '2026-01-01T00:00:01.000Z',
    };
    const sessionsService = {
      get: vi.fn(async () => ({
        session_id: sessionId,
        agentic_tool: 'claude-code',
        status: 'running',
        ready_for_prompt: false,
        tasks: [runningTask.task_id],
      })),
      patch: vi.fn(async (_id, data) => data),
    };
    const taskRepo = {
      findQueued: vi.fn(async () => [queuedTask]),
    };
    const app = {
      service: (name: string) => {
        if (name === 'tasks') {
          return {
            find: vi.fn(async () => ({ data: [runningTask, queuedTask] })),
          };
        }
        throw new Error(`unexpected service ${name}`);
      },
    };
    const withTenantDatabase = vi.fn(async (work: () => Promise<unknown>) => work());
    const requestTermination = vi.fn(async (input) => {
      await input.runInFreshTenantWriteDatabase(async () => 'scoped');
      return { status: 'terminal', task: runningTask };
    });
    const params = { provider: 'rest' };

    const result = await stopSessionPreserveQueue(
      {
        app: app as never,
        taskRepo: taskRepo as never,
        findActiveTasks: findActiveTasks as never,
        sessionsService: sessionsService as never,
        requestTermination: requestTermination as never,
        runInTenantDatabaseScope,
        runInFreshTenantWriteDatabase: withTenantDatabase,
      },
      sessionId as never,
      params,
      { reason: 'user requested' }
    );

    expect(result).toMatchObject({
      success: true,
      status: 'idle',
      stoppedTaskId: runningTask.task_id,
      queuedTasksPreserved: 1,
    });
    expect(requestTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: runningTask.task_id,
        cause: 'user_stop',
        runInFreshTenantWriteDatabase: withTenantDatabase,
      })
    );
    expect(withTenantDatabase).toHaveBeenCalledOnce();
  });

  it('stops an awaiting_input task when the session is awaiting input', async () => {
    const sessionId = 'session-awaiting-input';
    const awaitingInputTask = {
      task_id: 'task-awaiting-input',
      session_id: sessionId,
      status: 'awaiting_input',
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
    };
    const sessionsService = {
      get: vi.fn(async () => ({
        session_id: sessionId,
        agentic_tool: 'claude-code',
        status: 'awaiting_input',
        ready_for_prompt: false,
        tasks: [awaitingInputTask.task_id],
      })),
      patch: vi.fn(async (_id, data) => data),
    };
    const taskRepo = {
      findQueued: vi.fn(async () => []),
    };
    const app = {
      service: (name: string) => {
        if (name === 'tasks') {
          return {
            find: vi.fn(async () => ({ data: [awaitingInputTask] })),
          };
        }
        throw new Error(`unexpected service ${name}`);
      },
    };
    const requestTermination = vi.fn(async () => ({
      status: 'terminal',
      task: awaitingInputTask,
    }));

    const result = await stopSessionPreserveQueue(
      {
        app: app as never,
        taskRepo: taskRepo as never,
        findActiveTasks: findActiveTasks as never,
        sessionsService: sessionsService as never,
        requestTermination: requestTermination as never,
        runInTenantDatabaseScope,
        runInFreshTenantWriteDatabase,
      },
      sessionId as never,
      {},
      { reason: 'user requested' }
    );

    expect(result).toMatchObject({
      success: true,
      status: 'idle',
      stoppedTaskId: awaitingInputTask.task_id,
      queuedTasksPreserved: 0,
    });
    expect(requestTermination).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: awaitingInputTask.task_id, cause: 'user_stop' })
    );
  });

  it('surfaces an accepted non-owner Stop as structured pending without a second claim', async () => {
    const sessionId = 'session-non-owner';
    const runningTask = {
      task_id: 'task-running-elsewhere',
      session_id: sessionId,
      status: 'running',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const requestTermination = vi.fn().mockResolvedValue({
      status: 'pending',
      task: {
        ...runningTask,
        status: 'stopping',
        termination_request: {
          cause: 'user_stop',
          requested_at: '2026-01-01T00:00:01.000Z',
        },
      },
      pendingCode: 'non_owner_replica',
      reason: 'Waiting for the daemon that owns the local executor process handle.',
    });

    await expect(
      stopSessionPreserveQueue(
        {
          app: {} as never,
          taskRepo: { findQueued: vi.fn().mockResolvedValue([]) } as never,
          sessionsService: {
            get: vi.fn().mockResolvedValue({
              session_id: sessionId,
              agentic_tool: 'codex',
              status: 'running',
              ready_for_prompt: false,
              tasks: [runningTask.task_id],
            }),
            patch: vi.fn(),
          } as never,
          findActiveTasks: vi.fn().mockResolvedValue([runningTask]) as never,
          requestTermination: requestTermination as never,
          runInTenantDatabaseScope,
          runInFreshTenantWriteDatabase,
        },
        sessionId as never
      )
    ).resolves.toEqual({
      success: false,
      outcome: 'pending',
      status: 'stopping',
      reason: 'Waiting for the daemon that owns the local executor process handle.',
      stoppedTaskId: runningTask.task_id,
      queuedTasksPreserved: 0,
      pendingCode: 'non_owner_replica',
    });
    expect(requestTermination).toHaveBeenCalledOnce();
  });

  it('does not claim a successor task when the expected execution generation changed', async () => {
    const sessionId = 'session-generation-changed';
    const runningTask = {
      task_id: 'task-successor',
      session_id: sessionId,
      status: 'running',
      created_at: '2026-01-01T00:00:01.000Z',
    };
    const requestTermination = vi.fn();

    await expect(
      stopSessionPreserveQueue(
        {
          app: {} as never,
          taskRepo: { findQueued: vi.fn().mockResolvedValue([]) } as never,
          sessionsService: {
            get: vi.fn().mockResolvedValue({
              session_id: sessionId,
              agentic_tool: 'codex',
              status: 'running',
              ready_for_prompt: false,
              tasks: [runningTask.task_id],
            }),
            patch: vi.fn(),
          } as never,
          findActiveTasks: vi.fn().mockResolvedValue([runningTask]) as never,
          requestTermination: requestTermination as never,
          runInTenantDatabaseScope,
          runInFreshTenantWriteDatabase,
        },
        sessionId as never,
        {},
        { expectedTaskId: 'task-original' as never }
      )
    ).resolves.toEqual({
      success: false,
      outcome: 'condition_changed',
      reason: 'Execution changed before Stop could be claimed. Review the current state and retry.',
      queuedTasksPreserved: 0,
    });
    expect(requestTermination).not.toHaveBeenCalled();
  });

  it('does not describe a terminal settlement race as a still-stopping unverified result', async () => {
    const sessionId = 'session-terminal-race';
    const runningTask = {
      task_id: 'task-terminal-race',
      session_id: sessionId,
      status: 'running',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const requestTermination = vi.fn().mockResolvedValue({
      status: 'unverified',
      task: { ...runningTask, status: 'stopped' },
      reason: 'Containment could not be verified after the Task settled.',
    });

    await expect(
      stopSessionPreserveQueue(
        {
          app: {} as never,
          taskRepo: { findQueued: vi.fn().mockResolvedValue([]) } as never,
          sessionsService: {
            get: vi.fn().mockResolvedValue({
              session_id: sessionId,
              agentic_tool: 'codex',
              status: 'running',
              ready_for_prompt: false,
              tasks: [runningTask.task_id],
            }),
            patch: vi.fn(),
          } as never,
          findActiveTasks: vi.fn().mockResolvedValue([runningTask]) as never,
          requestTermination: requestTermination as never,
          runInTenantDatabaseScope,
          runInFreshTenantWriteDatabase,
        },
        sessionId as never
      )
    ).resolves.toEqual({
      success: false,
      outcome: 'condition_changed',
      reason: 'Containment could not be verified after the Task settled.',
      stoppedTaskId: runningTask.task_id,
      queuedTasksPreserved: 0,
    });
  });

  it('does not silently report success if the session idle patch fails after stopping the task', async () => {
    const sessionId = 'session-patch-fails';
    const runningTask = {
      task_id: 'task-running',
      session_id: sessionId,
      status: 'running',
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
    };
    const sessionsService = {
      get: vi.fn(async () => ({
        session_id: sessionId,
        agentic_tool: 'claude-code',
        status: 'running',
        ready_for_prompt: false,
        tasks: [runningTask.task_id],
      })),
      patch: vi.fn(async () => {
        throw new Error('patch denied');
      }),
    };
    const taskRepo = {
      findQueued: vi.fn(async () => []),
    };
    const app = {
      service: (name: string) => {
        if (name === 'tasks') {
          return {
            find: vi.fn(async () => ({ data: [runningTask] })),
          };
        }
        throw new Error(`unexpected service ${name}`);
      },
    };

    const requestTermination = vi.fn(async () => {
      throw new Error('containment failed');
    });
    await expect(
      stopSessionPreserveQueue(
        {
          app: app as never,
          taskRepo: taskRepo as never,
          findActiveTasks: findActiveTasks as never,
          sessionsService: sessionsService as never,
          requestTermination: requestTermination as never,
          runInTenantDatabaseScope,
          runInFreshTenantWriteDatabase,
        },
        sessionId as never,
        { provider: 'rest' }
      )
    ).rejects.toThrow('containment failed');
  });
});
