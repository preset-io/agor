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
  claimExecutorTermination,
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

  it('preserves ordered startup queue deferral', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble();
    state.claim(stopping('user_stop'));
    state.settle(task(TaskStatus.STOPPED));

    await requestExecutorTermination({
      app: state.app,
      taskId,
      cause: 'daemon_restart',
      errorMessage: 'Recovering after restart',
      params: { suppressTerminalQueueProcessing: true },
    });

    expect(state.settleTermination).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ suppressTerminalQueueProcessing: true })
    );
  });

  it('allows verified health containment to continue distinct queued work', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble();
    state.claim(stopping('sdk_health_failure'));
    state.settle(task(TaskStatus.FAILED));

    await request(state.app, 'sdk_health_failure');

    expect(state.settleTermination).toHaveBeenCalledWith(expect.anything(), {
      provider: undefined,
    });
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
    });
    setTimeout(() => {
      state.markExecutorQuiesced();
    }, 5);

    await expect(result).resolves.toMatchObject({ status: 'terminal' });
    expect(containExecutorProcess).not.toHaveBeenCalled();
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

  it('can persist ownership without starting containment in the service transaction', async () => {
    const state = appDouble();
    state.claim(stopping('sdk_health_failure'));

    const claim = await claimExecutorTermination({
      app: state.app,
      taskId,
      cause: 'sdk_health_failure',
      errorMessage: 'SDK stalled',
    });

    expect(claim).toMatchObject({
      outcome: 'claimed',
      task: { status: TaskStatus.STOPPING },
    });
    expect(containExecutorProcess).not.toHaveBeenCalled();
    expect(state.settleTermination).not.toHaveBeenCalled();
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
      status: 'unverified',
      task: { status: TaskStatus.STOPPING },
      reason: expect.stringContaining('owns the local executor process handle'),
    });
    expect(state.claimTerminationCoordination).not.toHaveBeenCalled();
    expect(containExecutorProcess).not.toHaveBeenCalled();
    expect(state.settleTermination).not.toHaveBeenCalled();
  });

  it('deduplicates containment while persisted cause precedence changes', async () => {
    const release = deferContainment();
    const state = appDouble();
    state.claim(stopping('sdk_health_failure'));
    state.claim(stopping('user_stop'));
    state.settle(task(TaskStatus.STOPPED));

    const sdkFailure = request(state.app, 'sdk_health_failure');
    const stop = request(state.app, 'user_stop');
    await vi.waitFor(() => expect(state.claimTermination).toHaveBeenCalledTimes(2));
    release();

    await expect(sdkFailure).resolves.toMatchObject({ status: 'terminal' });
    await expect(stop).resolves.toMatchObject({ status: 'terminal' });
    expect(containExecutorProcess).toHaveBeenCalledOnce();
    expect(state.settleTermination).toHaveBeenCalledOnce();
  });

  it('settles with the durable termination owner error when a later cause retries containment', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble();
    state.claim(
      task(TaskStatus.STOPPING, {
        termination_request: {
          cause: 'sdk_health_failure',
          requested_at: '2026-01-01T00:00:01.000Z',
          error_message: 'SDK activity stalled (operation_stalled).',
        },
      }),
      'unchanged'
    );
    state.settle(task(TaskStatus.FAILED));

    await request(state.app, 'heartbeat_lost');

    expect(state.settleTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: 'SDK activity stalled (operation_stalled).',
      }),
      expect.anything()
    );
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

  it('releases normal OpenCode settlement after cooperative quiescence and local absence', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble('opencode');
    state.claim(
      task(TaskStatus.STOPPING, {
        executor_connected_at: '2026-01-01T00:00:00.000Z',
        executor_mode: 'local',
        termination_request: {
          cause: 'runtime_settlement',
          requested_at: '2026-01-01T00:00:01.000Z',
          executor_quiesced_at: '2026-01-01T00:00:02.000Z',
          executor_settlement: { status: TaskStatus.COMPLETED },
        },
      })
    );
    state.settle(task(TaskStatus.COMPLETED));

    await expect(
      requestExecutorTermination({
        app: state.app,
        taskId,
        cause: 'runtime_settlement',
        errorMessage: 'Runtime settled',
      })
    ).resolves.toMatchObject({
      status: 'terminal',
      task: { status: TaskStatus.COMPLETED },
    });
  });

  it('keeps a user Stop stopping after runtime cleanup fails despite local wrapper absence', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    const state = appDouble('opencode');
    state.claim(
      task(TaskStatus.STOPPING, {
        executor_connected_at: '2026-01-01T00:00:00.000Z',
        executor_mode: 'local',
        termination_request: {
          cause: 'user_stop',
          requested_at: '2026-01-01T00:00:01.000Z',
          runtime_cleanup_unverified: true,
        },
      })
    );
    state.settle(task(TaskStatus.STOPPING), 'unverified');

    await expect(
      requestExecutorTermination({
        app: state.app,
        taskId,
        cause: 'runtime_cleanup_failed',
        errorMessage: 'Provider abort was not confirmed',
      })
    ).resolves.toMatchObject({
      status: 'unverified',
      task: { status: TaskStatus.STOPPING },
    });
    expect(state.settleTermination).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, outcome: 'unverified' }),
      expect.anything()
    );
  });

  it('settles local cleanup failure after absence but holds templated work without quiescence', async () => {
    containExecutorProcess
      .mockResolvedValueOnce({ status: 'verified_absent' })
      .mockResolvedValueOnce({ status: 'unverified', reason: 'remote runtime is not inspectable' });

    const local = appDouble('codex');
    local.claim(
      task(TaskStatus.STOPPING, {
        executor_connected_at: '2026-01-01T00:00:00.000Z',
        executor_mode: 'local',
        termination_request: {
          cause: 'runtime_cleanup_failed',
          requested_at: '2026-01-01T00:00:01.000Z',
        },
      })
    );
    local.settle(task(TaskStatus.FAILED));
    await expect(
      requestExecutorTermination({
        app: local.app,
        taskId,
        cause: 'runtime_cleanup_failed',
        errorMessage: 'Cleanup failed',
      })
    ).resolves.toMatchObject({ status: 'terminal' });

    const remote = appDouble('codex');
    remote.claim(
      task(TaskStatus.STOPPING, {
        executor_connected_at: '2026-01-01T00:00:00.000Z',
        executor_mode: 'templated',
        termination_request: {
          cause: 'runtime_cleanup_failed',
          requested_at: '2026-01-01T00:00:01.000Z',
        },
      })
    );
    remote.settle(task(TaskStatus.STOPPING), 'unverified');
    await expect(
      requestExecutorTermination({
        app: remote.app,
        taskId,
        cause: 'runtime_cleanup_failed',
        errorMessage: 'Cleanup failed',
      })
    ).resolves.toMatchObject({ status: 'unverified' });
  });


  it('accepts launch-fence absence before an OpenCode runtime connects', async () => {
    const state = appDouble('opencode');
    state.claim(stopping('heartbeat_lost'));
    state.settle(task(TaskStatus.FAILED));

    await expect(
      requestExecutorTermination({
        app: state.app,
        taskId,
        cause: 'heartbeat_lost',
        errorMessage: 'Executor failed before connection',
        absenceVerified: true,
      })
    ).resolves.toMatchObject({ status: 'terminal' });
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
    expect(state.settleTermination).toHaveBeenLastCalledWith(expect.anything(), {
      provider: undefined,
    });
  });
});
