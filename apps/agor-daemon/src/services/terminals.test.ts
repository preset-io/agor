import fs from 'node:fs';
import type { BranchID, BranchName } from '@agor/core/types';
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
    tenantId: 'tenant-x' as string | undefined,
    tenantDb: { scope: 'tenant-x' },
    databaseScopeDepth: 0,
    repositoryDbs: [] as unknown[],
    branchesById: new Map<string, typeof branch>([[branch.branch_id, branch]]),
    execSync: vi.fn((cmd: string) => {
      if (cmd === 'which zellij') return Buffer.from('/usr/bin/zellij\n');
      throw new Error('not found');
    }),
    spawnExecutorFireAndForget: vi.fn(),
    generateScopedServiceToken: vi.fn(() => 'session-token'),
    resolveUnixUserForImpersonation: vi.fn(() => ({ unixUser: null })),
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
    constructor(db: unknown) {
      mocks.repositoryDbs.push(db);
    }
    async findById(branchId: string) {
      return mocks.branchesById.get(branchId) ?? null;
    }
    async isOwner() {
      return true;
    }
  },
  getCurrentTenantId: () => mocks.tenantId,
  runWithTenantDatabaseScope: async (
    _db: unknown,
    tenantId: string | undefined,
    work: (db: unknown) => Promise<unknown>
  ) => {
    if (!tenantId) throw new Error('Missing tenant identity');
    mocks.databaseScopeDepth += 1;
    try {
      return await work(mocks.tenantDb);
    } finally {
      mocks.databaseScopeDepth -= 1;
    }
  },
  SessionRepository: class {
    constructor(db: unknown) {
      mocks.repositoryDbs.push(db);
    }
  },
  UsersRepository: class {
    constructor(db: unknown) {
      mocks.repositoryDbs.push(db);
    }
    async findById() {
      return { unix_username: 'alice' };
    }
  },
  shortId: (id: string) =>
    Array.from(id)
      .filter((_, index) => index < 8)
      .join(''),
}));

vi.mock('@agor/core/unix', () => ({
  UnixUserNotFoundError: class UnixUserNotFoundError extends Error {},
  getBranchSymlinkPath: (username: string, branchName: string) =>
    `/home/${username}/agor/worktrees/${branchName}`,
  resolveUnixUserForImpersonation: mocks.resolveUnixUserForImpersonation,
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
  generateScopedServiceToken: mocks.generateScopedServiceToken,
  serviceTokenScopeForParams: () => ({}),
  spawnExecutorFireAndForget: mocks.spawnExecutorFireAndForget,
}));

vi.mock('./claude-cli-integration.js', () => ({
  buildSpawnConfigForSession: vi.fn(),
  isClaudeRunningFor: vi.fn(async () => false),
  writeClaudeCliMcpConfigForSession: vi.fn(async () => undefined),
}));

import { buildBranchShellTabName, TerminalsService } from './terminals';

function makeApp() {
  const emit = vi.fn();
  return {
    emit,
    // The service subscribes to executor ready/error app events in its
    // constructor; a no-op recorder keeps that wiring from throwing under test.
    on: vi.fn(),
    io: {
      to: vi.fn(() => ({ emit })),
    },
  };
}

const params = {
  provider: 'rest',
  user: { user_id: 'user-1', role: 'admin' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenantId = 'tenant-x';
  mocks.databaseScopeDepth = 0;
  mocks.repositoryDbs.length = 0;
});

describe('TerminalsService tenant database units of work', () => {
  it('keeps repository and environment reads scoped while process spawn stays outside', async () => {
    mocks.branchesById.clear();
    mocks.branchesById.set(mocks.branch.branch_id, mocks.branch);
    mocks.resolveUserEnvironment.mockImplementation(async () => {
      expect(mocks.databaseScopeDepth).toBeGreaterThan(0);
      return {};
    });
    mocks.createUserProcessEnvironment.mockImplementation(async () => {
      expect(mocks.databaseScopeDepth).toBeGreaterThan(0);
      return {};
    });
    mocks.spawnExecutorFireAndForget.mockImplementation(() => {
      expect(mocks.databaseScopeDepth).toBe(0);
    });

    const service = new TerminalsService(makeApp() as never, {} as never);
    await service.create({ branchId: mocks.branch.branch_id }, params as never);

    expect(mocks.repositoryDbs.length).toBeGreaterThan(0);
    expect(mocks.repositoryDbs).toEqual(
      expect.arrayContaining([mocks.tenantDb, mocks.tenantDb, mocks.tenantDb])
    );
    expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledOnce();
    expect(mocks.databaseScopeDepth).toBe(0);
  });

  it('fails fast without ambient tenant identity', async () => {
    mocks.tenantId = undefined;
    const service = new TerminalsService(makeApp() as never, {} as never);

    await expect(service.create({}, params as never)).rejects.toThrow(
      'Missing active tenant context for terminal creation'
    );
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });
});

