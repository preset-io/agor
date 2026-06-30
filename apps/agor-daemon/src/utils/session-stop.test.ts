import { describe, expect, it, vi } from 'vitest';
import type { SessionsServiceImpl } from '../declarations.js';
import { markStoppedSessionPromptableNoDrain, stopSessionPreserveQueue } from './session-stop.js';

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
        status: 'running',
        ready_for_prompt: false,
        tasks: [runningTask.task_id],
      })),
      patch: vi.fn(async (_id, data) => data),
    };
    const tasksService = {
      patch: vi.fn(async (id, data) => ({ task_id: id, ...data })),
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
    const killExecutorProcess = vi.fn(() => true);
    const params = { provider: 'rest' };

    const result = await stopSessionPreserveQueue(
      {
        app: app as never,
        taskRepo: taskRepo as never,
        sessionsService: sessionsService as never,
        tasksService: tasksService as never,
        killExecutorProcess,
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
    expect(killExecutorProcess).toHaveBeenCalledWith(sessionId);
    expect(tasksService.patch).toHaveBeenCalledTimes(1);
    expect(tasksService.patch).toHaveBeenCalledWith(
      runningTask.task_id,
      expect.objectContaining({ status: 'stopped' }),
      expect.objectContaining({
        suppressTerminalQueueProcessing: true,
        suppressCompletionCallbacks: true,
      })
    );
    expect(sessionsService.patch).toHaveBeenCalledWith(
      sessionId,
      { status: 'idle', ready_for_prompt: true },
      expect.objectContaining({ provider: 'rest', suppressTerminalQueueProcessing: true })
    );
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
        status: 'awaiting_input',
        ready_for_prompt: false,
        tasks: [awaitingInputTask.task_id],
      })),
      patch: vi.fn(async (_id, data) => data),
    };
    const tasksService = {
      patch: vi.fn(async (id, data) => ({ task_id: id, ...data })),
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
    const killExecutorProcess = vi.fn(() => true);

    const result = await stopSessionPreserveQueue(
      {
        app: app as never,
        taskRepo: taskRepo as never,
        sessionsService: sessionsService as never,
        tasksService: tasksService as never,
        killExecutorProcess,
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
    expect(killExecutorProcess).toHaveBeenCalledWith(sessionId);
    expect(tasksService.patch).toHaveBeenCalledWith(
      awaitingInputTask.task_id,
      expect.objectContaining({ status: 'stopped' }),
      expect.objectContaining({ suppressCompletionCallbacks: true })
    );
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
        status: 'running',
        ready_for_prompt: false,
        tasks: [runningTask.task_id],
      })),
      patch: vi.fn(async () => {
        throw new Error('patch denied');
      }),
    };
    const tasksService = {
      patch: vi.fn(async (id, data) => ({ task_id: id, ...data })),
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

    await expect(
      stopSessionPreserveQueue(
        {
          app: app as never,
          taskRepo: taskRepo as never,
          sessionsService: sessionsService as never,
          tasksService: tasksService as never,
          killExecutorProcess: vi.fn(() => true),
        },
        sessionId as never,
        { provider: 'rest' }
      )
    ).rejects.toThrow('patch denied');

    expect(tasksService.patch).toHaveBeenCalledWith(
      runningTask.task_id,
      expect.objectContaining({ status: 'stopped' }),
      expect.objectContaining({ suppressTerminalQueueProcessing: true })
    );
  });
});
