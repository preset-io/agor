import type { BranchID, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE } from '../utils/agentic-tool-runtime.js';

const mocks = vi.hoisted(() => {
  const branch = {
    branch_id: 'branch-1',
    name: 'feature-branch',
    path: '/worktrees/feature-branch',
    others_can: 'session',
    created_by: 'user-1',
    archived: false,
  };
  return {
    branch,
    tenantId: 'tenant-x' as string | undefined,
    tenantDb: { scope: 'tenant-x' },
    databaseScopeDepth: 0,
    branchesById: new Map<string, typeof branch>([[branch.branch_id, branch]]),
    spawnExecutorFireAndForget: vi.fn(),
    generateScopedServiceToken: vi.fn(() => 'terminal-token'),
    resolveUnixUserForImpersonation: vi.fn(() => ({
      unixUser: null,
      reportedUnixUser: null,
    })),
    createUserProcessEnvironment: vi.fn(async () => ({})),
    config: {
      daemon: { port: 3030 },
      execution: { branch_rbac: false, unix_user_mode: 'simple' },
    },
    canOpen: true,
  };
});

vi.mock('@agor/core/config', () => ({
  createUserProcessEnvironment: mocks.createUserProcessEnvironment,
}));

vi.mock('@agor/core/db', () => ({
  BranchRepository: class {
    async findById(branchId: string) {
      return mocks.branchesById.get(branchId) ?? null;
    }
    async isOwner() {
      return true;
    }
    async resolveUserPermission() {
      return 'session';
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
    async findById() {
      return { unix_username: 'alice' };
    }
  },
  shortId: (id: string) => id,
}));

vi.mock('@agor/core/unix', () => ({
  UnixUserNotFoundError: class UnixUserNotFoundError extends Error {},
  resolveUnixUserForImpersonation: mocks.resolveUnixUserForImpersonation,
  validateResolvedUnixUser: () => undefined,
}));

vi.mock('../utils/branch-authorization.js', () => ({
  hasBranchPermission: () => mocks.canOpen,
}));

vi.mock('../utils/spawn-executor.js', () => ({
  generateScopedServiceToken: mocks.generateScopedServiceToken,
  spawnExecutorFireAndForget: mocks.spawnExecutorFireAndForget,
}));

import { buildZellijSessionName, TerminalsService } from './terminals';

function makeApp() {
  const emit = vi.fn();
  return {
    emit,
    on: vi.fn(),
    get: vi.fn((key: string) => {
      if (key === 'config') {
        return mocks.config;
      }
      if (key === 'distributedWorkIdentity') {
        return { instanceId: 'daemon-a', bootId: 'daemon-a-boot' };
      }
      return undefined;
    }),
    io: {
      local: { to: vi.fn(() => ({ emit })) },
    },
  };
}

const params = {
  provider: 'socketio',
  user: { user_id: 'user-1', role: 'admin' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenantId = 'tenant-x';
  mocks.databaseScopeDepth = 0;
  mocks.canOpen = true;
  mocks.branchesById.clear();
  mocks.branchesById.set(mocks.branch.branch_id, mocks.branch);
  mocks.resolveUnixUserForImpersonation.mockReturnValue({
    unixUser: null,
    reportedUnixUser: null,
  });
  mocks.createUserProcessEnvironment.mockResolvedValue({});
  mocks.config = {
    daemon: { port: 3030 },
    execution: { branch_rbac: false, unix_user_mode: 'simple' },
  };
});

describe('branch-scoped terminal identity', () => {
  it('makes Zellij shell names stable and tenant/user/branch scoped', () => {
    const user = 'user-1' as UserID;
    const first = buildZellijSessionName('tenant-a', user, 'branch-1' as BranchID);
    expect(first).toMatch(/^agor-[a-f0-9]{16}$/);
    expect(first).toBe(buildZellijSessionName('tenant-a', user, 'branch-1' as BranchID));
    expect(first).not.toBe(buildZellijSessionName('tenant-b', user, 'branch-1' as BranchID));
    expect(first).not.toBe(buildZellijSessionName('tenant-a', user, 'branch-2' as BranchID));
  });

  it('requires a branch and rejects REST creation so create and I/O share an owner', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never);
    await expect(service.create({}, params as never)).rejects.toThrow('branchId is required');
    await expect(
      service.create({ branchId: 'branch-1' as BranchID }, { ...params, provider: 'rest' } as never)
    ).rejects.toThrow('owning Socket.IO connection');
  });

  it('rejects a missing branch even when branch RBAC is disabled', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never);
    await expect(
      service.create({ branchId: 'missing' as BranchID }, params as never)
    ).rejects.toThrow('Branch not found');
  });

  it('rejects an archived branch even while its filesystem is preserved', async () => {
    mocks.branchesById.set('branch-1', { ...mocks.branch, archived: true });
    const service = new TerminalsService(makeApp() as never, {} as never);
    await expect(
      service.create({ branchId: 'branch-1' as BranchID }, params as never)
    ).rejects.toThrow('Branch is archived');
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });
});

