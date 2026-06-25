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
    branchesById: new Map<string, typeof branch>([[branch.branch_id, branch]]),
    execSync: vi.fn((cmd: string) => {
      if (cmd === 'which zellij') return Buffer.from('/usr/bin/zellij\n');
      throw new Error('not found');
    }),
    spawnExecutorFireAndForget: vi.fn(),
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
    async findById(branchId: string) {
      return mocks.branchesById.get(branchId) ?? null;
    }
    async isOwner() {
      return true;
    }
  },
  SessionRepository: class {},
  UsersRepository: class {
    async findById() {
      return { unix_username: 'alice' };
    }
  },
  shortId: (id: string) => id.slice(0, 8),
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

    const second = await service.create(
      { branchId: secondBranch.branch_id, rows: 24, cols: 80 },
      params as never
    );

    expect(second).toMatchObject({
      isNew: false,
      branchName: 'same-name',
    });
    expect(app.emit).toHaveBeenCalledWith('terminal:tab', {
      userId: params.user.user_id,
      action: 'create',
      tabName: 'same-name · 22222222',
      cwd: secondBranch.path,
    });
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
