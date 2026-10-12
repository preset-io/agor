import { runWithTenantContext } from '@agor/core/db';
import {
  AGENTIC_TOOL_NAMES,
  EXECUTOR_LAUNCH_REFUSED_MESSAGE,
  type Task,
  TaskStatus,
} from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runCleanup = vi.hoisted(() => vi.fn());
vi.mock('./utils/executor-cleanup-command.js', () => ({
  DEFAULT_CLEANUP_TIMEOUT_MS: 30000,
  runExecutorCleanupCommand: runCleanup,
}));

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

function task(
  status: Task['status'] = TaskStatus.RUNNING,
  extra: Record<string, unknown> = {}
): Task {
  return {
    task_id: taskId,
    session_id: sessionId,
    status,
    created_at: '2026-01-01',
    ...extra,
  } as Task;
}

function appDouble(tool = 'codex', options: { getDelayMs?: number; config?: unknown } = {}) {
  let current = task();
  const getCurrent = async () => {
    if (options.getDelayMs) await new Promise((resolve) => setTimeout(resolve, options.getDelayMs));
    return current;
  };
  const claimTermination = vi.fn();
  const claimTerminationCoordination = vi.fn(async (input: { claimToken: string }) => {
    current = {
      ...current,
      termination_request: {
        ...current.termination_request!,
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
  const beginCleanupAttempt = vi.fn(async () => {
    const request = current.termination_request!;
    if (request.cleanup_attempt) return null;
    current = {
      ...current,
      termination_request: {
        ...request,
        cleanup_attempt: { attempt_id: 'attempt-a', started_at: new Date().toISOString() },
      },
    };
    return current;
  });
  const settleTermination = vi.fn();
  const sessionGet = vi.fn(async () => ({
    session_id: sessionId,
    agentic_tool: tool,
    branch_id: 'branch-a',
  }));
  const app = {
    service: (name: string) =>
      name === 'tasks'
        ? {
            get: getCurrent,
            claimTermination,
            claimTerminationCoordination,
            beginCleanupAttempt,
            settleTermination,
          }
        : { get: sessionGet },
    get: (key: string) =>
      key === 'config' ? options.config : { instanceId: 'daemon-a', bootId: 'boot-a' },
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
        ...current.termination_request!,
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
    getCurrent,
    beginCleanupAttempt,
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
      executor_mode: 'templated' as const,
      executor_connected_at: '2026-01-01T00:00:00.000Z',
      termination_request: {
        ...stopping('user_stop').termination_request!,
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

  it.each(['OOMKilled', 'Error'])(
    'settles simulated authoritative substrate absence (%s), not merely lost contact',
    async (reason) => {
      const state = appDouble();
      state.claim({
        ...stopping('heartbeat_lost'),
        executor_mode: 'templated' as const,
        executor_connected_at: '2026-01-01T00:00:00.000Z',
      });
      state.settle(task(TaskStatus.FAILED));
      // Internal seam only. Core does not yet ingest external Job evidence. The
      // future adapter must prove whole-workload absence before setting this;
      // this fixture simulates that proof, never a launcher 137 inference.
      const errorMessage = `Execution substrate confirmed container termination: ${reason}.`;
      await expect(
        requestExecutorTermination({
          app: state.app,
          taskId,
          cause: 'heartbeat_lost',
          errorMessage,
          absenceVerified: true,
          cooperativeGraceMs: 0,
          runInFreshTenantWriteDatabase,
        })
      ).resolves.toMatchObject({ status: 'terminal', task: { status: TaskStatus.FAILED } });
      expect(state.settleTermination).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          outcome: 'verified_absent',
          errorMessage,
          coordinationToken: expect.any(String),
        }),
        expect.anything()
      );
      expect(containExecutorProcess).not.toHaveBeenCalled();
    }
  );

  it('settles a quiesced hosted OpenCode executor without the blanket unverified reason', async () => {
    const state = appDouble('opencode', {
      config: {
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        execution: {
          unix_user_mode: 'delegated',
          executor_command_template: 'launch {task_id}',
          executor_storage: { user_home: 'persistent-per-user' },
        },
      },
    });
    const remoteStopping = {
      ...stopping('user_stop'),
      executor_mode: 'templated' as const,
      executor_connected_at: '2026-01-01T00:00:00.000Z',
      termination_request: {
        ...stopping('user_stop').termination_request!,
        executor_quiesced_at: '2026-01-01T00:00:01.100Z',
      },
    };
    state.claim(remoteStopping);
    state.settle(task(TaskStatus.STOPPED));

    await expect(request(state.app, 'user_stop')).resolves.toMatchObject({
      status: 'terminal',
      task: { status: TaskStatus.STOPPED },
    });
    expect(state.settleTermination).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'unverified' }),
      expect.anything()
    );
  });

  it('observes a remote socket-stop report during the cooperative grace window', async () => {
    const state = appDouble();
    const remoteStopping = {
      ...stopping('user_stop'),
      executor_mode: 'templated' as const,
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
        executor_mode: 'templated' as const,
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
        executor_mode: 'templated' as const,
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
          errorMessage: expect.stringContaining('could not confirm that the previous work stopped'),
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
      executor_mode: 'local' as const,
      executor_connected_at: '2026-01-01T00:00:00.000Z',
      termination_request: {
        ...stopping('user_stop').termination_request!,
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
        errorMessage: expect.stringContaining('could not confirm that the previous work stopped'),
      }),
      expect.objectContaining({ suppressTerminalQueueProcessing: true })
    );
    expect(untrackExecutorProcess).not.toHaveBeenCalled();
  });

  // A templated launch refused by an opted-in launcher, as the prompt onExit requests it.
  const refusedDispatch = () =>
    task(TaskStatus.STOPPING, {
      executor_mode: 'templated',
      started_at: '2026-01-01T00:00:00.500Z',
      termination_request: {
        cause: 'launch_refused',
        requested_at: '2026-01-01T00:00:01.000Z',
        error_message: EXECUTOR_LAUNCH_REFUSED_MESSAGE,
      },
      sdk_failure: { reason: 'launch_refused', termination: 'requested' },
    });

  it.each(AGENTIC_TOOL_NAMES)(
    'settles a refused templated launch of %s as verified and failed',
    async (tool) => {
      const state = appDouble(tool);
      state.claim(refusedDispatch());
      state.settle(
        task(TaskStatus.FAILED, {
          termination_request: refusedDispatch().termination_request,
          sdk_failure: { reason: 'launch_refused', termination: 'verified' },
          error_message: EXECUTOR_LAUNCH_REFUSED_MESSAGE,
        })
      );

      await expect(
        requestExecutorTermination({
          app: state.app,
          taskId,
          cause: 'launch_refused',
          errorMessage: EXECUTOR_LAUNCH_REFUSED_MESSAGE,
          absenceVerified: true,
          sdkFailure: {
            reason: 'launch_refused',
            detected_at: '2026-01-01T00:00:01.000Z',
            tool,
            termination: 'requested',
          },
          expectedStatus: TaskStatus.DISPATCHING,
          requireExecutorDisconnected: true,
          runInFreshTenantWriteDatabase,
        })
      ).resolves.toMatchObject({ status: 'terminal', task: { status: TaskStatus.FAILED } });
      expect(state.settleTermination).toHaveBeenCalledOnce();
      expect(state.settleTermination).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId,
          outcome: 'verified_absent',
          errorMessage: EXECUTOR_LAUNCH_REFUSED_MESSAGE,
        }),
        expect.anything()
      );
      expect(containExecutorProcess).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'keeps the OpenCode safeguard for bare launcher absence (hosted=%s)',
    async (hosted) => {
      const state = appDouble('opencode', {
        config: hosted
          ? {
              multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
              execution: {
                unix_user_mode: 'delegated',
                executor_command_template: 'launch {task_id}',
                executor_storage: { user_home: 'persistent-per-user' },
              },
            }
          : undefined,
      });
      const lostDispatch = {
        ...refusedDispatch(),
        termination_request: {
          cause: 'heartbeat_lost',
          requested_at: '2026-01-01T00:00:01.000Z',
        },
        sdk_failure: { reason: 'heartbeat_lost', termination: 'requested' },
      };
      state.claim(lostDispatch);
      state.settle(
        task(TaskStatus.STOPPING, {
          termination_request: lostDispatch.termination_request,
          sdk_failure: { reason: 'heartbeat_lost', termination: 'unverified' },
        }),
        'unverified'
      );

      await expect(
        requestExecutorTermination({
          app: state.app,
          taskId,
          cause: 'heartbeat_lost',
          errorMessage: 'Executor exited unexpectedly with code 1.',
          absenceVerified: true,
          runInFreshTenantWriteDatabase,
        })
      ).resolves.toMatchObject({
        status: 'unverified',
        reason: 'OpenCode server-side execution termination is not verified.',
      });
      expect(state.settleTermination).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'unverified' }),
        expect.anything()
      );
    }
  );

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

