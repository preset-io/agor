import { EventEmitter } from 'node:events';
import { ENVIRONMENT_LIFECYCLE_SUPERSEDED_CODE } from '@agor/core/environment/lifecycle-result';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentLifecyclePayload } from '../payload-types';

const mocks = vi.hoisted(() => ({
  createExecutorClient: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: mocks.createExecutorClient,
}));

import { handleEnvironmentLifecycle } from './environment';

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spawn.mockImplementation(() => successfulChild());
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
      expected_environment_status: 'starting',
      environment_update: {
        access_urls: [{ name: 'App', url: 'https://app.example.test/' }],
      },
    });
  });

  it('carries the new generation across the internal stop-to-start restart transition', async () => {
    const updateEnvironment = vi
      .fn()
      .mockResolvedValueOnce({ environment_generation: 1 })
      .mockResolvedValueOnce({ environment_generation: 2 })
      .mockResolvedValueOnce({ environment_generation: 2 });
    client({ generation: 1, updateEnvironment });

    await expect(handleEnvironmentLifecycle(payload('restart'), {})).resolves.toMatchObject({
      success: true,
      data: { action: 'restart' },
    });
    expect(
      updateEnvironment.mock.calls.map((call) => call[0].expected_environment_generation)
    ).toEqual([1, 1, 2]);
    expect(updateEnvironment.mock.calls.map((call) => call[0].expected_environment_status)).toEqual(
      ['stopping', 'stopping', 'starting']
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    const restartStart = updateEnvironment.mock.calls[1]?.[0].environment_update as {
      startup_deadline_at?: string;
    };
    const deadlineAt = Date.parse(restartStart.startup_deadline_at ?? '');
    expect(deadlineAt).toBeGreaterThan(Date.now() + 119_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 120_000);
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
      expected_environment_status: 'starting',
      environment_update: { startup_deadline_at: persistedDeadline },
    });
    expect(updateEnvironment.mock.calls[1]?.[0]).toMatchObject({
      expected_environment_status: 'starting',
    });
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
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
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
      await expect(handleEnvironmentLifecycle(expiringPayload, {})).resolves.toMatchObject({
        success: false,
        error: {
          code: 'ENVIRONMENT_COMMAND_FAILED',
          message: expect.stringMatching(/exceeded.*deadline/i),
        },
      });
      expect(processKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
      expect(mocks.spawn).toHaveBeenCalledWith(
        expiringPayload.params.startCommand,
        expect.objectContaining({ detached: process.platform !== 'win32' })
      );
      expect(updateEnvironment.mock.calls[1]?.[0]).toMatchObject({
        expected_environment_generation: 1,
        expected_environment_status: 'starting',
        environment_update: { status: 'error' },
      });
    } finally {
      child.emit('close', null);
      processKill.mockRestore();
    }
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
