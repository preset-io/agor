import type { BranchID, BranchName, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE } from '../utils/agentic-tool-runtime.js';

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
    spawnExecutorFireAndForget: vi.fn(),
    generateScopedServiceToken: vi.fn(() => 'session-token'),
    resolveUnixUserForImpersonation: vi.fn(() => ({ unixUser: null })),
    createUserProcessEnvironment: vi.fn(async () => ({})),
    loadConfig: vi.fn(async () => ({ daemon: { port: 3030 }, execution: { branch_rbac: false } })),
  };
});

vi.mock('@agor/core/config', () => ({
  createUserProcessEnvironment: mocks.createUserProcessEnvironment,
  loadConfig: mocks.loadConfig,
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

vi.mock('../utils/spawn-executor.js', () => ({
  generateSessionToken: () => 'session-token',
  generateScopedServiceToken: mocks.generateScopedServiceToken,
  spawnExecutorFireAndForget: mocks.spawnExecutorFireAndForget,
}));

import { buildBranchShellTabName, buildZellijSessionName, TerminalsService } from './terminals';

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

describe('buildZellijSessionName', () => {
  it('builds a compact stable identity from the full user id', () => {
    const userId = '019ed836-1fdc-7cfa-a356-3477c2c54693' as UserID;
    const first = buildZellijSessionName(userId);
    const second = buildZellijSessionName('019ed836-1fdc-7cfa-a356-3477c2c54694' as UserID);

    expect(first).toBe(buildZellijSessionName(userId));
    expect(first).toMatch(/^agor-[a-f0-9]{16}$/);
    expect(first).not.toBe(second);
  });
});

describe('TerminalsService tenant database units of work', () => {
  it('keeps repository and environment reads scoped while process spawn stays outside', async () => {
    mocks.branchesById.clear();
    mocks.branchesById.set(mocks.branch.branch_id, mocks.branch);
    mocks.createUserProcessEnvironment.mockImplementation(async () => {
      expect(mocks.databaseScopeDepth).toBeGreaterThan(0);
      return {};
    });
    mocks.spawnExecutorFireAndForget.mockImplementation(() => {
      expect(mocks.databaseScopeDepth).toBe(0);
    });

    const service = new TerminalsService(makeApp() as never, {} as never, {
      reconnectDiscoveryMs: 0,
    });
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
    const service = new TerminalsService(makeApp() as never, {} as never, {
      reconnectDiscoveryMs: 0,
    });

    await expect(service.create({}, params as never)).rejects.toThrow(
      'Missing active tenant context for terminal creation'
    );
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });
});

describe('TerminalsService cold-start concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveUnixUserForImpersonation.mockReturnValue({ unixUser: null });
    mocks.createUserProcessEnvironment.mockResolvedValue({});
    mocks.branchesById.clear();
    mocks.branchesById.set(mocks.branch.branch_id, mocks.branch);
    mocks.loadConfig.mockResolvedValue({
      daemon: { port: 3030 },
      execution: { branch_rbac: false },
    });
  });

  it('serializes concurrent cold starts for the same user into one executor spawn', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never, {
      reconnectDiscoveryMs: 0,
    });

    let releaseEnv!: () => void;
    const envGate = new Promise<Record<string, string>>((resolve) => {
      releaseEnv = () => resolve({});
    });
    mocks.createUserProcessEnvironment.mockReturnValueOnce(envGate);

    const first = service.create({ branchId: 'branch-1', rows: 24, cols: 80 }, params as never);
    await vi.waitFor(() => expect(mocks.createUserProcessEnvironment).toHaveBeenCalledTimes(1));

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

describe('TerminalsService post-restart executor adoption', () => {
  beforeEach(() => {
    mocks.resolveUnixUserForImpersonation.mockReturnValue({ unixUser: null });
    mocks.createUserProcessEnvironment.mockResolvedValue({});
    mocks.branchesById.clear();
    mocks.branchesById.set(mocks.branch.branch_id, mocks.branch);
  });

  it('adopts a surviving executor that re-announces after the request arrives', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never, {
      reconnectDiscoveryMs: 50,
    });

    const request = service.create({ branchId: 'branch-1' }, params as never);
    setTimeout(() => service.handleExecutorReady(params.user.user_id as never), 5);

    const result = await request;
    expect(result).toMatchObject({ isNew: false, ready: true });
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('reuses a surviving executor that already re-announced', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never, {
      reconnectDiscoveryMs: 50,
    });
    service.handleExecutorReady(params.user.user_id as never);

    const result = await service.create({ branchId: 'branch-1' }, params as never);
    expect(result).toMatchObject({ isNew: false, ready: true });
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('spawns once when no executor re-announces during the discovery window', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never, {
      reconnectDiscoveryMs: 1,
    });

    const result = await service.create({ branchId: 'branch-1' }, params as never);
    expect(result).toMatchObject({ isNew: true, ready: false });
    expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledOnce();
  });
});

describe('TerminalsService readiness ack gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveUnixUserForImpersonation.mockReturnValue({ unixUser: null });
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
    const service = new TerminalsService(makeApp() as never, {} as never, {
      reconnectDiscoveryMs: 0,
    });
    await service.create({ branchId: 'branch-1', rows: 24, cols: 80 }, params as never);

    expect(mocks.generateScopedServiceToken).toHaveBeenCalledWith(
      expect.anything(),
      { terminal_user_id: params.user.user_id },
      '30d'
    );
  });

  it('reports ready=false on cold start and ready=true once the executor acks', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never, {
      reconnectDiscoveryMs: 0,
    });

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

  it('rejects stale Claude CLI bootstrap input before adopting or spawning an executor', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never, {
      reconnectDiscoveryMs: 0,
    });

    await expect(
      service.create(
        {
          branchId: 'branch-1',
          ensureCliSessionId: 'historical-session',
          focusTabName: 'cli-historic',
        },
        params as never
      )
    ).rejects.toThrow(REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE);
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('notifies the browser channel on ready and error acks', () => {
    const app = makeApp();
    const service = new TerminalsService(app as never, {} as never, { reconnectDiscoveryMs: 0 });

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
    const service = new TerminalsService(app as never, {} as never, { reconnectDiscoveryMs: 0 });

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
    const service = new TerminalsService(makeApp() as never, {} as never, {
      reconnectDiscoveryMs: 0,
    });

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
    mocks.resolveUnixUserForImpersonation.mockReturnValue({ unixUser: null });
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
    const service = new TerminalsService(app as never, {} as never, { reconnectDiscoveryMs: 0 });

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

  it('passes the tenant-derived branch path to the executor without daemon canonicalisation', async () => {
    const requestedBranch = {
      ...mocks.branch,
      branch_id: '11111111-1111-7111-8111-111111111111' as BranchID,
      name: 'same-name',
      path: '/tmp/repo-a/same-name',
    };
    mocks.branchesById.set(requestedBranch.branch_id, requestedBranch);
    mocks.resolveUnixUserForImpersonation.mockReturnValue({ unixUser: 'alice' });
    const service = new TerminalsService(makeApp() as never, {} as never, {
      reconnectDiscoveryMs: 0,
    });
    await service.create({ branchId: requestedBranch.branch_id }, params as never);
    expect(mocks.spawnExecutorFireAndForget.mock.calls[0]?.[0]).toMatchObject({
      command: 'zellij.attach',
      params: { cwd: requestedBranch.path, tabName: 'same-name · 11111111' },
    });
  });
});
