import { EventEmitter } from 'node:events';
import { ENVIRONMENT_LIFECYCLE_SUPERSEDED_CODE } from '@agor/core/environment/lifecycle-result';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EnvironmentLifecyclePayload,
  EnvironmentLifecyclePayloadSchema,
  type EnvironmentLogsPayload,
} from '../payload-types';

const mocks = vi.hoisted(() => ({
  createExecutorClient: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: mocks.createExecutorClient,
}));

import { handleEnvironmentLifecycle, handleEnvironmentLogs } from './environment';

const branchId = '550e8400-e29b-41d4-a716-446655440000';
const revision = 'a'.repeat(40);

function payload(
  action: EnvironmentLifecyclePayload['params']['action'],
  lifecycleGeneration = 1
): EnvironmentLifecyclePayload {
  return {
    command: 'environment.lifecycle',
    sessionToken: 'executor-token',
    params: {
      branchId,
      branchPath: '/tmp/branch',
      action,
      startCommand: 'echo start',
      stopCommand: 'echo stop',
      nukeCommand: 'echo nuke',
      syncCommand: 'echo sync',
      desiredRevision: revision,
      syncClaimToken: 'claim-a',
      startupTimeoutMs: 120_000,
      commandTimeoutMs: 90_000,
      lifecycleGeneration,
    },
  };
}

function successfulChild(stdout = '') {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 1234;
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });
  return child;
}

function client(options: {
  generation: number;
  updateEnvironment: ReturnType<typeof vi.fn>;
  environmentInstance?: Record<string, unknown>;
}) {
  const branch = {
    branch_id: branchId,
    path: '/tmp/branch',
    environment_generation: options.generation,
    environment_instance: options.environmentInstance ?? { status: 'starting' },
  };
  const service = {
    get: vi.fn(async () => branch),
    updateEnvironment: options.updateEnvironment,
  };
  mocks.createExecutorClient.mockResolvedValue({
    service: vi.fn(() => service),
  });
  return service;
}

function supersededConflict() {
  return {
    message: 'Environment lifecycle was superseded',
    data: { code: ENVIRONMENT_LIFECYCLE_SUPERSEDED_CODE },
  };
}

function mockProcessGroup() {
  let alive = true;
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0 && !alive) {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    }
    return true;
  });
  return {
    kill,
    markExited: () => {
      alive = false;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spawn.mockImplementation(() => successfulChild());
});

