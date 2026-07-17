import { TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const containExecutorProcess = vi.hoisted(() => vi.fn());
const untrackExecutorProcess = vi.hoisted(() => vi.fn());
vi.mock('./executor-tracking.js', () => ({ containExecutorProcess, untrackExecutorProcess }));

import { forceFailUnverifiedTask, requestExecutorTermination } from './termination-coordinator.js';

function appDouble() {
  let task: any = {
    task_id: '018f0000-0000-7000-8000-000000000001',
    session_id: '018f0000-0000-7000-8000-000000000002',
    status: TaskStatus.RUNNING,
    created_at: '2026-01-01T00:00:00.000Z',
  };
  let session: any = {
    session_id: task.session_id,
    agentic_tool: 'codex',
    status: 'running',
    ready_for_prompt: false,
  };
  const taskPatch = vi.fn(async (_id, data) => (task = { ...task, ...data }));
  const sessionPatch = vi.fn(async (_id, data) => (session = { ...session, ...data }));
  const failForLostHeartbeat = vi.fn(async (_id, data) => {
    task = { ...task, ...data, status: TaskStatus.FAILED };
    session = { ...session, status: 'failed', ready_for_prompt: true };
    return task;
  });
  const app = {
    service: (name: string) =>
      name === 'tasks'
        ? { get: async () => task, patch: taskPatch, failForLostHeartbeat }
        : { get: async () => session, patch: sessionPatch },
  } as never;
  return { app, task: () => task, session: () => session, taskPatch, failForLostHeartbeat };
}

describe('termination coordinator', () => {
  beforeEach(() => {
    containExecutorProcess.mockReset();
    untrackExecutorProcess.mockReset();
  });

  it('releases a user-stopped session only after verified absence', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble();
    const result = await requestExecutorTermination({
      app: state.app,
      taskId: state.task().task_id,
      cause: 'user_stop',
      errorMessage: 'Stopped by user',
    });

    expect(result.status).toBe('terminal');
    expect(state.task().status).toBe(TaskStatus.STOPPED);
    expect(state.session()).toMatchObject({ status: 'idle', ready_for_prompt: true });
    expect(untrackExecutorProcess).toHaveBeenCalledOnce();
  });

  it('keeps the session blocked and visible when absence is unverified', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'unverified', reason: 'EPERM' });
    const state = appDouble();
    const result = await requestExecutorTermination({
      app: state.app,
      taskId: state.task().task_id,
      cause: 'heartbeat_lost',
      errorMessage: 'heartbeat lost',
      sdkFailure: {
        reason: 'heartbeat_lost',
        detected_at: '2026-01-01T00:00:05.000Z',
        tool: 'codex',
        termination: 'requested',
      },
    });

    expect(result.status).toBe('unverified');
    expect(state.task()).toMatchObject({
      status: TaskStatus.STOPPING,
      sdk_failure: { reason: 'heartbeat_lost', termination: 'unverified' },
    });
    expect(state.session()).toMatchObject({ status: 'stopping', ready_for_prompt: false });
    expect(state.failForLostHeartbeat).not.toHaveBeenCalled();
  });

  it('requires the short Task ID before force-failing unverified work', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'unverified', reason: 'EPERM' });
    const state = appDouble();
    await requestExecutorTermination({
      app: state.app,
      taskId: state.task().task_id,
      cause: 'heartbeat_lost',
      errorMessage: 'heartbeat lost',
    });

    await expect(
      forceFailUnverifiedTask({ app: state.app, taskId: state.task().task_id, confirmation: 'bad' })
    ).rejects.toThrow('Type 018f0000');
    await forceFailUnverifiedTask({
      app: state.app,
      taskId: state.task().task_id,
      confirmation: '018f00000000700080000000',
    });
    expect(state.task().status).toBe(TaskStatus.FAILED);
  });
});
