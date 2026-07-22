import { TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const containExecutorProcess = vi.hoisted(() => vi.fn());
const untrackExecutorProcess = vi.hoisted(() => vi.fn());
vi.mock('./executor-tracking.js', () => ({ containExecutorProcess, untrackExecutorProcess }));

import {
  beginExecutorTermination,
  forceFailUnverifiedTask,
  requestExecutorTermination,
} from './termination-coordinator.js';

const taskId = '018f0000-0000-7000-8000-000000000001';
const sessionId = '018f0000-0000-7000-8000-000000000002';

function task(status = TaskStatus.RUNNING, extra: Record<string, unknown> = {}) {
  return { task_id: taskId, session_id: sessionId, status, created_at: '2026-01-01', ...extra };
}

function appDouble(tool = 'codex') {
  let current = task();
  const claimTermination = vi.fn();
  const settleTermination = vi.fn();
  const sessionGet = vi.fn(async () => ({ session_id: sessionId, agentic_tool: tool }));
  const app = {
    service: (name: string) =>
      name === 'tasks'
        ? { get: async () => current, claimTermination, settleTermination }
        : { get: sessionGet },
  } as never;
  const claim = (value: ReturnType<typeof task>, outcome = 'claimed') => {
    claimTermination.mockImplementationOnce(async () => {
      current = value;
      return { outcome, task: value };
    });
  };
  const settle = (value: ReturnType<typeof task>, outcome = 'transitioned') => {
    settleTermination.mockImplementationOnce(async () => {
      current = value;
      return { outcome, task: value };
    });
  };
  return { app, claim, settle, claimTermination, settleTermination, sessionGet };
}

const stopping = (cause: 'user_stop' | 'sdk_health_failure' | 'heartbeat_lost') =>
  task(TaskStatus.STOPPING, {
    termination_request: {
      cause,
      requested_at: '2026-01-01T00:00:01.000Z',
    },
  });

function request(app: never, cause: 'user_stop' | 'sdk_health_failure' | 'heartbeat_lost') {
  return requestExecutorTermination({
    app,
    taskId,
    cause,
    errorMessage: cause === 'user_stop' ? 'Stopped by user' : `${cause} failure`,
  });
}

function deferContainment() {
  let release!: (value: { status: 'verified_absent' }) => void;
  containExecutorProcess.mockReturnValue(new Promise((resolve) => (release = resolve)));
  return () => release({ status: 'verified_absent' });
}

describe('termination coordinator', () => {
  beforeEach(() => {
    containExecutorProcess.mockReset();
    untrackExecutorProcess.mockReset();
  });

  it('releases a user-stopped task only after verified absence', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble();
    state.claim(stopping('user_stop'));
    state.settle(task(TaskStatus.STOPPED));

    await expect(request(state.app, 'user_stop')).resolves.toMatchObject({
      status: 'terminal',
      task: { status: TaskStatus.STOPPED },
    });
    expect(untrackExecutorProcess).toHaveBeenCalledOnce();
  });

  it('contains a terminal task before releasing its tracked executor', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble();
    state.claim(task(TaskStatus.COMPLETED), 'terminal');

    await expect(request(state.app, 'heartbeat_lost')).resolves.toMatchObject({
      status: 'terminal',
      task: { status: TaskStatus.COMPLETED },
    });
    expect(containExecutorProcess).toHaveBeenCalledWith(sessionId, taskId);
    expect(untrackExecutorProcess).toHaveBeenCalledWith(sessionId, taskId);
    expect(containExecutorProcess.mock.invocationCallOrder[0]).toBeLessThan(
      untrackExecutorProcess.mock.invocationCallOrder[0]
    );
    expect(state.settleTermination).not.toHaveBeenCalled();
  });

  it('keeps a terminal task tracked when containment is unverified', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'unverified', reason: 'EPERM' });
    const state = appDouble();
    state.claim(task(TaskStatus.COMPLETED), 'terminal');

    await expect(request(state.app, 'heartbeat_lost')).resolves.toMatchObject({
      status: 'unverified',
      task: { status: TaskStatus.COMPLETED },
      reason: 'EPERM',
    });
    expect(state.settleTermination).not.toHaveBeenCalled();
    expect(untrackExecutorProcess).not.toHaveBeenCalled();
  });

  it('does not signal a terminal task when absence is already verified', async () => {
    const state = appDouble();
    state.claim(task(TaskStatus.COMPLETED), 'terminal');

    await expect(
      requestExecutorTermination({
        app: state.app,
        taskId,
        cause: 'heartbeat_lost',
        errorMessage: 'heartbeat_lost failure',
        absenceVerified: true,
      })
    ).resolves.toMatchObject({
      status: 'terminal',
      task: { status: TaskStatus.COMPLETED },
    });
    expect(containExecutorProcess).not.toHaveBeenCalled();
    expect(untrackExecutorProcess).toHaveBeenCalledWith(sessionId, taskId);
  });

  it('does not claim or signal when provider context cannot be loaded', async () => {
    const state = appDouble();
    state.sessionGet.mockRejectedValue(new Error('session unavailable'));

    await expect(request(state.app, 'user_stop')).rejects.toThrow('session unavailable');
    expect(state.claimTermination).not.toHaveBeenCalled();
    expect(containExecutorProcess).not.toHaveBeenCalled();
  });

  it('persists ownership before background containment completes', async () => {
    const release = deferContainment();
    const state = appDouble();
    state.claim(stopping('sdk_health_failure'));
    state.settle(task(TaskStatus.FAILED));

    const requested = await beginExecutorTermination({
      app: state.app,
      taskId,
      cause: 'sdk_health_failure',
      errorMessage: 'SDK stalled',
    });

    expect(requested.status).toBe(TaskStatus.STOPPING);
    expect(state.settleTermination).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(state.settleTermination).toHaveBeenCalledOnce());
  });

  it('contains a terminal SDK-health race in the background', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble();
    state.claim(task(TaskStatus.COMPLETED), 'terminal');

    const result = await beginExecutorTermination({
      app: state.app,
      taskId,
      cause: 'sdk_health_failure',
      errorMessage: 'SDK stalled',
    });

    expect(result.status).toBe(TaskStatus.COMPLETED);
    await vi.waitFor(() => expect(containExecutorProcess).toHaveBeenCalledWith(sessionId, taskId));
    expect(untrackExecutorProcess).toHaveBeenCalledWith(sessionId, taskId);
    expect(state.settleTermination).not.toHaveBeenCalled();
  });

  it('deduplicates containment while persisted cause precedence changes', async () => {
    const release = deferContainment();
    const state = appDouble();
    state.claim(stopping('sdk_health_failure'));
    state.claim(stopping('user_stop'));
    state.settle(task(TaskStatus.STOPPED));

    await beginExecutorTermination({
      app: state.app,
      taskId,
      cause: 'sdk_health_failure',
      errorMessage: 'SDK stalled',
    });
    const stop = request(state.app, 'user_stop');
    await vi.waitFor(() => expect(state.claimTermination).toHaveBeenCalledTimes(2));
    release();

    await expect(stop).resolves.toMatchObject({ status: 'terminal' });
    expect(containExecutorProcess).toHaveBeenCalledOnce();
    expect(state.settleTermination).toHaveBeenCalledOnce();
  });

  it.each([
    'codex',
    'opencode',
  ])('keeps %s work blocked when absence is unverified', async (tool) => {
    containExecutorProcess.mockResolvedValue({ status: 'unverified', reason: 'EPERM' });
    const state = appDouble(tool);
    state.claim(stopping('heartbeat_lost'));
    state.settle(
      task(TaskStatus.STOPPING, { sdk_failure: { termination: 'unverified' } }),
      'unverified'
    );

    await expect(request(state.app, 'heartbeat_lost')).resolves.toMatchObject({
      status: 'unverified',
      task: { status: TaskStatus.STOPPING, sdk_failure: { termination: 'unverified' } },
    });
  });

  it('keeps tracking when unverified containment races with terminal settlement', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'unverified', reason: 'EPERM' });
    const state = appDouble();
    state.claim(stopping('heartbeat_lost'));
    state.settle(task(TaskStatus.COMPLETED), 'terminal');

    await expect(request(state.app, 'heartbeat_lost')).resolves.toMatchObject({
      status: 'unverified',
      task: { status: TaskStatus.COMPLETED },
      reason: 'EPERM',
    });
    expect(untrackExecutorProcess).not.toHaveBeenCalled();
  });

  it('does not infer OpenCode provider quiescence from local process absence', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble('opencode');
    state.claim(stopping('user_stop'));
    state.settle(task(TaskStatus.STOPPING), 'unverified');

    await expect(request(state.app, 'user_stop')).resolves.toMatchObject({
      status: 'unverified',
    });
  });

  it('requires the short Task ID before force-failing unverified work', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'unverified', reason: 'EPERM' });
    const state = appDouble();
    state.claim(stopping('heartbeat_lost'));
    state.settle(
      task(TaskStatus.STOPPING, {
        termination_request: stopping('heartbeat_lost').termination_request,
        sdk_failure: { termination: 'unverified' },
      }),
      'unverified'
    );
    await request(state.app, 'heartbeat_lost');

    await expect(
      forceFailUnverifiedTask({ app: state.app, taskId, confirmation: 'bad' })
    ).rejects.toThrow('Type 018f0000');
    state.settle(task(TaskStatus.FAILED));
    await forceFailUnverifiedTask({
      app: state.app,
      taskId,
      confirmation: '018f00000000700080000000',
    });
    expect(state.settleTermination).toHaveBeenCalledTimes(2);
  });
});
