import { EXECUTOR_TERMINAL_CAUSE } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { stopSessionPreserveQueue } from './session-stop.js';

function appWithTasks(tasks: unknown[]) {
  return {
    service: (name: string) => {
      if (name === 'tasks') return { find: vi.fn(async () => ({ data: tasks })) };
      throw new Error(`unexpected service ${name}`);
    },
  };
}

describe('stopSessionPreserveQueue', () => {
  it('records an executor stop under the lock and leaves reconciliation to the caller', async () => {
    const sessionId = 'session-1';
    const runningTask = {
      task_id: 'task-running',
      session_id: sessionId,
      status: 'running',
      executor_attempt_id: 'attempt-running',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const sessionsService = {
      get: vi.fn(async () => ({
        session_id: sessionId,
        status: 'running',
        agentic_tool: 'codex',
        ready_for_prompt: false,
      })),
      patch: vi.fn(async (_id, data) => data),
    };
    const tasksService = {
      patch: vi.fn(async (id, data) => ({ task_id: id, ...data })),
    };

    const result = await stopSessionPreserveQueue(
      {
        app: appWithTasks([runningTask]) as never,
        taskRepo: { findQueued: vi.fn(async () => [{ task_id: 'queued-1' }]) } as never,
        sessionsService: sessionsService as never,
        tasksService: tasksService as never,
      },
      sessionId as never,
      { provider: 'rest' },
      { reason: 'user requested' }
    );

    expect(result).toMatchObject({
      success: true,
      stoppedTaskId: runningTask.task_id,
      queuedTasksPreserved: 1,
      executorAttempt: {
        taskId: runningTask.task_id,
        executorAttemptId: runningTask.executor_attempt_id,
      },
    });
    expect(result.status).toBeUndefined();
    expect(sessionsService.patch).toHaveBeenCalledWith(
      sessionId,
      { status: 'stopping', ready_for_prompt: false },
      { provider: 'rest' }
    );
    expect(tasksService.patch).toHaveBeenCalledWith(
      runningTask.task_id,
      expect.objectContaining({
        status: 'stopped',
        executor_terminal_cause: EXECUTOR_TERMINAL_CAUSE.USER_STOP,
      }),
      { provider: undefined }
    );
  });

  it('finishes a non-executor stop locally while preserving queued work', async () => {
    const sessionId = 'session-cli';
    const runningTask = {
      task_id: 'task-cli',
      session_id: sessionId,
      status: 'running',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const sessionsService = {
      get: vi.fn(async () => ({
        session_id: sessionId,
        status: 'running',
        agentic_tool: 'claude-code-cli',
        ready_for_prompt: false,
      })),
      patch: vi.fn(async (_id, data) => data),
    };

    const result = await stopSessionPreserveQueue(
      {
        app: appWithTasks([runningTask]) as never,
        taskRepo: { findQueued: vi.fn(async () => []) } as never,
        sessionsService: sessionsService as never,
        tasksService: {
          patch: vi.fn(async (id, data) => ({ task_id: id, ...data })),
        } as never,
      },
      sessionId as never
    );

    expect(result).toMatchObject({ success: true, status: 'idle', queuedTasksPreserved: 0 });
    expect(result.executorAttempt).toBeUndefined();
    expect(sessionsService.patch).toHaveBeenLastCalledWith(
      sessionId,
      { status: 'idle', ready_for_prompt: true },
      {}
    );
  });

  it('keeps an executor session fenced when no active attempt can be proven', async () => {
    const sessionsService = {
      get: vi.fn(async () => ({
        session_id: 'session-missing',
        status: 'running',
        agentic_tool: 'codex',
        ready_for_prompt: false,
      })),
      patch: vi.fn(async (_id, data) => data),
    };

    const result = await stopSessionPreserveQueue(
      {
        app: appWithTasks([]) as never,
        taskRepo: { findQueued: vi.fn(async () => []) } as never,
        sessionsService: sessionsService as never,
        tasksService: { patch: vi.fn() } as never,
      },
      'session-missing' as never
    );

    expect(result).toMatchObject({ success: false, reason: expect.stringContaining('fenced') });
    expect(sessionsService.patch).toHaveBeenCalledWith(
      'session-missing',
      { status: 'failed', ready_for_prompt: false },
      expect.any(Object)
    );
  });

  it('restores the original session state when the terminal write did not commit', async () => {
    const sessionId = 'session-write-failure';
    const runningTask = {
      task_id: 'task-write-failure',
      session_id: sessionId,
      status: 'running',
      executor_attempt_id: 'attempt-write-failure',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const sessionsService = {
      get: vi.fn(async () => ({
        session_id: sessionId,
        status: 'running',
        agentic_tool: 'codex',
        ready_for_prompt: false,
      })),
      patch: vi.fn(async (_id, data) => data),
    };

    await expect(
      stopSessionPreserveQueue(
        {
          app: appWithTasks([runningTask]) as never,
          taskRepo: { findQueued: vi.fn(async () => []) } as never,
          sessionsService: sessionsService as never,
          tasksService: {
            patch: vi.fn(async () => {
              throw new Error('write failed');
            }),
            get: vi.fn(async () => runningTask),
          } as never,
        },
        sessionId as never
      )
    ).rejects.toThrow('write failed');
    expect(sessionsService.patch).toHaveBeenLastCalledWith(
      sessionId,
      { status: 'running', ready_for_prompt: false },
      {}
    );
  });
});
