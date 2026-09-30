import { TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkpoints = vi.hoisted(() => ({
  begin: vi.fn(),
  acknowledgeCleanup: vi.fn(),
}));
vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  OpenCodeCheckpointRepository: class {
    begin = checkpoints.begin;
    acknowledgeCleanup = checkpoints.acknowledgeCleanup;
  },
}));

import { TasksService } from './tasks.js';

const taskId = '018f0000-0000-7000-8000-000000000001';
const sessionId = '018f0000-0000-7000-8000-000000000002';
const ownerId = '018f0000-0000-7000-8000-000000000003';
const holderId = '018f0000-0000-7000-8000-000000000005';
const hosted = {
  multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
  execution: {
    unix_user_mode: 'delegated',
    executor_command_template: 'launch {task_id}',
    executor_storage: { user_home: 'persistent-per-user' },
  },
  agentic_tools: { opencode_hosted_native_state: 'checkpointed' },
};

function runtimeParams(scopedTaskId = taskId) {
  const payload = {
    type: 'executor-session',
    purpose: 'executor-task',
    sub: ownerId,
    tenant_id: 'tenant-a',
    session_id: sessionId,
    task_id: scopedTaskId,
    branch_id: '018f0000-0000-7000-8000-000000000004',
  };
  return {
    provider: 'rest',
    tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
    authentication: { strategy: 'jwt', accessToken: 'verified-token', payload },
  } as never;
}

function harness(config: unknown = hosted) {
  const service = Object.create(TasksService.prototype) as TasksService;
  const taskRepo = {
    assertRuntimeCredentialAuthority: vi.fn(async () => undefined),
    updateFromExecutor: vi.fn(async (_id: string, data: object) => ({ task_id: taskId, ...data })),
  };
  Reflect.set(service, 'taskRepo', taskRepo);
  Reflect.set(service, 'db', { run() {} });
  Reflect.set(service, 'executorCredentialRevoker', {
    isTaskTokenAuthorityCurrent: vi.fn(async () => true),
  });
  Reflect.set(service, 'app', { get: () => config, service: () => ({ emit: vi.fn() }) });
  Reflect.set(
    service,
    'get',
    vi.fn(async () => ({ task_id: taskId, status: TaskStatus.RUNNING }))
  );
  return { service, taskRepo };
}

beforeEach(() => {
  vi.clearAllMocks();
  checkpoints.begin.mockResolvedValue({ outcome: 'admitted', input: null, cleanup: [] });
});

describe('TasksService hosted OpenCode checkpoints', () => {
  it('admits the live task executor as the token principal', async () => {
    const { service, taskRepo } = harness();

    await expect(
      service.beginOpenCodeCheckpoint(
        { task_id: taskId, holder_instance_id: holderId },
        runtimeParams()
      )
    ).resolves.toEqual({ outcome: 'admitted', input: null, cleanup: [] });

    expect(taskRepo.assertRuntimeCredentialAuthority).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ principal_user_id: ownerId, standalone_token_current: true })
    );
    expect(checkpoints.begin).toHaveBeenCalledWith(taskId, holderId, ownerId);
  });

  it('refuses another task token, a malformed holder, or a deployment without hosted mode', async () => {
    await expect(
      harness().service.beginOpenCodeCheckpoint(
        { task_id: taskId, holder_instance_id: holderId },
        runtimeParams('018f0000-0000-7000-8000-0000000000ff')
      )
    ).rejects.toThrow(/scoped to this executor task/);
    await expect(
      harness().service.beginOpenCodeCheckpoint(
        { task_id: taskId, holder_instance_id: 'not-a-uuid' },
        runtimeParams()
      )
    ).rejects.toThrow(/holder_instance_id/);
    await expect(
      harness({}).service.acknowledgeOpenCodeCleanup(
        { task_id: taskId, holder_instance_id: holderId, deleted: [] },
        runtimeParams()
      )
    ).rejects.toThrow(/not enabled/);
    const object = { sessionId, taskId };
    for (const deleted of [Array(21).fill(object), [{ sessionId: '../x', taskId }]]) {
      await expect(
        harness().service.acknowledgeOpenCodeCleanup(
          { task_id: taskId, holder_instance_id: holderId, deleted },
          runtimeParams()
        )
      ).rejects.toThrow(/canonical checkpoint objects/);
    }
    expect(checkpoints.begin).not.toHaveBeenCalled();
    expect(checkpoints.acknowledgeCleanup).not.toHaveBeenCalled();
  });

  it('accepts a checkpoint only from the executor, together with its completion patch', async () => {
    const { service, taskRepo } = harness();
    const checkpoint = { holder_instance_id: holderId, manifest: { version: 1 } as never };

    await expect(
      service.patch(taskId, { status: TaskStatus.COMPLETED, opencode_checkpoint: checkpoint }, {
        provider: undefined,
      } as never)
    ).rejects.toThrow(/only from the task executor/);

    Reflect.set(
      service,
      'processCompletionSideEffects',
      vi.fn(async () => undefined)
    );
    Reflect.set(
      service,
      'retireTaskExecutorCredentials',
      vi.fn(async () => undefined)
    );
    Reflect.set(service, 'trackTaskCompleted', vi.fn());
    await service.patch(
      taskId,
      { status: TaskStatus.COMPLETED, opencode_checkpoint: checkpoint },
      runtimeParams()
    );
    expect(taskRepo.updateFromExecutor).toHaveBeenCalledWith(
      taskId,
      { status: TaskStatus.COMPLETED },
      { holderId, manifest: checkpoint.manifest }
    );
  });
});
