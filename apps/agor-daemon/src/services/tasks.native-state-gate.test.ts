import type { Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../termination-coordinator.js', () => ({
  beginExecutorTermination: vi.fn(),
  requestExecutorTermination: vi.fn(),
}));
vi.mock('../utils/tenant-db-scope.js', () => ({
  deferWithTenantContext: vi.fn(),
  withFreshTenantWrite: vi.fn(),
}));

import { TasksService } from './tasks';

const hostedConfig = {
  multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
  execution: {
    unix_user_mode: 'delegated',
    executor_command_template: 'launch',
    executor_storage: { user_home: 'persistent-per-user' },
  },
  agentic_tools: { opencode_hosted_native_state: 'checkpointed' },
};

const attempt = {
  version: 1 as const,
  attemptTaskId: '018f0000-0000-7000-8000-000000000001',
  digest: `sha256:${'a'.repeat(64)}`,
  bytes: 4096,
  openCodeSessionId: 'ses_1',
  publishedAt: '2026-09-10T22:18:55.000Z',
};

function serviceWith(sessionTool: string, config: unknown) {
  const running = {
    task_id: attempt.attemptTaskId,
    session_id: '018f0000-0000-7000-8000-000000000002',
    status: TaskStatus.RUNNING,
  } as Task;
  const completeWithNativeStatePublication = vi.fn(async () => ({
    ...running,
    status: TaskStatus.COMPLETED,
  }));
  const updateFromExecutor = vi.fn(async () => running);
  const service = Object.create(TasksService.prototype) as TasksService;
  Reflect.set(service, 'taskRepo', { completeWithNativeStatePublication, updateFromExecutor });
  Reflect.set(service, 'app', {
    service: (name: string) => {
      if (name === 'sessions') return { get: vi.fn(async () => ({ agentic_tool: sessionTool })) };
      throw new Error(`unexpected service ${name}`);
    },
    get: (key: string) => (key === 'config' ? config : undefined),
  });
  Reflect.set(service, 'db', {});
  Reflect.set(
    service,
    'get',
    vi.fn(async () => running)
  );
  return { service, completeWithNativeStatePublication, updateFromExecutor };
}

const executorParams = { provider: 'socketio', tenant: { tenant_id: 'tenant-a' } } as never;

describe('TasksService native-state publication gate', () => {
  it('refuses a pointer from a non-OpenCode executor before touching the repository', async () => {
    const { service, completeWithNativeStatePublication, updateFromExecutor } = serviceWith(
      'claude-code',
      hostedConfig
    );
    await expect(
      service.patch(
        attempt.attemptTaskId,
        { status: TaskStatus.COMPLETED, native_state_attempt: attempt },
        executorParams
      )
    ).rejects.toThrow(/accepted only for hosted managed-projection OpenCode sessions/);
    expect(completeWithNativeStatePublication).not.toHaveBeenCalled();
    expect(updateFromExecutor).not.toHaveBeenCalled();
  });

  it('refuses a pointer for an OpenCode session outside managed projection', async () => {
    const { service, completeWithNativeStatePublication } = serviceWith('opencode', {
      execution: { unix_user_mode: 'simple' },
    });
    await expect(
      service.patch(
        attempt.attemptTaskId,
        { status: TaskStatus.COMPLETED, native_state_attempt: attempt },
        executorParams
      )
    ).rejects.toThrow(/managed-projection/);
    expect(completeWithNativeStatePublication).not.toHaveBeenCalled();
  });

  it('admits a pointer only for a managed-projection OpenCode session', async () => {
    const { service } = serviceWith('opencode', hostedConfig);
    const admitted = (
      service as unknown as {
        assertNativeStatePublicationAdmitted(task: Task, params: unknown): Promise<void>;
      }
    ).assertNativeStatePublicationAdmitted(
      { task_id: attempt.attemptTaskId, session_id: 'session-1' } as Task,
      executorParams
    );
    await expect(admitted).resolves.toBeUndefined();
  });
});