describe('environment logs deadline', () => {
  it('bounds the command and terminates its process group', async () => {
    vi.useFakeTimers();
    const processGroup = mockProcessGroup();
    const { kill } = processGroup;
    try {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 4321;
      child.kill = vi.fn();
      mocks.spawn.mockReturnValue(child);
      client({ generation: 1, updateEnvironment: vi.fn() });
      const logsPayload: EnvironmentLogsPayload = {
        command: 'environment.logs',
        sessionToken: 'executor-token',
        params: {
          branchId,
          branchPath: '/tmp/branch',
          logsCommand: 'tail -n 100 dev.log',
          commandTimeoutMs: 30_000,
        },
      };

      const result = handleEnvironmentLogs(logsPayload, {});
      await vi.advanceTimersByTimeAsync(30_000);
      expect(kill).toHaveBeenCalledWith(-4321, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL');
      processGroup.markExited();
      child.emit('close', null);

      await expect(result).resolves.toMatchObject({
        success: false,
        error: {
          code: 'ENVIRONMENT_LOGS_FAILED',
          message: 'logs command exceeded its 30000ms deadline',
        },
      });
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('environment lifecycle generation fencing', () => {
  it('does not execute a command whose lifecycle was superseded before spawn', async () => {
    const updateEnvironment = vi.fn();
    client({ generation: 2, updateEnvironment });

    await expect(handleEnvironmentLifecycle(payload('start', 1), {})).resolves.toMatchObject({
      success: true,
      data: { superseded: true },
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(updateEnvironment).not.toHaveBeenCalled();
  });

  it('suppresses a late start result after a newer lifecycle wins', async () => {
    mocks.spawn.mockImplementation(() =>
      successfulChild(
        `AGOR_ENVIRONMENT_RESULT=${JSON.stringify({
          version: 1,
          access_urls: [{ name: 'App', url: 'https://app.example.test' }],
        })}\n`
      )
    );
    const updateEnvironment = vi
      .fn()
      .mockResolvedValueOnce({ environment_generation: 1 })
      .mockRejectedValueOnce(supersededConflict());
    client({ generation: 1, updateEnvironment });

    await expect(handleEnvironmentLifecycle(payload('start'), {})).resolves.toMatchObject({
      success: true,
      data: { superseded: true },
    });
    expect(updateEnvironment).toHaveBeenCalledTimes(2);
    expect(updateEnvironment.mock.calls[1]?.[0]).toMatchObject({
      expected_environment_generation: 1,
      environment_update: {
        lifecycle_result: {
          access_urls: [{ name: 'App', url: 'https://app.example.test/' }],
        },
      },
    });
  });

  it('has no single-process restart verb that spans a stop and a start', () => {
    // Restart is a daemon-owned sequence of a bounded Stop and a separately
    // credentialed Start. One executor process doing both would need one
    // credential covering both phases and could not be fenced on the Stop's
    // settled generation.
    expect(() =>
      EnvironmentLifecyclePayloadSchema.parse({
        ...payload('stop'),
        params: { ...payload('stop').params, action: 'restart' },
      })
    ).toThrow();
  });

  it('preserves the daemon-owned deadline for a normal start', async () => {
    const persistedDeadline = '2030-01-01T00:00:00.000Z';
    const updateEnvironment = vi
      .fn()
      .mockResolvedValueOnce({ environment_generation: 1 })
      .mockResolvedValueOnce({ environment_generation: 1 });
    client({
      generation: 1,
      updateEnvironment,
      environmentInstance: {
        status: 'starting',
        startup_deadline_at: persistedDeadline,
      },
    });

    await expect(handleEnvironmentLifecycle(payload('start'), {})).resolves.toMatchObject({
      success: true,
      data: { action: 'start' },
    });
    expect(updateEnvironment.mock.calls[0]?.[0]).toMatchObject({
      expected_environment_generation: 1,
      environment_update: { startup_deadline_at: persistedDeadline },
    });
    expect(updateEnvironment.mock.calls[1]?.[0]).toMatchObject({
      expected_environment_generation: 1,
    });
    for (const call of updateEnvironment.mock.calls) {
      expect(call[0]).toMatchObject({ expected_environment_status: 'starting' });
    }
  });

  it('terminates a Start command when its persisted startup deadline expires', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 1234;
    child.kill = vi.fn();
    mocks.spawn.mockReturnValue(child);
    const processGroup = mockProcessGroup();
    const { kill: processKill } = processGroup;
    const updateEnvironment = vi
      .fn()
      .mockResolvedValueOnce({ environment_generation: 1 })
      .mockResolvedValueOnce({ environment_generation: 2 });
    client({
      generation: 1,
      updateEnvironment,
      environmentInstance: {
        status: 'starting',
        startup_deadline_at: new Date(Date.now() + 20).toISOString(),
      },
    });
    const expiringPayload = payload('start');

    try {
      const result = handleEnvironmentLifecycle(expiringPayload, {});
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(processKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
      processGroup.markExited();
      child.emit('close', null);
      await expect(result).resolves.toMatchObject({
        success: false,
        error: {
          code: 'ENVIRONMENT_COMMAND_FAILED',
          message: expect.stringMatching(/exceeded.*deadline/i),
        },
      });
      expect(mocks.spawn).toHaveBeenCalledWith(
        expiringPayload.params.startCommand,
        expect.objectContaining({ detached: process.platform !== 'win32' })
      );
      expect(updateEnvironment.mock.calls[1]?.[0]).toMatchObject({
        expected_environment_generation: 1,
        environment_update: { status: 'error' },
      });
    } finally {
      child.emit('close', null);
      processKill.mockRestore();
    }
  });

  it.each(['stop', 'nuke', 'sync'] as const)(
    'terminates a %s command at the daemon-owned lifecycle deadline',
    async (action) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 4321;
      child.kill = vi.fn();
      mocks.spawn.mockReturnValue(child);
      const processGroup = mockProcessGroup();
      const { kill: processKill } = processGroup;
      const updateEnvironment = vi.fn().mockResolvedValue({ environment_generation: 1 });
      client({
        generation: 1,
        updateEnvironment,
        environmentInstance: { status: action === 'sync' ? 'running' : 'stopping' },
      });
      const expiringPayload = payload(action);
      expiringPayload.params.commandTimeoutMs = 20;

      try {
        const result = handleEnvironmentLifecycle(expiringPayload, {});
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(processKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
        processGroup.markExited();
        child.emit('close', null);
        await expect(result).resolves.toMatchObject({
          success: false,
          error: {
            code: 'ENVIRONMENT_COMMAND_FAILED',
            message: expect.stringMatching(/exceeded.*deadline/i),
          },
        });
        expect(mocks.spawn).toHaveBeenCalledWith(
          action === 'stop'
            ? expiringPayload.params.stopCommand
            : action === 'nuke'
              ? expiringPayload.params.nukeCommand
              : expiringPayload.params.syncCommand,
          expect.objectContaining({ detached: process.platform !== 'win32' })
        );
      } finally {
        child.emit('close', null);
        processKill.mockRestore();
      }
    }
  );

  it('does not settle a timed-out command until TERM escalates to KILL and the group exits', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 5678;
    child.kill = vi.fn();
    mocks.spawn.mockReturnValue(child);
    const processGroup = mockProcessGroup();
    const { kill: processKill } = processGroup;
    const updateEnvironment = vi.fn().mockResolvedValue({ environment_generation: 1 });
    client({
      generation: 1,
      updateEnvironment,
      environmentInstance: { status: 'stopping' },
    });
    const expiringPayload = payload('stop');
    expiringPayload.params.commandTimeoutMs = 20;

    try {
      const result = handleEnvironmentLifecycle(expiringPayload, {});
      await vi.advanceTimersByTimeAsync(20);
      expect(processKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
      expect(updateEnvironment).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(processKill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
      expect(updateEnvironment).not.toHaveBeenCalled();

      processGroup.markExited();
      child.emit('close', null);
      await expect(result).resolves.toMatchObject({
        success: false,
        error: { code: 'ENVIRONMENT_COMMAND_FAILED' },
      });
      expect(updateEnvironment).toHaveBeenCalledTimes(1);
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not spawn Start after its mutation-owning status was superseded', async () => {
    const updateEnvironment = vi.fn(async () => {
      throw supersededConflict();
    });
    client({
      generation: 1,
      updateEnvironment,
      environmentInstance: {
        status: 'starting',
        startup_deadline_at: '2030-01-01T00:00:00.000Z',
      },
    });

    await expect(handleEnvironmentLifecycle(payload('start'), {})).resolves.toMatchObject({
      success: true,
      data: { action: 'start', superseded: true },
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(updateEnvironment.mock.calls[0]?.[0]).toMatchObject({
      expected_environment_generation: 1,
      expected_environment_status: 'starting',
    });
  });

  it('reports the generation its own settlement produced, not the dispatched one', async () => {
    // Stop changes the branch status, which advances the lifecycle boundary.
    // Restart sequences its Start phase from THIS number, so returning the
    // dispatched generation would make the second phase unreachable.
    const updateEnvironment = vi.fn().mockResolvedValue({ environment_generation: 2 });
    client({ generation: 1, updateEnvironment, environmentInstance: { status: 'stopping' } });

    await expect(handleEnvironmentLifecycle(payload('stop'), {})).resolves.toMatchObject({
      success: true,
      data: { action: 'stop', lifecycleGeneration: 2 },
    });
    expect(updateEnvironment.mock.calls[0]?.[0]).toMatchObject({
      expected_environment_generation: 1,
      expected_environment_status: 'stopping',
    });
  });

  it('settles a failure with one fenced write instead of re-reading the branch', async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 4321;
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });
    const updateEnvironment = vi.fn().mockResolvedValue({ environment_generation: 2 });
    const service = client({
      generation: 1,
      updateEnvironment,
      environmentInstance: { status: 'stopping' },
    });

    await expect(handleEnvironmentLifecycle(payload('stop'), {})).resolves.toMatchObject({
      success: false,
      error: { code: 'ENVIRONMENT_COMMAND_FAILED' },
    });
    // Exactly the one pre-command generation check. A second read here spends
    // another acknowledgement budget the command may no longer be authorized
    // for, and the CAS below already rejects a stale failure.
    expect(service.get).toHaveBeenCalledTimes(1);
    expect(updateEnvironment).toHaveBeenCalledTimes(1);
    expect(updateEnvironment.mock.calls[0]?.[0]).toMatchObject({
      expected_environment_generation: 1,
      environment_update: { status: 'error' },
    });
    expect(updateEnvironment.mock.calls[0]?.[0]).not.toHaveProperty('expected_environment_status');
  });

  it('does not record a failure a newer lifecycle already superseded', async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 4321;
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });
    const updateEnvironment = vi
      .fn()
      // The `starting` claim still owns the boundary...
      .mockResolvedValueOnce({ environment_generation: 1 })
      // ...but a competing action wins before this command can record failure.
      .mockRejectedValueOnce(supersededConflict());
    client({ generation: 1, updateEnvironment, environmentInstance: { status: 'starting' } });

    await expect(handleEnvironmentLifecycle(payload('start'), {})).resolves.toMatchObject({
      success: true,
      data: { superseded: true },
    });
    expect(updateEnvironment).toHaveBeenCalledTimes(2);
  });
});

describe('environment source sync acknowledgement', () => {
  it('returns an exact typed acknowledgement without patching environment health', async () => {
    mocks.spawn.mockImplementation(() =>
      successfulChild(
        `AGOR_ENVIRONMENT_RESULT=${JSON.stringify({ version: 1, applied_revision: revision })}\n`
      )
    );
    const updateEnvironment = vi.fn();
    client({ generation: 1, updateEnvironment, environmentInstance: { status: 'running' } });

    await expect(handleEnvironmentLifecycle(payload('sync'), {})).resolves.toEqual({
      success: true,
      data: {
        branchId,
        action: 'sync',
        claimToken: 'claim-a',
        appliedRevision: revision,
      },
    });
    expect(updateEnvironment).not.toHaveBeenCalled();
  });

  it('fails closed when the command does not acknowledge the requested commit', async () => {
    const updateEnvironment = vi.fn();
    client({ generation: 1, updateEnvironment, environmentInstance: { status: 'running' } });

    await expect(handleEnvironmentLifecycle(payload('sync'), {})).resolves.toMatchObject({
      success: false,
      error: { code: 'ENVIRONMENT_COMMAND_FAILED' },
    });
    expect(updateEnvironment).not.toHaveBeenCalled();
  });
});
