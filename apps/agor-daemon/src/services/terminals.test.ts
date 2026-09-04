import type { BranchID, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_AUTHORIZATION_INVALIDATION_EVENT } from '../realtime/routing.js';
import { TERMINAL_REQUEST_JOIN_CHANNEL } from '../terminal-socket-connection.js';
import { REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE } from '../utils/agentic-tool-runtime.js';

const mocks = vi.hoisted(() => {
  const branch = {
    branch_id: 'branch-1',
    name: 'feature-branch',
    path: '/worktrees/feature-branch',
    others_can: 'session',
    created_by: 'user-1',
    archived: false,
    sdk_home: undefined as 'per_branch' | undefined,
  };
  const state = {
    branch,
    tenantId: 'tenant-x' as string | undefined,
    tenantDb: { scope: 'tenant-x' },
    databaseScopeDepth: 0,
    transactionCalls: 0,
    failTransactionCall: undefined as number | undefined,
    branchesById: new Map<string, typeof branch>([[branch.branch_id, branch]]),
    spawnExecutorFireAndForget: vi.fn(),
    generateTerminalExecutorToken: vi.fn(() => 'terminal-token'),
    getDaemonUrl: vi.fn(() => 'http://daemon.internal:3030'),
    resolveDelegatedHomeKey: vi.fn(() => ({
      unixUser: null,
      delegatedHomeKey: null,
    })),
    createUserProcessEnvironment: vi.fn(async () => ({})),
    joinRequestingSocket: vi.fn(async () => true),
    config: {
      daemon: { port: 3030 },
      execution: { branch_rbac: true, unix_user_mode: 'simple' },
    },
    canOpen: true,
    fsAccess: 'write' as 'none' | 'read' | 'write',
    currentRole: 'admin',
  };
  return {
    ...state,
    resolveCurrentTenantAuthorityActor: vi.fn(async () => ({
      kind: 'human',
      user_id: 'user-1',
      role: state.currentRole,
      service: false,
    })),
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
    async findAccessibleById(
      branchId: string,
      _userId: string,
      options: { enforceAccess?: boolean }
    ) {
      const branch = mocks.branchesById.get(branchId) ?? null;
      if (!branch || (options.enforceAccess !== false && !mocks.canOpen)) return null;
      return branch;
    }
    async resolveUserAccess() {
      return { fs_access: mocks.fsAccess };
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
  runWithTenantDatabaseTransaction: async (
    _db: unknown,
    tenantId: string | undefined,
    work: (db: unknown) => Promise<unknown>
  ) => {
    if (!tenantId) throw new Error('Missing tenant identity');
    const call = ++mocks.transactionCalls;
    mocks.databaseScopeDepth += 1;
    try {
      const result = await work(mocks.tenantDb);
      if (mocks.failTransactionCall === call) throw new Error('forced commit failure');
      return result;
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

vi.mock('./tenant-authorization-fence.js', () => ({
  lockTenantAuthorizationFence: vi.fn(),
  resolveCurrentTenantAuthorityActor: mocks.resolveCurrentTenantAuthorityActor,
}));

vi.mock('@agor/core/unix', () => ({
  UnixUserNotFoundError: class UnixUserNotFoundError extends Error {},
  resolveDelegatedHomeKey: mocks.resolveDelegatedHomeKey,
  validateResolvedUnixUser: () => undefined,
}));

vi.mock('../utils/branch-authorization.js', () => ({
  isSuperAdmin: (role: string | undefined, allow: boolean) => allow && role === 'superadmin',
}));

vi.mock('../utils/spawn-executor.js', () => ({
  generateTerminalExecutorToken: mocks.generateTerminalExecutorToken,
  getDaemonUrl: mocks.getDaemonUrl,
  spawnExecutorFireAndForget: mocks.spawnExecutorFireAndForget,
}));

import { buildZellijSessionName, TerminalsService, terminalChannelName } from './terminals';

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
  connection: {
    [TERMINAL_REQUEST_JOIN_CHANNEL]: mocks.joinRequestingSocket,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spawnExecutorFireAndForget.mockReset();
  mocks.tenantId = 'tenant-x';
  mocks.databaseScopeDepth = 0;
  mocks.transactionCalls = 0;
  mocks.failTransactionCall = undefined;
  mocks.canOpen = true;
  mocks.fsAccess = 'write';
  mocks.currentRole = 'admin';
  mocks.resolveCurrentTenantAuthorityActor.mockImplementation(async () => ({
    kind: 'human',
    user_id: 'user-1',
    role: mocks.currentRole,
    service: false,
  }));
  mocks.branchesById.clear();
  mocks.branchesById.set(mocks.branch.branch_id, mocks.branch);
  mocks.resolveDelegatedHomeKey.mockReturnValue({
    unixUser: null,
    delegatedHomeKey: null,
  });
  mocks.createUserProcessEnvironment.mockResolvedValue({});
  mocks.joinRequestingSocket.mockResolvedValue(true);
  mocks.config = {
    daemon: { port: 3030 },
    execution: { branch_rbac: true, unix_user_mode: 'simple' },
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
    await expect(
      service.create({ branchId: 'branch-1' as BranchID }, { ...params, connection: {} } as never)
    ).rejects.toThrow('cannot subscribe to this terminal');
  });

  it('rejects a missing or inaccessible branch without enumeration', async () => {
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
  it('keeps shared SDK homes out of interactive terminal launches', async () => {
    mocks.config = {
      daemon: { port: 3030 },
      execution: {
        branch_rbac: true,
        unix_user_mode: 'delegated',
        sandbox: { sdk_home_mode: 'per_branch' },
      },
    };
    mocks.resolveDelegatedHomeKey.mockReturnValue({
      unixUser: 'alice',
      delegatedHomeKey: 'alice',
    });
    mocks.branchesById.set('branch-1', { ...mocks.branch, sdk_home: 'per_branch' });
    const service = new TerminalsService(makeApp() as never, {} as never);

    await service.create({ branchId: 'branch-1' as BranchID }, params as never);

    expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.not.objectContaining({ sandboxBranchSdkHome: expect.anything() }),
      }),
      expect.objectContaining({
        env: expect.not.objectContaining({
          CLAUDE_CONFIG_DIR: expect.anything(),
          CODEX_HOME: expect.anything(),
        }),
        templateVariables: expect.objectContaining({
          branch_sdk_home: '',
        }),
      })
    );
  });

  it('subscribes the requesting browser before the executor can emit startup state', async () => {
    const order: string[] = [];
    mocks.joinRequestingSocket.mockImplementation(async () => {
      order.push('browser-joined');
      return true;
    });
    mocks.spawnExecutorFireAndForget.mockImplementation(() => {
      order.push('executor-started');
    });

    const service = new TerminalsService(makeApp() as never, {} as never);
    const terminal = await service.create({ branchId: 'branch-1' as BranchID }, params as never);

    expect(mocks.joinRequestingSocket).toHaveBeenCalledWith(
      terminal.channel,
      expect.objectContaining({
        userId: 'user-1',
        terminalId: terminal.terminalId,
        branchId: 'branch-1',
      })
    );
    expect(order).toEqual(['browser-joined', 'executor-started']);
  });

  it('does not spawn or retain an attachment when the requesting socket disconnects', async () => {
    mocks.joinRequestingSocket.mockResolvedValue(false);
    const service = new TerminalsService(makeApp() as never, {} as never);

    await expect(
      service.create({ branchId: 'branch-1' as BranchID }, params as never)
    ).rejects.toThrow('owning Socket.IO connection disconnected');
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();

    mocks.joinRequestingSocket.mockResolvedValue(true);
    await expect(
      service.create({ branchId: 'branch-1' as BranchID }, params as never)
    ).resolves.toMatchObject({ isNew: true });
    expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledOnce();
  });

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
    expect(result.channel).toBe(terminalChannelName('tenant-x', 'user-1', result.terminalId));
    expect(mocks.generateTerminalExecutorToken).toHaveBeenCalledWith(
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
        daemonUrl: 'http://daemon.internal:3030',
        params: expect.objectContaining({
          terminalId: result.terminalId,
          channel: result.channel,
          cwd: '/worktrees/feature-branch',
        }),
      }),
      expect.anything()
    );
  });

  it('does not hold the authority transaction while browser subscription is pending', async () => {
    let release!: () => void;
    mocks.joinRequestingSocket.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          expect(mocks.databaseScopeDepth).toBe(0);
          release = () => resolve(true);
        })
    );
    const service = new TerminalsService(makeApp() as never, {} as never);
    const starting = service.create({ branchId: 'branch-1' as BranchID }, params as never);

    await vi.waitFor(() => expect(mocks.joinRequestingSocket).toHaveBeenCalledOnce());
    expect(mocks.databaseScopeDepth).toBe(0);
    release();
    await expect(starting).resolves.toMatchObject({ isNew: true });
  });

  it('retains no attachment or process when the final admission commit fails', async () => {
    mocks.failTransactionCall = 2;
    const service = new TerminalsService(makeApp() as never, {} as never);

    await expect(
      service.create({ branchId: 'branch-1' as BranchID }, params as never)
    ).rejects.toThrow('forced commit failure');
    expect(mocks.joinRequestingSocket).not.toHaveBeenCalled();
    expect(mocks.generateTerminalExecutorToken).not.toHaveBeenCalled();
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();

    mocks.failTransactionCall = undefined;
    await expect(
      service.create({ branchId: 'branch-1' as BranchID }, params as never)
    ).resolves.toMatchObject({ isNew: true });
  });

  it('cancels a committed reservation before spawn when authorization invalidates', async () => {
    const service = new TerminalsService(makeApp() as never, {} as never);
    mocks.joinRequestingSocket.mockImplementation(async () => {
      service.closeTenant('tenant-x');
      return true;
    });

    await expect(
      service.create({ branchId: 'branch-1' as BranchID }, params as never)
    ).rejects.toThrow('Terminal access changed');
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('captures current credentials only at the final fenced admission boundary', async () => {
    let release!: () => void;
    let reads = 0;
    mocks.resolveCurrentTenantAuthorityActor.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) await new Promise<void>((resolve) => (release = resolve));
      return {
        kind: 'human',
        user_id: 'user-1',
        role: mocks.currentRole,
        service: false,
      };
    });
    mocks.createUserProcessEnvironment.mockResolvedValue({ CREDENTIAL: 'old' });
    const service = new TerminalsService(makeApp() as never, {} as never);
    const starting = service.create({ branchId: 'branch-1' as BranchID }, params as never);
    await vi.waitFor(() =>
      expect(mocks.resolveCurrentTenantAuthorityActor).toHaveBeenCalledTimes(2)
    );

    mocks.createUserProcessEnvironment.mockResolvedValue({ CREDENTIAL: 'new' });
    release();
    await starting;

    expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ env: expect.objectContaining({ CREDENTIAL: 'new' }) })
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

  it('cancels a pending start when tenant authorization is invalidated', async () => {
    let release!: () => void;
    mocks.config = {
      daemon: { port: 3030 },
      execution: { branch_rbac: true, unix_user_mode: 'simple' },
    };
    mocks.createUserProcessEnvironment.mockImplementation(
      () => new Promise<Record<string, string>>((resolve) => (release = () => resolve({})))
    );
    const service = new TerminalsService(makeApp() as never, {} as never);
    const starting = service.create({ branchId: 'branch-1' as BranchID }, params as never);
    await vi.waitFor(() => expect(mocks.createUserProcessEnvironment).toHaveBeenCalledOnce());

    service.closeTenant('tenant-x');
    mocks.canOpen = false;
    release();

    await expect(starting).rejects.toThrow('Terminal access changed');
    expect(mocks.generateTerminalExecutorToken).not.toHaveBeenCalled();
    expect(mocks.joinRequestingSocket).not.toHaveBeenCalled();
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('rechecks the current member role at the final fenced admission boundary', async () => {
    let release!: () => void;
    let reads = 0;
    mocks.resolveCurrentTenantAuthorityActor.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) await new Promise<void>((resolve) => (release = resolve));
      return {
        kind: 'human',
        user_id: 'user-1',
        role: mocks.currentRole,
        service: false,
      };
    });
    const service = new TerminalsService(makeApp() as never, {} as never);
    const starting = service.create({ branchId: 'branch-1' as BranchID }, params as never);
    await vi.waitFor(() =>
      expect(mocks.resolveCurrentTenantAuthorityActor).toHaveBeenCalledTimes(2)
    );

    mocks.currentRole = 'guest';
    release();

    await expect(starting).rejects.toThrow(
      'Terminal access changed while the terminal was starting'
    );
    expect(mocks.joinRequestingSocket).not.toHaveBeenCalled();
    expect(mocks.generateTerminalExecutorToken).not.toHaveBeenCalled();
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
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

  it('makes missing and inaccessible branch acknowledgements indistinguishable', async () => {
    mocks.canOpen = false;
    mocks.config = {
      daemon: { port: 3030 },
      execution: { branch_rbac: true, unix_user_mode: 'simple' },
    };
    const service = new TerminalsService(makeApp() as never, {} as never);
    const inaccessible = service.create({ branchId: 'branch-1' as BranchID }, params as never);
    const missing = service.create({ branchId: 'missing' as BranchID }, params as never);
    await expect(inaccessible).rejects.toMatchObject({
      code: 404,
      className: 'not-found',
      message: 'Branch not found',
    });
    await expect(missing).rejects.toMatchObject({
      code: 404,
      className: 'not-found',
      message: 'Branch not found',
    });
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('requires filesystem access in every execution mode and forwards its level', async () => {
    mocks.config = {
      daemon: { port: 3030 },
      execution: { branch_rbac: true, unix_user_mode: 'simple' },
    };
    mocks.fsAccess = 'none';
    const denied = new TerminalsService(makeApp() as never, {} as never);
    await expect(
      denied.create({ branchId: 'branch-1' as BranchID }, params as never)
    ).rejects.toThrow('Filesystem access is required');
    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();

    mocks.fsAccess = 'read';
    const allowed = new TerminalsService(makeApp() as never, {} as never);
    await allowed.create({ branchId: 'branch-1' as BranchID }, params as never);
    expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ principalBranchAccess: 'read' }),
      }),
      expect.anything()
    );
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

  it('tenant authorization invalidation retires every stale terminal capability', async () => {
    const app = makeApp();
    const service = new TerminalsService(app as never, {} as never);
    const terminal = await service.create({ branchId: 'branch-1' as BranchID }, params as never);

    service.closeTenant('tenant-x');

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

  it('a replica-wide realtime outage retires terminal capabilities for every tenant', async () => {
    const app = makeApp();
    const service = new TerminalsService(app as never, {} as never);
    const tenantX = await service.create({ branchId: 'branch-1' as BranchID }, params as never);
    mocks.tenantId = 'tenant-y';
    const tenantY = await service.create({ branchId: 'branch-1' as BranchID }, params as never);
    const outageHandler = app.on.mock.calls.find(
      ([event]) => event === LOCAL_AUTHORIZATION_INVALIDATION_EVENT
    )?.[1] as ((data: { tenantId?: string }) => void) | undefined;

    outageHandler?.({});

    expect(outageHandler).toBeDefined();
    expect(
      service.matchesOwnedAttachment({
        terminalId: tenantX.terminalId,
        tenantId: 'tenant-x',
        userId: 'user-1',
        branchId: 'branch-1',
        ownerBootId: 'daemon-a-boot',
      })
    ).toBe(false);
    expect(
      service.matchesOwnedAttachment({
        terminalId: tenantY.terminalId,
        tenantId: 'tenant-y',
        userId: 'user-1',
        branchId: 'branch-1',
        ownerBootId: 'daemon-a-boot',
      })
    ).toBe(false);
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
