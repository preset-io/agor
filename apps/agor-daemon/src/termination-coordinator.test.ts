import { TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const containExecutorProcess = vi.hoisted(() => vi.fn());
const getTrackedExecutor = vi.hoisted(() => vi.fn());
const untrackExecutorProcess = vi.hoisted(() => vi.fn());
vi.mock('./executor-tracking.js', () => ({
  containExecutorProcess,
  DEFAULT_EXECUTOR_KILL_GRACE_MS: 2_000,
  DEFAULT_EXECUTOR_TERM_GRACE_MS: 3_000,
  getTrackedExecutor,
  untrackExecutorProcess,
}));

import {
  beginExecutorTermination,
  forceFailUnverifiedTask,
  requestExecutorTermination,
} from './termination-coordinator.js';

const taskId = '018f0000-0000-7000-8000-000000000001';
const sessionId = '018f0000-0000-7000-8000-000000000002';
const runInFreshTenantWriteDatabase = <T>(work: () => Promise<T>): Promise<T> => work();

function task(status = TaskStatus.RUNNING, extra: Record<string, unknown> = {}) {
  return { task_id: taskId, session_id: sessionId, status, created_at: '2026-01-01', ...extra };
}

function appDouble(tool = 'codex') {
  let current = task();
  const claimTermination = vi.fn();
  const claimTerminationCoordination = vi.fn(async (input: { claimToken: string }) => {
    current = {
      ...current,
      termination_request: {
        ...current.termination_request,
        coordination: {
          claim_token: input.claimToken,
          claimed_at: '2026-01-01T00:00:01.000Z',
          lease_expires_at: '2026-01-01T00:00:31.000Z',
          instance_id: 'daemon-a',
          boot_id: 'boot-a',
        },
      },
    };
    return { outcome: 'claimed', task: current };
  });
  const settleTermination = vi.fn();
  const sessionGet = vi.fn(async () => ({ session_id: sessionId, agentic_tool: tool }));
  const app = {
    service: (name: string) =>
      name === 'tasks'
        ? {
            get: async () => current,
            claimTermination,
            claimTerminationCoordination,
            settleTermination,
          }
        : { get: sessionGet },
    get: () => ({ instanceId: 'daemon-a', bootId: 'boot-a' }),
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
  const setCurrent = (value: ReturnType<typeof task>) => {
    current = value;
  };
  const markExecutorQuiesced = () => {
    current = {
      ...current,
      termination_request: {
        ...current.termination_request,
        executor_quiesced_at: '2026-01-01T00:00:01.100Z',
      },
    };
  };
  return {
    app,
    claim,
    settle,
    setCurrent,
    markExecutorQuiesced,
    claimTermination,
    claimTerminationCoordination,
    settleTermination,
    sessionGet,
  };
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
    runInFreshTenantWriteDatabase,
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
    getTrackedExecutor.mockReset();
    getTrackedExecutor.mockReturnValue({ taskId, sessionId });
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

  it('accepts a scoped remote executor quiescence report without local signaling', async () => {
    const state = appDouble();
    const remoteStopping = {
      ...stopping('user_stop'),
      executor_mode: 'templated',
      executor_connected_at: '2026-01-01T00:00:00.000Z',
      termination_request: {
        ...stopping('user_stop').termination_request,
        executor_quiesced_at: '2026-01-01T00:00:01.100Z',
      },
    };
    state.claim(remoteStopping);
    state.settle(task(TaskStatus.STOPPED));

    await expect(request(state.app, 'user_stop')).resolves.toMatchObject({
      status: 'terminal',
      task: { status: TaskStatus.STOPPED },
    });
    expect(containExecutorProcess).not.toHaveBeenCalled();
  });

  it('observes a remote socket-stop report during the cooperative grace window', async () => {
    const state = appDouble();
    const remoteStopping = {
      ...stopping('user_stop'),
      executor_mode: 'templated',
      executor_connected_at: '2026-01-01T00:00:00.000Z',
    };
    state.claim(remoteStopping);
    state.settle(task(TaskStatus.STOPPED));

    const result = requestExecutorTermination({
      app: state.app,
      taskId,
      cause: 'user_stop',
      errorMessage: 'Stopped by user',
      cooperativeGraceMs: 100,
      runInFreshTenantWriteDatabase,
    });
    setTimeout(() => {
      state.markExecutorQuiesced();
    }, 5);

    await expect(result).resolves.toMatchObject({ status: 'terminal' });
    expect(containExecutorProcess).not.toHaveBeenCalled();
  });

  it('does not expose remote force-fail after only the local one-second signal grace', async () => {
    vi.useFakeTimers();
    try {
      const state = appDouble();
      const remoteStopping = {
        ...stopping('user_stop'),
        executor_mode: 'templated',
        executor_connected_at: '2026-01-01T00:00:00.000Z',
      };
      state.claim(remoteStopping);
      state.settle(task(TaskStatus.STOPPED));

      const result = request(state.app, 'user_stop');
      await vi.advanceTimersByTimeAsync(1_100);
      expect(state.settleTermination).not.toHaveBeenCalled();

      state.markExecutorQuiesced();
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toMatchObject({ status: 'terminal' });
      expect(containExecutorProcess).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the remote acknowledgement timeout without claiming local PID containment', async () => {
    vi.useFakeTimers();
    try {
      const state = appDouble();
      const remoteStopping = {
        ...stopping('user_stop'),
        executor_mode: 'templated',
        executor_connected_at: '2026-01-01T00:00:00.000Z',
      };
      state.claim(remoteStopping);
      state.settle(
        task(TaskStatus.STOPPING, {
          ...remoteStopping,
          sdk_failure: { termination: 'unverified' },
        }),
        'unverified'
      );

      const result = request(state.app, 'user_stop');
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(result).resolves.toMatchObject({
        status: 'unverified',
        reason: expect.stringContaining('did not acknowledge quiescence'),
      });
      expect(containExecutorProcess).not.toHaveBeenCalled();
      expect(state.settleTermination).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'unverified',
          errorMessage: expect.stringContaining('did not acknowledge quiescence'),
        }),
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('still verifies local process absence after executor quiescence', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble();
    const localStopping = {
      ...stopping('user_stop'),
      executor_mode: 'local',
      executor_connected_at: '2026-01-01T00:00:00.000Z',
      termination_request: {
        ...stopping('user_stop').termination_request,
        executor_quiesced_at: '2026-01-01T00:00:01.100Z',
      },
    };
    state.claim(localStopping);
    state.settle(task(TaskStatus.STOPPED));

    await request(state.app, 'user_stop');

    expect(containExecutorProcess).toHaveBeenCalledWith(
      sessionId,
      taskId,
      { preSignalGraceMs: 250 },
      state.app
    );
  });

  it('contains a terminal task before releasing its tracked executor', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble('opencode');
    state.claim(task(TaskStatus.COMPLETED), 'terminal');

    await expect(request(state.app, 'heartbeat_lost')).resolves.toMatchObject({
      status: 'terminal',
      task: { status: TaskStatus.COMPLETED },
    });
    expect(containExecutorProcess).toHaveBeenCalledWith(sessionId, taskId, {}, state.app);
    expect(untrackExecutorProcess).toHaveBeenCalledWith(sessionId, taskId, state.app);
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
        runInFreshTenantWriteDatabase,
      })
    ).resolves.toMatchObject({
      status: 'terminal',
      task: { status: TaskStatus.COMPLETED },
    });
    expect(containExecutorProcess).not.toHaveBeenCalled();
    expect(untrackExecutorProcess).toHaveBeenCalledWith(sessionId, taskId, state.app);
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
      runInFreshTenantWriteDatabase,
    });

    expect(requested.status).toBe(TaskStatus.STOPPING);
    expect(state.settleTermination).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(state.settleTermination).toHaveBeenCalledOnce());
  });

  it('extends the coordination lease beyond configurable cooperative and signal grace', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble();
    state.claim(stopping('heartbeat_lost'));
    state.settle(task(TaskStatus.FAILED));

    await requestExecutorTermination({
      app: state.app,
      taskId,
      cause: 'heartbeat_lost',
      errorMessage: 'Heartbeat lost',
      cooperativeGraceMs: 40_000,
      runInFreshTenantWriteDatabase,
    });

    expect(state.claimTerminationCoordination).toHaveBeenCalledWith(
      expect.objectContaining({ leaseDurationMs: 50_250 }),
      expect.any(Object)
    );
  });

  it('does not let a non-owner daemon claim verified local-process absence', async () => {
    getTrackedExecutor.mockReturnValue(undefined);
    const state = appDouble();
    state.claim({ ...stopping('heartbeat_lost'), executor_mode: 'local' });

    await expect(request(state.app, 'heartbeat_lost')).resolves.toMatchObject({
      status: 'pending',
      task: { status: TaskStatus.STOPPING },
      pendingCode: 'non_owner_replica',
      reason: expect.stringContaining('owns the local executor process handle'),
    });
    expect(state.claimTerminationCoordination).not.toHaveBeenCalled();
    expect(containExecutorProcess).not.toHaveBeenCalled();
    expect(state.settleTermination).not.toHaveBeenCalled();
  });

  it('reports a durable containment lease as structured coordination pending', async () => {
    const state = appDouble();
    const requested = stopping('user_stop');
    state.claim(requested);
    state.claimTerminationCoordination.mockResolvedValueOnce({
      outcome: 'pending',
      task: requested,
    });

    await expect(request(state.app, 'user_stop')).resolves.toMatchObject({
      status: 'pending',
      task: { status: TaskStatus.STOPPING },
      pendingCode: 'coordination_in_progress',
      reason: expect.stringContaining('Another daemon'),
    });
    expect(containExecutorProcess).not.toHaveBeenCalled();
    expect(state.settleTermination).not.toHaveBeenCalled();
  });

  it('contains a terminal SDK-health race in the background', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble('opencode');
    state.claim(task(TaskStatus.COMPLETED), 'terminal');

    const result = await beginExecutorTermination({
      app: state.app,
      taskId,
      cause: 'sdk_health_failure',
      errorMessage: 'SDK stalled',
      runInFreshTenantWriteDatabase,
    });

    expect(result.status).toBe(TaskStatus.COMPLETED);
    await vi.waitFor(() =>
      expect(containExecutorProcess).toHaveBeenCalledWith(sessionId, taskId, {}, state.app)
    );
    expect(untrackExecutorProcess).toHaveBeenCalledWith(sessionId, taskId, state.app);
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
      runInFreshTenantWriteDatabase,
    });
    const stop = request(state.app, 'user_stop');
    await vi.waitFor(() => expect(state.claimTermination).toHaveBeenCalledTimes(2));
    release();

    await expect(stop).resolves.toMatchObject({ status: 'terminal' });
    expect(containExecutorProcess).toHaveBeenCalledOnce();
    expect(state.settleTermination).toHaveBeenCalledOnce();
  });

  it.each(['codex', 'opencode'])(
    'keeps %s work blocked when absence is unverified',
    async (tool) => {
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
    }
  );

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

  it('does not infer provider quiescence from verified local process-group absence', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble('opencode');
    state.claim(stopping('user_stop'));
    state.settle(
      task(TaskStatus.STOPPING, {
        termination_request: stopping('user_stop').termination_request,
        sdk_failure: { termination: 'unverified' },
      }),
      'unverified'
    );

    await expect(request(state.app, 'user_stop')).resolves.toMatchObject({
      status: 'unverified',
      reason: 'OpenCode server-side execution termination is not verified.',
      task: { status: TaskStatus.STOPPING, sdk_failure: { termination: 'unverified' } },
    });
    expect(state.settleTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        outcome: 'unverified',
        errorMessage: expect.stringContaining(
          'OpenCode server-side execution termination is not verified.'
        ),
      }),
      expect.objectContaining({ suppressTerminalQueueProcessing: true })
    );
    expect(untrackExecutorProcess).not.toHaveBeenCalled();
  });

  it('generically contains historical Claude CLI work during recovery', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble('claude-code-cli');
    state.claim(stopping('heartbeat_lost'));
    state.settle(task(TaskStatus.FAILED));

    await expect(request(state.app, 'heartbeat_lost')).resolves.toMatchObject({
      status: 'terminal',
      task: { status: TaskStatus.FAILED },
    });
    expect(containExecutorProcess).toHaveBeenCalledWith(sessionId, taskId, {}, state.app);
  });

  it('requires the stable STOP phrase before force-failing unverified work', async () => {
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
      forceFailUnverifiedTask({
        app: state.app,
        taskId,
        terminationRequestedAt: '2026-01-01T00:00:01.000Z',
        confirmation: 'bad',
      })
    ).rejects.toThrow('Type STOP');
    await expect(
      forceFailUnverifiedTask({
        app: state.app,
        taskId,
        terminationRequestedAt: '2026-01-01T00:00:00.000Z',
        confirmation: 'STOP',
      })
    ).rejects.toThrow('termination state changed');
    state.settle(task(TaskStatus.FAILED));
    await expect(
      forceFailUnverifiedTask({
        app: state.app,
        taskId,
        terminationRequestedAt: '2026-01-01T00:00:01.000Z',
        confirmation: 'STOP',
      })
    ).resolves.toMatchObject({ outcome: 'force_failed', task: { status: TaskStatus.FAILED } });
    expect(state.settleTermination).toHaveBeenCalledTimes(2);
    expect(state.settleTermination).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: 'forced_unverified',
        expectedTerminationRequestedAt: '2026-01-01T00:00:01.000Z',
      }),
      expect.objectContaining({ suppressTerminalQueueProcessing: true })
    );
  });

  it('reports a concurrent terminal settlement instead of claiming force-fail won', async () => {
    const state = appDouble();
    state.setCurrent(
      task(TaskStatus.STOPPING, {
        termination_request: stopping('user_stop').termination_request,
        sdk_failure: { termination: 'unverified' },
      })
    );
    state.settle(task(TaskStatus.STOPPED), 'terminal');
    const securityLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      forceFailUnverifiedTask({
        app: state.app,
        taskId,
        terminationRequestedAt: '2026-01-01T00:00:01.000Z',
        confirmation: 'STOP',
      })
    ).resolves.toMatchObject({ outcome: 'already_terminal', task: { status: TaskStatus.STOPPED } });
    expect(securityLog).not.toHaveBeenCalled();
    expect(untrackExecutorProcess).toHaveBeenCalledWith(sessionId, taskId, state.app);
    securityLog.mockRestore();
  });
});