describe('termination coordinator: remote executor not yet connected', () => {
  beforeEach(() => {
    containExecutorProcess.mockReset();
    getTrackedExecutor.mockReset();
    getTrackedExecutor.mockReturnValue(undefined);
    untrackExecutorProcess.mockReset();
  });

  const remoteDispatching = () => ({
    ...stopping('user_stop'),
    executor_mode: 'templated' as const,
    started_at: '2026-01-01T00:00:00.500Z',
  });

  it('returns pending without a lease or an unverified guard on the first Stop', async () => {
    const state = appDouble();
    state.claim(remoteDispatching());
    const startedAt = Date.now();

    await expect(request(state.app, 'user_stop')).resolves.toMatchObject({
      status: 'pending',
      pendingCode: 'awaiting_remote_executor',
      task: { status: TaskStatus.STOPPING },
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(state.claimTerminationCoordination).not.toHaveBeenCalled();
    expect(state.settleTermination).not.toHaveBeenCalled();
    expect(containExecutorProcess).not.toHaveBeenCalled();
  });

  it('stays pending on a repeated Stop whose claim is unchanged', async () => {
    const state = appDouble();
    state.claim(remoteDispatching(), 'unchanged');

    await expect(request(state.app, 'user_stop')).resolves.toMatchObject({
      status: 'pending',
      pendingCode: 'awaiting_remote_executor',
    });
    expect(state.claimTerminationCoordination).not.toHaveBeenCalled();
    expect(state.settleTermination).not.toHaveBeenCalled();
  });

  it('does not report pending for a task already guarded as unverified', async () => {
    const state = appDouble();
    state.claim(
      {
        ...remoteDispatching(),
        sdk_failure: {
          reason: 'termination_unverified',
          termination: 'unverified',
          detected_at: '2026-01-01T00:00:00Z',
          tool: 'codex',
        },
      },
      'unchanged'
    );
    state.settle(
      task(TaskStatus.STOPPING, { sdk_failure: { termination: 'unverified' } }),
      'condition_changed'
    );

    const result = await request(state.app, 'user_stop');
    expect(result.status).not.toBe('pending');
  });

  it('keeps the pending request out of beginExecutorTermination containment', async () => {
    const state = appDouble();
    state.claim(remoteDispatching());

    await expect(
      beginExecutorTermination({
        app: state.app,
        taskId,
        cause: 'user_stop',
        errorMessage: 'Stopped by user',
        runInFreshTenantWriteDatabase,
      })
    ).resolves.toMatchObject({ status: TaskStatus.STOPPING });
    expect(state.claimTerminationCoordination).not.toHaveBeenCalled();
    expect(state.settleTermination).not.toHaveBeenCalled();
  });

  it('settles stopped when the late executor reports quiescence without ever connecting', async () => {
    const state = appDouble();
    state.claim(
      {
        ...remoteDispatching(),
        termination_request: {
          ...stopping('user_stop').termination_request!,
          executor_quiesced_at: '2026-01-01T00:00:40.000Z',
        },
      },
      'unchanged'
    );
    state.settle(task(TaskStatus.STOPPED));

    await expect(request(state.app, 'user_stop')).resolves.toMatchObject({
      status: 'terminal',
      task: { status: TaskStatus.STOPPED },
    });
    expect(containExecutorProcess).not.toHaveBeenCalled();
  });

  it('settles a guarded "never connected" result only when the reconciler reports the deadline expired', async () => {
    const state = appDouble();
    state.claim(remoteDispatching(), 'unchanged');
    state.settle(
      task(TaskStatus.STOPPING, {
        ...remoteDispatching(),
        sdk_failure: { termination: 'unverified' },
      }),
      'unverified'
    );

    const result = await requestExecutorTermination({
      app: state.app,
      taskId,
      cause: 'user_stop',
      errorMessage: 'Stopped by user',
      remoteConnectDeadlineExpired: true,
      runInFreshTenantWriteDatabase,
    });

    expect(result).toMatchObject({
      status: 'unverified',
      reason: expect.stringContaining('never connected before the startup deadline'),
    });
    expect((result as { reason: string }).reason).not.toContain('within');
    expect(state.settleTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'unverified',
        errorMessage: expect.stringContaining('could not confirm that the previous work stopped'),
      }),
      expect.anything()
    );
    expect(containExecutorProcess).not.toHaveBeenCalled();
  });

  it('reports the measured wait, not the configured grace, for a connected executor', async () => {
    // Each durable read takes longer than the whole grace, so the real wait is
    // several times the configured 120ms; reporting the grace would fail.
    const state = appDouble('codex', { getDelayMs: 250 });
    const remoteStopping = {
      ...stopping('user_stop'),
      executor_mode: 'templated' as const,
      executor_connected_at: '2026-01-01T00:00:00.000Z',
    };
    state.claim(remoteStopping);
    state.settle(
      task(TaskStatus.STOPPING, { ...remoteStopping, sdk_failure: { termination: 'unverified' } }),
      'unverified'
    );

    const result = await requestExecutorTermination({
      app: state.app,
      taskId,
      cause: 'user_stop',
      errorMessage: 'Stopped by user',
      cooperativeGraceMs: 120,
      runInFreshTenantWriteDatabase,
    });

    const reason = (result as { reason: string }).reason;
    const waited = Number(/within (\d+)ms/.exec(reason)?.[1]);
    expect(result.status).toBe('unverified');
    expect(waited).toBeGreaterThanOrEqual(240);
    expect(waited).toBeLessThan(5_000);
  });

  it('does not report pending when absence is already verified', async () => {
    const state = appDouble();
    state.claim(remoteDispatching());
    state.settle(task(TaskStatus.STOPPED));

    await expect(
      requestExecutorTermination({
        app: state.app,
        taskId,
        cause: 'user_stop',
        errorMessage: 'Stopped by user',
        absenceVerified: true,
        runInFreshTenantWriteDatabase,
      })
    ).resolves.toMatchObject({ status: 'terminal', task: { status: TaskStatus.STOPPED } });
    expect(state.claimTerminationCoordination).toHaveBeenCalledOnce();
  });

  // A Stop that lands before the launcher's refusal keeps its `user_stop`
  // request; the refusal still proves nothing was created.
  it.each(['codex', 'opencode'])(
    'settles a %s Stop that preceded a refused launch as verified and stopped',
    async (tool) => {
      const state = appDouble(tool);
      state.claim(remoteDispatching(), 'unchanged');
      state.settle(
        task(TaskStatus.STOPPED, { termination_request: remoteDispatching().termination_request })
      );

      await expect(
        requestExecutorTermination({
          app: state.app,
          taskId,
          cause: 'launch_refused',
          errorMessage: EXECUTOR_LAUNCH_REFUSED_MESSAGE,
          absenceVerified: true,
          requireExecutorDisconnected: true,
          runInFreshTenantWriteDatabase,
        })
      ).resolves.toMatchObject({ status: 'terminal', task: { status: TaskStatus.STOPPED } });
      expect(state.claimTermination).toHaveBeenCalledWith(
        expect.not.objectContaining({ expectedStatus: expect.anything() }),
        expect.anything()
      );
      expect(state.settleTermination).toHaveBeenCalledOnce();
      expect(state.settleTermination).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'verified_absent' }),
        expect.anything()
      );
      expect(containExecutorProcess).not.toHaveBeenCalled();
    }
  );

  // The reconciler resumes a committed refusal after a daemon restart with the
  // persisted cause and the absence proof that cause carries.
  it.each(['codex', 'opencode'])(
    'settles a recovered %s refused launch as verified',
    async (tool) => {
      const state = appDouble(tool);
      const refused = {
        ...remoteDispatching(),
        termination_request: {
          cause: 'launch_refused',
          requested_at: '2026-01-01T00:00:01.000Z',
          error_message: EXECUTOR_LAUNCH_REFUSED_MESSAGE,
        },
      };
      state.claim(refused, 'unchanged');
      state.settle(task(TaskStatus.FAILED, { termination_request: refused.termination_request }));

      await expect(
        requestExecutorTermination({
          app: state.app,
          taskId,
          cause: 'launch_refused',
          errorMessage: EXECUTOR_LAUNCH_REFUSED_MESSAGE,
          absenceVerified: true,
          remoteConnectDeadlineExpired: true,
          runInFreshTenantWriteDatabase,
        })
      ).resolves.toMatchObject({ status: 'terminal', task: { status: TaskStatus.FAILED } });
      expect(state.settleTermination).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'verified_absent' }),
        expect.anything()
      );
    }
  );

  it('keeps a repeated beginExecutorTermination pending without claiming coordination', async () => {
    const state = appDouble();
    state.claim(remoteDispatching(), 'unchanged');

    await expect(
      beginExecutorTermination({
        app: state.app,
        taskId,
        cause: 'user_stop',
        errorMessage: 'Stopped by user',
        runInFreshTenantWriteDatabase,
      })
    ).resolves.toMatchObject({ status: TaskStatus.STOPPING });
    expect(state.claimTerminationCoordination).not.toHaveBeenCalled();
    expect(state.settleTermination).not.toHaveBeenCalled();
  });
});

