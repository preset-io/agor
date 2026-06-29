import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentLifecyclePayload } from '../payload-types.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { handleEnvironmentLifecycle } from './environment.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        pid: number;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 1234;
      setImmediate(() => child.emit('exit', 0));
      return child;
    }),
  };
});

vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: vi.fn(),
}));

const mockedCreateExecutorClient = vi.mocked(createExecutorClient);

describe('handleEnvironmentLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('honors stop requests that arrive while a start command is still running', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const branchesService = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          branch_id: '550e8400-e29b-41d4-a716-446655440000',
          path: '/tmp/agor-env-test',
          environment_instance: { status: 'starting' },
        })
        .mockResolvedValueOnce({
          branch_id: '550e8400-e29b-41d4-a716-446655440000',
          path: '/tmp/agor-env-test',
          environment_instance: { status: 'stopping' },
        }),
      updateEnvironment: vi.fn(
        async (envelope: { environment_update: Record<string, unknown> }) => {
          updates.push(envelope.environment_update);
        }
      ),
    };
    mockedCreateExecutorClient.mockResolvedValue({
      service: vi.fn((name: string) => {
        if (name !== 'branches') throw new Error(`Unexpected service ${name}`);
        return branchesService;
      }),
    } as never);

    const payload: EnvironmentLifecyclePayload = {
      command: 'environment.lifecycle',
      sessionToken: 'token',
      daemonUrl: 'http://daemon.test',
      params: {
        branchId: '550e8400-e29b-41d4-a716-446655440000',
        branchPath: '/tmp/agor-env-test',
        action: 'start',
        startCommand: 'echo start',
        stopCommand: 'echo stop',
      },
    };

    const result = await handleEnvironmentLifecycle(payload, {});

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ cancelled: true });
    expect(updates.at(-1)).toMatchObject({
      status: 'stopped',
      process: null,
      last_command: expect.objectContaining({
        action: 'stop',
        status: 'succeeded',
      }),
    });
  });
});
