import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const branch = {
    branch_id: 'branch-1',
    name: 'feature-branch',
    path: '/tmp/agor-feature-branch',
    others_can: 'session',
    created_by: 'user-1',
  };
  return {
    branch,
    execSync: vi.fn((cmd: string) => {
      if (cmd === 'which zellij') return Buffer.from('/usr/bin/zellij\n');
      throw new Error('not found');
    }),
    spawnExecutorFireAndForget: vi.fn(),
    resolveUserEnvironment: vi.fn(async () => ({})),
    createUserProcessEnvironment: vi.fn(async () => ({})),
    loadConfig: vi.fn(async () => ({ daemon: { port: 3030 }, execution: { branch_rbac: false } })),
  };
});

vi.mock('node:child_process', () => ({
  execSync: mocks.execSync,
}));

vi.mock('@agor/core/config', () => ({
  createUserProcessEnvironment: mocks.createUserProcessEnvironment,
  loadConfig: mocks.loadConfig,
  resolveUserEnvironment: mocks.resolveUserEnvironment,
}));

vi.mock('@agor/core/db', () => ({
  BranchRepository: class {
    async findById() {
      return mocks.branch;
    }
    async isOwner() {
      return true;
    }
  },
  SessionRepository: class {},
  UsersRepository: class {
    async findById() {
      return null;
    }
  },
  shortId: () => 'short-user',
}));

vi.mock('@agor/core/unix', () => ({
  UnixUserNotFoundError: class UnixUserNotFoundError extends Error {},
  resolveUnixUserForImpersonation: () => ({ unixUser: null }),
  validateResolvedUnixUser: () => undefined,
}));

vi.mock('../utils/branch-authorization.js', () => ({
  hasBranchPermission: () => true,
}));

vi.mock('../utils/mcp-token-authorization.js', () => ({
  canControlCliSession: () => true,
}));

vi.mock('../utils/spawn-executor.js', () => ({
  generateSessionToken: () => 'session-token',
  spawnExecutorFireAndForget: mocks.spawnExecutorFireAndForget,
}));

vi.mock('./claude-cli-integration.js', () => ({
  buildSpawnConfigForSession: vi.fn(),
  isClaudeRunningFor: vi.fn(async () => false),
  writeClaudeCliMcpConfigForSession: vi.fn(async () => undefined),
}));

import { TerminalsService } from './terminals';

function makeApp() {
  const emit = vi.fn();
  return {
    io: {
      to: vi.fn(() => ({ emit })),
    },
  };
}

const params = {
  provider: 'rest',
  user: { user_id: 'user-1', role: 'admin' },
};

describe('TerminalsService cold-start concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execSync.mockImplementation((cmd: string) => {
      if (cmd === 'which zellij') return Buffer.from('/usr/bin/zellij\n');
      throw new Error('not found');
    });
    mocks.resolveUserEnvironment.mockResolvedValue({});
    mocks.createUserProcessEnvironment.mockResolvedValue({});
    mocks.loadConfig.mockResolvedValue({
      daemon: { port: 3030 },
      execution: { branch_rbac: false },
    });
  });

  it('serializes concurrent cold starts for the same user into one executor spawn', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never);

    let releaseEnv!: () => void;
    const envGate = new Promise<Record<string, string>>((resolve) => {
      releaseEnv = () => resolve({});
    });
    mocks.resolveUserEnvironment.mockReturnValueOnce(envGate);

    const first = service.create({ branchId: 'branch-1', rows: 24, cols: 80 }, params as never);
    await vi.waitFor(() => expect(mocks.resolveUserEnvironment).toHaveBeenCalledTimes(1));

    const second = service.create({ branchId: 'branch-1', rows: 24, cols: 80 }, params as never);

    // Let the first cold start finish; the second should wait for the reservation,
    // re-enter, and take the warm path rather than spawning another executor.
    releaseEnv();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledTimes(1);
    expect(firstResult.isNew).toBe(true);
    expect(secondResult.isNew).toBe(false);
    expect(firstResult.sessionName).toBe(secondResult.sessionName);
  });
});