describe('remote cleanup integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCleanup.mockResolvedValue({ confirmed: true, diagnostic: 'exit 0' });
  });
  const config = {
    execution: {
      executor_cleanup_command_template: 'trusted-cleanup',
      executor_cleanup_timeout_ms: 20000,
    },
  };
  async function execute(state: ReturnType<typeof appDouble>, tenant = 'tenant-a') {
    return runWithTenantContext(tenant, () =>
      requestExecutorTermination({
        app: state.app,
        taskId,
        cause: 'heartbeat_lost',
        errorMessage: 'Lost contact',
        cooperativeGraceMs: 0,
        runInFreshTenantWriteDatabase,
      })
    );
  }
  it('uses exact trusted context, waits for confirmation, then settles', async () => {
    const state = appDouble('codex', { config });
    state.claim({
      ...stopping('heartbeat_lost'),
      executor_mode: 'templated' as const,
      executor_connected_at: '2026-01-01T00:00:00Z',
    });
    state.settle(task(TaskStatus.FAILED));
    expect((await execute(state)).status).toBe('terminal');
    expect(runCleanup).toHaveBeenCalledWith(
      'trusted-cleanup',
      expect.objectContaining({
        tenant_id: 'tenant-a',
        task_id: taskId,
        session_id: sessionId,
        branch_id: 'branch-a',
        attempt_id: 'attempt-a',
      }),
      20000
    );
    expect(state.beginCleanupAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      runCleanup.mock.invocationCallOrder[0]
    );
    expect(state.settleTermination).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'verified_absent' }),
      expect.anything()
    );
    expect(containExecutorProcess).not.toHaveBeenCalled();
  });
  it('persists a failed attempt without claiming termination', async () => {
    runCleanup.mockResolvedValue({ confirmed: false, diagnostic: 'Cleanup timed out.' });
    const state = appDouble('codex', { config });
    state.claim({
      ...stopping('heartbeat_lost'),
      executor_mode: 'templated' as const,
      executor_connected_at: '2026-01-01T00:00:00Z',
    });
    state.settle(task(TaskStatus.STOPPING), 'unverified');
    expect((await execute(state)).status).toBe('unverified');
    expect(state.settleTermination).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'unverified' }),
      expect.anything()
    );
  });
  it('settles a quiescence report arriving during the helper without repeating cleanup', async () => {
    const state = appDouble('codex', { config });
    state.claim({
      ...stopping('heartbeat_lost'),
      executor_mode: 'templated',
      executor_connected_at: '2026-01-01T00:00:00Z',
    });
    runCleanup.mockImplementationOnce(async () => {
      state.markExecutorQuiesced();
      return { confirmed: false, diagnostic: 'Cleanup timed out.' };
    });
    state.settleTermination.mockImplementationOnce(async (input) => {
      expect(input).toMatchObject({ outcome: 'unverified', expectedExecutorQuiescedAt: null });
      // Model the repository's row-locked evidence fence.
      return { outcome: 'condition_changed', task: await state.getCurrent() };
    });
    state.settle(task(TaskStatus.FAILED));
    expect((await execute(state)).status).toBe('terminal');
    expect(runCleanup).toHaveBeenCalledOnce();
    expect(state.settleTermination).toHaveBeenCalledTimes(2);
    expect(state.settleTermination).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'verified_absent' }),
      expect.anything()
    );
  });
  it('accepts helper containment for hosted OpenCode without a cooperative acknowledgement', async () => {
    const state = appDouble('opencode', {
      config: {
        ...config,
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        execution: {
          ...config.execution,
          unix_user_mode: 'delegated',
          executor_command_template: 'launch {task_id}',
          executor_storage: { user_home: 'persistent-per-user' },
        },
      },
    });
    state.claim({
      ...stopping('heartbeat_lost'),
      executor_mode: 'templated',
      executor_connected_at: '2026-01-01T00:00:00Z',
    });
    state.settle(task(TaskStatus.FAILED));
    runCleanup.mockResolvedValueOnce({ confirmed: true });
    expect((await execute(state)).status).toBe('terminal');
    expect(runCleanup).toHaveBeenCalledOnce();
    expect(state.settleTermination).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'verified_absent' }),
      expect.anything()
    );
  });

  it('does not re-invoke an attempt whose daemon disappeared', async () => {
    const state = appDouble('codex', { config });
    state.claim({
      ...stopping('heartbeat_lost'),
      executor_mode: 'templated' as const,
      executor_connected_at: '2026-01-01T00:00:00Z',
      termination_request: {
        ...stopping('heartbeat_lost').termination_request!,
        cleanup_attempt: { attempt_id: 'previous', started_at: '2026-01-01T00:00:00Z' },
      },
    });
    state.settle(task(TaskStatus.STOPPING), 'unverified');
    expect((await execute(state)).status).toBe('unverified');
    expect(runCleanup).not.toHaveBeenCalled();
  });
  it('does not send a shared supervisor an unscoped execution', async () => {
    const state = appDouble('codex', { config });
    state.claim({
      ...stopping('heartbeat_lost'),
      executor_mode: 'templated' as const,
      executor_connected_at: '2026-01-01T00:00:00Z',
    });
    state.settle(task(TaskStatus.STOPPING), 'unverified');
    await requestExecutorTermination({
      app: state.app,
      taskId,
      cause: 'heartbeat_lost',
      errorMessage: 'Lost',
      cooperativeGraceMs: 0,
      runInFreshTenantWriteDatabase,
    });
    expect(runCleanup).not.toHaveBeenCalled();
  });
  it('keeps local containment when a cleanup command is configured', async () => {
    containExecutorProcess.mockResolvedValue({ status: 'verified_absent' });
    getTrackedExecutor.mockReturnValue({ pid: 123 });
    const state = appDouble('codex', { config });
    state.claim(stopping('heartbeat_lost'));
    state.settle(task(TaskStatus.FAILED));
    await execute(state);
    expect(runCleanup).not.toHaveBeenCalled();
    expect(containExecutorProcess).toHaveBeenCalled();
  });
});