describe('TerminalsService cold-start concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execSync.mockImplementation((cmd: string) => {
      if (cmd === 'which zellij') return Buffer.from('/usr/bin/zellij\n');
      if (cmd.startsWith('sudo -n chown ')) return Buffer.from('');
      throw new Error('not found');
    });
    mocks.resolveUnixUserForImpersonation.mockReturnValue({ unixUser: null });
    mocks.resolveUserEnvironment.mockResolvedValue({});
    mocks.createUserProcessEnvironment.mockResolvedValue({});
    mocks.branchesById.clear();
    mocks.branchesById.set(mocks.branch.branch_id, mocks.branch);
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

describe('TerminalsService readiness ack gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execSync.mockImplementation((cmd: string) => {
      if (cmd === 'which zellij') return Buffer.from('/usr/bin/zellij\n');
      if (cmd.startsWith('sudo -n chown ')) return Buffer.from('');
      throw new Error('not found');
    });
    mocks.resolveUnixUserForImpersonation.mockReturnValue({ unixUser: null });
    mocks.resolveUserEnvironment.mockResolvedValue({});
    mocks.createUserProcessEnvironment.mockResolvedValue({});
    mocks.branchesById.clear();
    mocks.branchesById.set(mocks.branch.branch_id, mocks.branch);
    mocks.loadConfig.mockResolvedValue({
      daemon: { port: 3030 },
      execution: { branch_rbac: false },
    });
  });

  it('binds terminal_user_id and a long TTL into the executor service token', async () => {
    // Reconnection reuses this same token; the default 5m service-token TTL
    // would expire mid-session and break reconnect (the whole point of the
    // feature). The token must be user-scoped AND long-lived.
    const service = new TerminalsService(makeApp() as never, {} as never);
    await service.create({ branchId: 'branch-1', rows: 24, cols: 80 }, params as never);

    expect(mocks.generateScopedServiceToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { terminal_user_id: params.user.user_id },
      '30d'
    );
  });

  it('reports ready=false on cold start and ready=true once the executor acks', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never);

    const cold = await service.create(
      { branchId: 'branch-1', rows: 24, cols: 80 },
      params as never
    );
    expect(cold.isNew).toBe(true);
    expect(cold.ready).toBe(false);

    // Executor announces its PTY is attached.
    service.handleExecutorReady(params.user.user_id as never);

    const warm = await service.create(
      { branchId: 'branch-1', rows: 24, cols: 80 },
      params as never
    );
    expect(warm.isNew).toBe(false);
    expect(warm.ready).toBe(true);
  });

  it('notifies the browser channel on ready and error acks', () => {
    const app = makeApp();
    const service = new TerminalsService(app as never, {} as never);

    service.handleExecutorReady(params.user.user_id as never);
    expect(app.io.to).toHaveBeenCalledWith(`user/${params.user.user_id}/terminal`);
    expect(app.emit).toHaveBeenCalledWith('terminal:ready', { userId: params.user.user_id });

    service.handleExecutorError(params.user.user_id as never, 'spawn failed');
    expect(app.emit).toHaveBeenCalledWith('terminal:error', {
      userId: params.user.user_id,
      message: 'spawn failed',
    });
  });

  it('defers cold-start tab focus until the readiness ack arrives', async () => {
    const app = makeApp();
    const service = new TerminalsService(app as never, {} as never);

    await service.create(
      { branchId: 'branch-1', focusTabName: 'cli-abc', rows: 24, cols: 80 },
      params as never
    );

    // Cold start: the executor isn't up yet, so no focus is emitted.
    expect(app.emit).not.toHaveBeenCalledWith(
      'terminal:tab',
      expect.objectContaining({ action: 'focus', tabName: 'cli-abc' })
    );

    // Ack arrives → the gated focus fires.
    service.handleExecutorReady(params.user.user_id as never);
    await vi.waitFor(() => {
      expect(app.emit).toHaveBeenCalledWith('terminal:tab', {
        userId: params.user.user_id,
        action: 'focus',
        tabName: 'cli-abc',
      });
    });
  });

  it('drops readiness when the executor exits so the next start waits again', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never);

    await service.create({ branchId: 'branch-1', rows: 24, cols: 80 }, params as never);
    service.handleExecutorReady(params.user.user_id as never);
    service.handleExecutorExit(params.user.user_id as never);

    const afterExit = await service.create(
      { branchId: 'branch-1', rows: 24, cols: 80 },
      params as never
    );
    // Executor map was cleared on exit → this is a fresh cold start, not ready.
    expect(afterExit.isNew).toBe(true);
    expect(afterExit.ready).toBe(false);
  });
});

