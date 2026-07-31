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
          sessionsService: { get: vi.fn().mockResolvedValue(session), patch: vi.fn() } as never,
          requestTermination: requestTermination as never,
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
    const requestTermination = vi.fn(async () => ({ status: 'terminal', task: runningTask }));
    const params = { provider: 'rest' };

    const result = await stopSessionPreserveQueue(
      {
        app: app as never,
        taskRepo: taskRepo as never,
        sessionsService: sessionsService as never,
        requestTermination: requestTermination as never,
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
        params: expect.objectContaining({ suppressTerminalQueueProcessing: true }),
      })
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
        sessionsService: sessionsService as never,
        requestTermination: requestTermination as never,
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
          sessionsService: sessionsService as never,
          requestTermination: requestTermination as never,
        },
        sessionId as never,
        { provider: 'rest' }
      )
    ).rejects.toThrow('containment failed');
  });
});