describe('process-affine attachment creation', () => {
  it('spawns with server-derived branch cwd and fenced tenant/user/branch/owner claims', async () => {
    mocks.createUserProcessEnvironment.mockImplementation(async () => {
      expect(mocks.databaseScopeDepth).toBeGreaterThan(0);
      return { SAFE: '1' };
    });
    mocks.spawnExecutorFireAndForget.mockImplementation(() => {
      expect(mocks.databaseScopeDepth).toBe(0);
    });
    const service = new TerminalsService(makeApp() as never, {} as never);
    const result = await service.create({ branchId: 'branch-1' as BranchID }, params as never);

    expect(result).toMatchObject({
      userId: 'user-1',
      branchId: 'branch-1',
      ownerId: 'daemon-a',
      ownerBootId: 'daemon-a-boot',
      isNew: true,
      ready: false,
    });
    expect(result.channel).toBe(`tenant/tenant-x/user/user-1/terminal/${result.terminalId}`);
    expect(mocks.generateScopedServiceToken).toHaveBeenCalledWith(
      expect.anything(),
      {
        terminal_user_id: 'user-1',
        terminal_id: result.terminalId,
        terminal_branch_id: 'branch-1',
        terminal_owner_boot_id: 'daemon-a-boot',
      },
      '30d'
    );
    expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonUrl: 'http://127.0.0.1:3030',
        params: expect.objectContaining({
          terminalId: result.terminalId,
          channel: result.channel,
          cwd: '/worktrees/feature-branch',
        }),
      }),
      expect.anything()
    );
  });

  it('serializes same-scope starts and reuses only the local live attachment', async () => {
    let release!: () => void;
    mocks.createUserProcessEnvironment.mockImplementation(
      () => new Promise<Record<string, string>>((resolve) => (release = () => resolve({})))
    );
    const service = new TerminalsService(makeApp() as never, {} as never);
    const first = service.create({ branchId: 'branch-1' as BranchID }, params as never);
    await vi.waitFor(() => expect(mocks.createUserProcessEnvironment).toHaveBeenCalledOnce());
    const second = service.create({ branchId: 'branch-1' as BranchID }, params as never);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledOnce();
    expect(b.terminalId).toBe(a.terminalId);
    expect(b.isNew).toBe(false);
  });

  it('uses separate attachments and Zellij sessions for separate branches', async () => {
    mocks.branchesById.set('branch-2', {
      ...mocks.branch,
      branch_id: 'branch-2',
      name: 'other',
      path: '/worktrees/other',
    });
    const service = new TerminalsService(makeApp() as never, {} as never);
    const a = await service.create({ branchId: 'branch-1' as BranchID }, params as never);
    const b = await service.create({ branchId: 'branch-2' as BranchID }, params as never);
    expect(a.terminalId).not.toBe(b.terminalId);
    expect(a.sessionName).not.toBe(b.sessionName);
    expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledTimes(2);
  });

  it('keeps strict/impersonated terminals in the branch cwd', async () => {
    mocks.config = {
      daemon: { port: 3030 },
      execution: { branch_rbac: false, unix_user_mode: 'strict' },
    };
    mocks.resolveUnixUserForImpersonation.mockReturnValue({
      unixUser: 'alice',
      reportedUnixUser: 'alice',
    });
    const service = new TerminalsService(makeApp() as never, {} as never);
    await service.create({ branchId: 'branch-1' as BranchID }, params as never);
    expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ cwd: mocks.branch.path }) }),
      expect.objectContaining({ asUser: 'alice' })
    );
  });

  it('enforces branch session permission', async () => {
    mocks.canOpen = false;
    mocks.config = {
      daemon: { port: 3030 },
      execution: { branch_rbac: true, unix_user_mode: 'simple' },
    };
    const service = new TerminalsService(makeApp() as never, {} as never);
    await expect(
      service.create({ branchId: 'branch-1' as BranchID }, params as never)
    ).rejects.toThrow("need 'session' permission");
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });
});