describe('TerminalsService branch shell tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execSync.mockImplementation((cmd: string) => {
      if (cmd === 'which zellij') return Buffer.from('/usr/bin/zellij\n');
      if (cmd.startsWith('sudo -n chown ')) return Buffer.from('');
      throw new Error('not found');
    });
    mocks.resolveUnixUserForImpersonation.mockReturnValue({ unixUser: null });
    mocks.resolveUserEnvironment.mockResolvedValue({});
    mocks.createUserProcessEnvironment.mockResolvedValue({});
    mocks.loadConfig.mockResolvedValue({
      daemon: { port: 3030 },
      execution: { branch_rbac: false },
    });
    mocks.branchesById.clear();
  });

  it('includes branch identity in shell tab names even when branch names match', () => {
    const first = {
      branch_id: '11111111-1111-7111-8111-111111111111' as BranchID,
      name: 'same-name' as BranchName,
    };
    const second = {
      branch_id: '22222222-2222-7222-8222-222222222222' as BranchID,
      name: 'same-name' as BranchName,
    };

    expect(buildBranchShellTabName(first)).toBe('same-name · 11111111');
    expect(buildBranchShellTabName(second)).toBe('same-name · 22222222');
    expect(buildBranchShellTabName(first)).not.toBe(buildBranchShellTabName(second));
  });

  it('uses identity-safe tab names for cold-start and warm branch shell routing', async () => {
    const firstBranch = {
      ...mocks.branch,
      branch_id: '11111111-1111-7111-8111-111111111111' as BranchID,
      name: 'same-name',
      path: '/tmp/repo-a/same-name',
    };
    const secondBranch = {
      ...mocks.branch,
      branch_id: '22222222-2222-7222-8222-222222222222' as BranchID,
      name: 'same-name',
      path: '/tmp/repo-b/same-name',
    };
    mocks.branchesById.set(firstBranch.branch_id, firstBranch);
    mocks.branchesById.set(secondBranch.branch_id, secondBranch);

    const app = makeApp();
    const service = new TerminalsService(app as never, {} as never);

    const first = await service.create(
      { branchId: firstBranch.branch_id, rows: 24, cols: 80 },
      params as never
    );

    expect(first).toMatchObject({
      isNew: true,
      branchName: 'same-name',
    });
    expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledTimes(1);
    expect(mocks.spawnExecutorFireAndForget.mock.calls[0]?.[0]).toMatchObject({
      command: 'zellij.attach',
      params: {
        cwd: firstBranch.path,
        tabName: 'same-name · 11111111',
      },
    });

    // Warm reuse only drives the executor once it has acked readiness — an
    // adopted-but-not-yet-reconnected executor must not get commands fired into
    // an empty room. Mark ready to model a live, acked executor.
    service.handleExecutorReady(params.user.user_id as never);

    const second = await service.create(
      { branchId: secondBranch.branch_id, rows: 24, cols: 80 },
      params as never
    );

    expect(second).toMatchObject({
      isNew: false,
      branchName: 'same-name',
      ready: true,
    });
    await vi.waitFor(() => {
      expect(app.emit).toHaveBeenCalledWith('terminal:tab', {
        userId: params.user.user_id,
        action: 'create',
        tabName: 'same-name · 22222222',
        cwd: secondBranch.path,
      });
    });
  });

  it('does not fire warm choreography until an adopted executor re-announces readiness', async () => {
    // Model a post-restart adoption: pgrep finds the surviving process, so the
    // executor is in the map (warm path) but has NOT re-acked readiness yet.
    mocks.execSync.mockImplementation((cmd: string) => {
      if (cmd === 'which zellij') return Buffer.from('/usr/bin/zellij\n');
      if (cmd.startsWith('pgrep ')) return Buffer.from('4242\n'); // adoption hit
      if (cmd.startsWith('sudo -n chown ')) return Buffer.from('');
      throw new Error('not found');
    });
    const branch = {
      ...mocks.branch,
      branch_id: '33333333-3333-7333-8333-333333333333' as BranchID,
      name: 'adopt-me',
      path: '/tmp/repo/adopt-me',
    };
    mocks.branchesById.set(branch.branch_id, branch);

    const app = makeApp();
    const service = new TerminalsService(app as never, {} as never);

    const result = await service.create(
      { branchId: branch.branch_id, rows: 24, cols: 80 },
      params as never
    );

    // Adopted, not spawned, and not yet ready.
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isNew: false, ready: false });
    expect(app.emit).not.toHaveBeenCalledWith('terminal:tab', expect.anything());

    // The surviving executor reconnects and re-announces — now choreography fires.
    service.handleExecutorReady(params.user.user_id as never);
    await vi.waitFor(() => {
      expect(app.emit).toHaveBeenCalledWith(
        'terminal:tab',
        expect.objectContaining({ action: 'create', tabName: 'adopt-me · 33333333' })
      );
    });
  });

  it('skips warm choreography entirely when the readiness ack never arrives (no best-effort)', async () => {
    vi.useFakeTimers();
    try {
      mocks.execSync.mockImplementation((cmd: string) => {
        if (cmd === 'which zellij') return Buffer.from('/usr/bin/zellij\n');
        if (cmd.startsWith('pgrep ')) return Buffer.from('4242\n'); // adopted
        if (cmd.startsWith('sudo -n chown ')) return Buffer.from('');
        throw new Error('not found');
      });
      const branch = {
        ...mocks.branch,
        branch_id: '44444444-4444-7444-8444-444444444444' as BranchID,
        name: 'never-ready',
        path: '/tmp/repo/never-ready',
      };
      mocks.branchesById.set(branch.branch_id, branch);

      const app = makeApp();
      const service = new TerminalsService(app as never, {} as never);
      await service.create({ branchId: branch.branch_id, rows: 24, cols: 80 }, params as never);

      // Advance well past the readiness timeout without any ack.
      await vi.advanceTimersByTimeAsync(15_000);

      // Best-effort firing is gone: nothing is emitted into the dead room.
      expect(app.emit).not.toHaveBeenCalledWith('terminal:tab', expect.anything());
      expect(app.emit).not.toHaveBeenCalledWith('terminal:redraw', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to branch.path when an impersonated same-name symlink resolves elsewhere', async () => {
    const staleSymlinkPath = '/home/alice/agor/worktrees/same-name';
    const requestedBranch = {
      ...mocks.branch,
      branch_id: '11111111-1111-7111-8111-111111111111' as BranchID,
      name: 'same-name',
      path: '/tmp/repo-a/same-name',
    };
    mocks.branchesById.set(requestedBranch.branch_id, requestedBranch);
    mocks.resolveUnixUserForImpersonation.mockReturnValue({ unixUser: 'alice' });
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation((pathToResolve) => {
      const pathString = String(pathToResolve);
      if (pathString === staleSymlinkPath) return '/tmp/repo-b/same-name';
      if (pathString === requestedBranch.path) return requestedBranch.path;
      throw new Error(`Unexpected realpath: ${pathString}`);
    });

    try {
      const service = new TerminalsService(makeApp() as never, {} as never);

      await service.create(
        { branchId: requestedBranch.branch_id, rows: 24, cols: 80 },
        params as never
      );

      expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledTimes(1);
      expect(mocks.spawnExecutorFireAndForget.mock.calls[0]?.[0]).toMatchObject({
        command: 'zellij.attach',
        params: {
          cwd: requestedBranch.path,
          tabName: 'same-name · 11111111',
        },
      });
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it('uses the impersonated symlink when it resolves to the requested branch path', async () => {
    const matchingSymlinkPath = '/home/alice/agor/worktrees/same-name';
    const requestedBranch = {
      ...mocks.branch,
      branch_id: '11111111-1111-7111-8111-111111111111' as BranchID,
      name: 'same-name',
      path: '/tmp/repo-a/same-name',
    };
    mocks.branchesById.set(requestedBranch.branch_id, requestedBranch);
    mocks.resolveUnixUserForImpersonation.mockReturnValue({ unixUser: 'alice' });
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation((pathToResolve) => {
      const pathString = String(pathToResolve);
      if (pathString === matchingSymlinkPath) return requestedBranch.path;
      if (pathString === requestedBranch.path) return requestedBranch.path;
      throw new Error(`Unexpected realpath: ${pathString}`);
    });

    try {
      const service = new TerminalsService(makeApp() as never, {} as never);

      await service.create(
        { branchId: requestedBranch.branch_id, rows: 24, cols: 80 },
        params as never
      );

      expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledTimes(1);
      expect(mocks.spawnExecutorFireAndForget.mock.calls[0]?.[0]).toMatchObject({
        command: 'zellij.attach',
        params: {
          cwd: matchingSymlinkPath,
          tabName: 'same-name · 11111111',
        },
      });
    } finally {
      realpathSpy.mockRestore();
    }
  });
});
