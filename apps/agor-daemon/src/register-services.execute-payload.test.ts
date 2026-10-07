import type { AgorConfig } from '@agor/core/config';
import { runWithTenantContext } from '@agor/core/db';
import type { Session } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: undefined as unknown as Session,
  spawnExecutor: vi.fn(),
}));

vi.mock('./services/executor-startup.js', () => ({
  prepareSessionForExecutorStart: vi.fn(async () => mocks.session),
}));
vi.mock('./utils/spawn-executor.js', async (original) => ({
  ...(await original<typeof import('./utils/spawn-executor.js')>()),
  spawnExecutor: mocks.spawnExecutor,
}));
vi.mock('@agor/core/config', async (original) => ({
  ...(await original<typeof import('@agor/core/config')>()),
  createUserProcessEnvironment: vi.fn(async () => ({})),
}));
vi.mock('@agor/core/db', async (original) => ({
  ...(await original<typeof import('@agor/core/db')>()),
  BranchRepository: class {
    findById = async () => ({ path: '/tmp/branch', storage_mode: 'clone', sdk_home: null });
  },
  getMCPEgressGatewayMode: vi.fn(async () => 'off'),
}));

import { createExecuteHandler, type RegisterServicesContext } from './register-services.js';

const baseSession = {
  session_id: 'session-1',
  branch_id: 'branch-1',
  created_by: 'user-1',
  agentic_tool: 'claude-code',
  sdk_home_scope: 'execution_home',
} as Session;

async function launchPrompt(session: Session) {
  mocks.session = session;
  mocks.spawnExecutor.mockReset();
  const ctx = {
    db: { run: vi.fn() },
    app: { get: () => undefined },
    config: {} as AgorConfig,
    deployment: { mode: 'standalone' },
    daemonUrl: 'http://127.0.0.1',
  } as unknown as RegisterServicesContext;
  const tasksService = {
    bindExecutorLaunchAuthority: vi.fn(async () => ({
      session_id: 'session-1',
      branch_id: 'branch-1',
      principal_user_id: 'user-1',
      fs_access: 'write',
    })),
  };
  const sessionTokenService = { generateToken: vi.fn(async () => 'session-token') };
  const execute = createExecuteHandler(
    ctx,
    {} as never,
    sessionTokenService as never,
    tasksService as never
  );
  await runWithTenantContext('tenant-1', () =>
    execute('session-1', { taskId: 'task-1', prompt: 'hello' }, {})
  );
  expect(mocks.spawnExecutor).toHaveBeenCalledOnce();
  return mocks.spawnExecutor.mock.calls[0][0].params as Record<string, unknown>;
}

describe('execute handler prompt payload', () => {
  it('carries the configured session model verbatim', async () => {
    const params = await launchPrompt({
      ...baseSession,
      model_config: { mode: 'exact', model: 'claude-opus-4-7[1m]' },
    } as Session);

    expect(params.model).toBe('claude-opus-4-7[1m]');
  });

  it('omits model when the session has no configured model', async () => {
    const withoutConfig = await launchPrompt(baseSession);
    const withoutModel = await launchPrompt({
      ...baseSession,
      model_config: { mode: 'alias' },
    } as Session);

    expect('model' in withoutConfig).toBe(false);
    expect('model' in withoutModel).toBe(false);
  });
});