describe('attachment lifecycle', () => {
  it('routes ready/error only to the matching terminal channel', async () => {
    const app = makeApp();
    const service = new TerminalsService(app as never, {} as never);
    const terminal = await service.create({ branchId: 'branch-1' as BranchID }, params as never);
    service.handleExecutorReady(terminal.terminalId, 'user-1');
    expect(app.io.local.to).toHaveBeenCalledWith(terminal.channel);
    expect(app.emit).toHaveBeenCalledWith('terminal:ready', {
      terminalId: terminal.terminalId,
      userId: 'user-1',
    });
    service.handleExecutorError(terminal.terminalId, 'user-1', 'failed');
    expect(app.emit).toHaveBeenCalledWith('terminal:error', {
      terminalId: terminal.terminalId,
      userId: 'user-1',
      message: 'failed',
    });
  });

  it('explicit remove shuts down only the caller-owned local attachment', async () => {
    const app = makeApp();
    const service = new TerminalsService(app as never, {} as never);
    const terminal = await service.create({ branchId: 'branch-1' as BranchID }, params as never);
    await expect(service.remove(terminal.terminalId, params as never)).resolves.toEqual({
      closed: true,
    });
    expect(app.emit).toHaveBeenCalledWith('terminal:shutdown-local', {
      terminalId: terminal.terminalId,
      userId: 'user-1',
    });
    expect(app.emit).toHaveBeenCalledWith('terminal:exit', {
      terminalId: terminal.terminalId,
      userId: 'user-1',
      exitCode: 0,
    });
    await expect(
      service.remove(terminal.terminalId, {
        ...params,
        user: { user_id: 'user-2', role: 'admin' },
      } as never)
    ).resolves.toEqual({ closed: false });
  });

  it('fences executor capabilities against the live local attachment registry', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never);
    const terminal = await service.create({ branchId: 'branch-1' as BranchID }, params as never);
    const identity = {
      terminalId: terminal.terminalId,
      tenantId: 'tenant-x',
      userId: 'user-1',
      branchId: 'branch-1',
      ownerBootId: 'daemon-a-boot',
    };
    expect(service.matchesOwnedAttachment(identity)).toBe(true);
    expect(service.matchesOwnedAttachment({ ...identity, tenantId: 'tenant-y' })).toBe(false);
    expect(service.matchesOwnedAttachment({ ...identity, branchId: 'branch-2' })).toBe(false);

    await service.remove(terminal.terminalId, params as never);
    expect(service.matchesOwnedAttachment(identity)).toBe(false);
  });

  it('notifies browsers and fences the attachment when the executor process exits', async () => {
    const app = makeApp();
    const service = new TerminalsService(app as never, {} as never);
    const terminal = await service.create({ branchId: 'branch-1' as BranchID }, params as never);

    service.handleExecutorExit(terminal.terminalId, 'user-1', 17, 9);

    expect(app.emit).toHaveBeenCalledWith('terminal:exit', {
      terminalId: terminal.terminalId,
      userId: 'user-1',
      exitCode: 17,
      signal: 9,
    });
    expect(app.emit).toHaveBeenCalledWith('terminal:shutdown-local', {
      terminalId: terminal.terminalId,
      userId: 'user-1',
    });
    expect(
      service.matchesOwnedAttachment({
        terminalId: terminal.terminalId,
        tenantId: 'tenant-x',
        userId: 'user-1',
        branchId: 'branch-1',
        ownerBootId: 'daemon-a-boot',
      })
    ).toBe(false);
  });

  it('branch lifecycle cleanup is tenant-qualified', async () => {
    const app = makeApp();
    const service = new TerminalsService(app as never, {} as never);
    const terminal = await service.create({ branchId: 'branch-1' as BranchID }, params as never);
    service.closeBranch('tenant-b', 'branch-1');
    expect(app.emit).not.toHaveBeenCalledWith('terminal:shutdown-local', expect.anything());
    service.closeBranch('tenant-x', 'branch-1');
    expect(app.emit).toHaveBeenCalledWith('terminal:shutdown-local', {
      terminalId: terminal.terminalId,
      userId: 'user-1',
    });
  });

  it('fails closed without tenant context and rejects removed CLI compatibility input', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never);
    await expect(
      service.create(
        { branchId: 'branch-1' as BranchID, ensureCliSessionId: 'legacy' },
        params as never
      )
    ).rejects.toThrow(REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE);
    mocks.tenantId = undefined;
    await expect(
      service.create({ branchId: 'branch-1' as BranchID }, params as never)
    ).rejects.toThrow('Missing active tenant context');
  });
});
