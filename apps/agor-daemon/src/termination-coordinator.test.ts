import { SessionStatus, TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const containExecutorProcess = vi.hoisted(() => vi.fn());
const untrackExecutorProcess = vi.hoisted(() => vi.fn());
vi.mock('./executor-tracking.js', () => ({ containExecutorProcess, untrackExecutorProcess }));

import {
  beginExecutorTermination,
  forceFailUnverifiedTask,
  requestExecutorTermination,
} from './termination-coordinator.js';

function appDouble(tool = 'codex') {
  let task: any = {
    task_id: '018f0000-0000-7000-8000-000000000001',
    session_id: '018f0000-0000-7000-8000-000000000002',
    status: TaskStatus.RUNNING,
    created_at: '2026-01-01T00:00:00.000Z',
  };
  let session: any = {
    session_id: task.session_id,
    agentic_tool: tool,
    status: SessionStatus.RUNNING,
    ready_for_prompt: false,
  };
  const claimTermination = vi.fn(async (input) => {
    if ([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.STOPPED].includes(task.status)) {
      return { outcome: 'terminal', task };
    }
    const existing = task.termination_request;
    const cause = input.cause === 'user_stop' || !existing ? input.cause : existing.cause;
    task = {
      ...task,
      status: TaskStatus.STOPPING,
      termination_request: {
        cause,
        requested_at: existing?.requested_at ?? '2026-01-01T00:00:01.000Z',
        final_status: cause === 'user_stop' ? 'stopped' : 'failed',
        error_message: cause === input.cause ? input.errorMessage : existing?.error_message,
      },
      sdk_failure:
        input.cause === 'user_stop' ? task.sdk_failure : (input.sdkFailure ?? task.sdk_failure),
    };
    session = { ...session, status: SessionStatus.STOPPING, ready_for_prompt: false };
    return { outcome: existing?.cause === cause ? 'unchanged' : 'claimed', task };
  });
  const settleTermination = vi.fn(async (input) => {
    if (input.outcome === 'unverified') {
      task = {
        ...task,
        error_message: input.errorMessage,
        sdk_failure: { ...input.sdkFailure, termination: 'unverified' },
      };
      return { outcome: 'unverified', task };
    }
    const status =
      input.outcome === 'forced_unverified'
        ? TaskStatus.FAILED
        : task.termination_request.cause === 'user_stop'
          ? TaskStatus.STOPPED
          : TaskStatus.FAILED;
    task = { ...task, status };
    session = {
      ...session,
      status: status === TaskStatus.STOPPED ? SessionStatus.IDLE : SessionStatus.FAILED,
      ready_for_prompt: true,
    };
    return { outcome: 'transitioned', task };
  });
  const app = {
    service: (name: string) =>
      name === 'tasks'
        ? { get: async () => task, claimTermination, settleTermination }
        : { get: async () => session },
  } as never;
  return { app, task: () => task, session: () => session, claimTermination, settleTermination };
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

  it('persists ownership before background containment completes', async () => {
    let release!: (value: { status: 'verified_absent' }) => void;
    containExecutorProcess.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const state = appDouble();

    const requested = await beginExecutorTermination({
      app: state.app,
      taskId: state.task().task_id,
      cause: 'sdk_health_failure',
      errorMessage: 'SDK stalled',
    });

    expect(requested.status).toBe(TaskStatus.STOPPING);
    expect(state.settleTermination).not.toHaveBeenCalled();
    release({ status: 'verified_absent' });
    await vi.waitFor(() => expect(state.settleTermination).toHaveBeenCalledOnce());
  });

  it('observes a user Stop recorded while containment is running', async () => {
    let release!: (value: { status: 'verified_absent' }) => void;
    containExecutorProcess.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const state = appDouble();
    await beginExecutorTermination({
      app: state.app,
      taskId: state.task().task_id,
      cause: 'sdk_health_failure',
      errorMessage: 'SDK stalled',
    });
    const stop = requestExecutorTermination({
      app: state.app,
      taskId: state.task().task_id,
      cause: 'user_stop',
      errorMessage: 'Stopped by user',
    });
    await vi.waitFor(() => expect(state.task().termination_request?.cause).toBe('user_stop'));
    release({ status: 'verified_absent' });

    await expect(stop).resolves.toMatchObject({ status: 'terminal' });
    expect(state.task().status).toBe(TaskStatus.STOPPED);
    expect(containExecutorProcess).toHaveBeenCalledOnce();
  });

  it('keeps local and OpenCode work blocked when absence is unverified', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'unverified', reason: 'EPERM' });
    for (const tool of ['codex', 'opencode']) {
      const state = appDouble(tool);
      const result = await requestExecutorTermination({
        app: state.app,
        taskId: state.task().task_id,
        cause: 'heartbeat_lost',
        errorMessage: 'heartbeat lost',
      });
      expect(result.status).toBe('unverified');
      expect(state.task()).toMatchObject({
        status: TaskStatus.STOPPING,
        sdk_failure: { termination: 'unverified' },
      });
    }
  });

  it('does not infer OpenCode provider quiescence from local process absence', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble('opencode');
    const result = await requestExecutorTermination({
      app: state.app,
      taskId: state.task().task_id,
      cause: 'user_stop',
      errorMessage: 'Stopped by user',
    });
    expect(result.status).toBe('unverified');
    expect(state.task().status).toBe(TaskStatus.STOPPING);
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
