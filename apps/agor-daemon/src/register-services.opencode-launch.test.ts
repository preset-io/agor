import type { ChildProcess } from 'node:child_process';
import { runWithTenantContext } from '@agor/core/db';
import type { Session } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecuteHandler, type RegisterServicesContext } from './register-services.js';
import type { SpawnExecutorOptions } from './utils/spawn-executor.js';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  spawn: vi.fn(),
  slot: vi.fn(async () => {
    throw new Error('local containment slot');
  }),
}));
vi.mock('./services/executor-startup.js', () => ({
  prepareSessionForExecutorStart: mocks.prepare,
}));
vi.mock('./utils/spawn-executor.js', async (original) => ({
  ...(await original<typeof import('./utils/spawn-executor.js')>()),
  spawnExecutor: mocks.spawn,
}));
vi.mock('./integrations/opencode/native-state-coordinator.js', async (original) => ({
  ...(await original<typeof import('./integrations/opencode/native-state-coordinator.js')>()),
  inOpenCodeNativeStateMutationSlot: mocks.slot,
}));
vi.mock('@agor/core/config', async (original) => ({
  ...(await original<typeof import('@agor/core/config')>()),
  createUserProcessEnvironment: vi.fn(async () => ({})),
}));
vi.mock('@agor/core/db', async (original) => ({
  ...(await original<typeof import('@agor/core/db')>()),
  runWithTenantDatabaseScope: async (
    _db: unknown,
    _tenant: string,
    work: (db: unknown) => unknown
  ) => work({}),
  getMCPEgressGatewayMode: async () => 'off',
  BranchRepository: class {
    async findById() {
      return { path: '/synthetic/branch', storage_mode: 'clone' };
    }
  },
}));

const session = {
  session_id: '01a08d5f-775f-73f6-86a1-624b43050180',
  branch_id: '01a08d5f-775f-73f6-86a1-624b43050181',
  created_by: 'owner',
  unix_username: 'opaque-home',
  sdk_home_scope: 'execution_home',
  agentic_tool: 'opencode',
  model_config: { provider: 'anthropic', model: 'synthetic', mode: 'exact' },
} as Session;
const taskA = '01a08d5f-7773-77fa-a7dc-2575cfe6727e';
const taskB = '01a08d5f-7773-77fa-a7dc-2575cfe6727f';
function handler(hosted = true, principal = 'owner', target = session) {
  const ctx = {
    db: {},
    app: { get: () => undefined },
    daemonUrl: 'http://synthetic.invalid',
    deployment: { mode: 'standalone' },
    config: hosted
      ? {
          multi_tenancy: { mode: 'required_from_auth' },
          execution: {
            unix_user_mode: 'delegated',
            executor_command_template: 'fake {task_id}',
            executor_storage: { user_home: 'persistent-per-user' },
          },
          agentic_tools: { opencode_hosted_native_state: 'checkpointed' },
        }
      : {},
  } as unknown as RegisterServicesContext;
  const token = { generateToken: vi.fn(async () => 'synthetic-token') };
  const tasks = {
    bindExecutorLaunchAuthority: vi.fn(async () => ({
      session_id: target.session_id,
      branch_id: target.branch_id,
      principal_user_id: principal,
      fs_access: 'write',
    })),
  };
  return createExecuteHandler(ctx, {} as never, token as never, tasks as never);
}
const execute = (run: ReturnType<typeof handler>, taskId = taskA, sessionId = session.session_id) =>
  runWithTenantContext('tenant-a', () => run(sessionId, { taskId, prompt: 'synthetic' }, {}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue(session);
  mocks.spawn.mockImplementation((_payload: unknown, options: SpawnExecutorOptions) => {
    // Real launch contribution + execute-handler callbacks, fake external launcher.
    // No local pid or remote Job/provider is created.
    options.onSpawn?.({} as ChildProcess, { mode: 'templated' });
  });
});

describe('hosted OpenCode execute-handler composition', () => {
  it('launches repeated templated turns with v2 context and no daemon-local fence', async () => {
    const run = handler();
    await expect(execute(run)).resolves.toMatchObject({ success: true });
    const options = mocks.spawn.mock.calls[0][1] as SpawnExecutorOptions;
    await options.onExit?.(0, { mode: 'templated' });
    await expect(execute(run, taskB)).resolves.toMatchObject({ success: true });
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.spawn.mock.calls[1][0]).toMatchObject({
      agenticToolContext: { version: 2, mode: 'managed-projection', taskId: taskB },
    });
    expect(mocks.slot).not.toHaveBeenCalled();
  });

  it('does not serialize different hosted sessions behind one user namespace', async () => {
    const other = {
      ...session,
      session_id: '01a08d5f-775f-73f6-86a1-624b43050182' as Session['session_id'],
    };
    mocks.prepare.mockImplementation(async (_db: unknown, _service: unknown, id: string) =>
      id === other.session_id ? other : session
    );
    const run = handler();
    const second = handler(true, 'owner', other);
    // Neither launcher exits: both execute handlers must nevertheless finish admission.
    await expect(
      Promise.all([execute(run), execute(second, taskB, other.session_id)])
    ).resolves.toHaveLength(2);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.slot).not.toHaveBeenCalled();
  });

  it('retains local native-file containment and refuses a foreign prompt actor', async () => {
    await expect(execute(handler(false))).rejects.toThrow('local containment slot');
    expect(mocks.slot).toHaveBeenCalledOnce();
    expect(mocks.spawn).not.toHaveBeenCalled();
    await expect(execute(handler(true, 'another-user'))).rejects.toThrow(
      /Only the OpenCode session owner/
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
