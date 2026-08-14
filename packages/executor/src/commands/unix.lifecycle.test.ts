import type { BranchStorageMode } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  createExecutorClient: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  exec: mocks.exec,
  execFile: vi.fn((_file, _args, callback) => callback(null, { stdout: '', stderr: '' })),
}));

vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: mocks.createExecutorClient,
}));

import { handleUnixSyncBranch } from './unix.js';

const branchId = '019fc9dc-1dc5-7e69-b060-785569277230';
const repoId = '019fc9dc-2a17-7384-bfa7-d8b327614088';

function makeClient(
  storageMode: BranchStorageMode = 'worktree',
  branchGroup: string | null = 'agor_wt_019fc9dc'
) {
  const branch = {
    branch_id: branchId,
    repo_id: repoId,
    path: '/tenant/worktrees/repo/feature',
    storage_mode: storageMode,
    others_fs_access: 'none',
    unix_group: branchGroup,
  };
  const repo = {
    repo_id: repoId,
    local_path: '/tenant/repos/repo',
    unix_group: 'agor_rp_019fc9dc',
  };

  const branchPatch = vi.fn(async (_id: string, data: Record<string, unknown>) => {
    Object.assign(branch, data);
    return branch;
  });
  return {
    io: { disconnect: vi.fn() },
    service: vi.fn((name: string) => ({
      get: vi.fn(async () => (name === 'branches' ? branch : repo)),
      patch: name === 'branches' ? branchPatch : vi.fn(async () => repo),
      find: vi.fn(async () => []),
    })),
    branchPatch,
  };
}

describe('handleUnixSyncBranch lifecycle permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exec.mockImplementation(
      (command: string, callback: (error: Error | null, result?: unknown) => void) => {
        if (command.includes('/.git/worktrees/feature')) {
          callback(new Error('setfacl failed'));
          return;
        }
        callback(null, { stdout: '', stderr: '' });
      }
    );
  });

  it('fails closed when required worktree Git metadata permissions cannot be applied', async () => {
    mocks.createExecutorClient.mockResolvedValue(makeClient('worktree'));

    const result = await handleUnixSyncBranch(
      {
        command: 'unix.sync-branch',
        daemonUrl: 'http://daemon.test',
        sessionToken: 'tenant-scoped-token',
        params: { branchId, daemonUser: 'agor-daemon' },
      },
      {}
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: 'UNIX_SYNC_BRANCH_FAILED', message: 'setfacl failed' },
    });
  });

  it('does not require worktree metadata for clone storage', async () => {
    mocks.createExecutorClient.mockResolvedValue(makeClient('clone'));

    const result = await handleUnixSyncBranch(
      {
        command: 'unix.sync-branch',
        daemonUrl: 'http://daemon.test',
        sessionToken: 'tenant-scoped-token',
        params: { branchId, daemonUser: 'agor-daemon' },
      },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.exec).not.toHaveBeenCalledWith(
      expect.stringContaining('/.git/worktrees/feature'),
      expect.any(Function)
    );
  });

  it('uses persisted group names without regenerating or silently migrating them', async () => {
    mocks.createExecutorClient.mockResolvedValue(makeClient('clone'));

    const result = await handleUnixSyncBranch(
      {
        command: 'unix.sync-branch',
        daemonUrl: 'http://daemon.test',
        sessionToken: 'tenant-scoped-token',
        params: { branchId, daemonUser: 'agor-daemon' },
      },
      {}
    );

    expect(result).toMatchObject({ success: true, data: { groupName: 'agor_wt_019fc9dc' } });
    expect(mocks.exec).toHaveBeenCalledWith(
      expect.stringContaining('chgrp -R agor_wt_019fc9dc "/tenant/worktrees/repo/feature"'),
      expect.any(Function)
    );
    expect(mocks.exec).not.toHaveBeenCalledWith(
      expect.stringContaining('agor_wt_019fc9dc1dc57e69b0607855'),
      expect.any(Function)
    );
  });

  it('persists an absent group before any host group access', async () => {
    const client = makeClient('clone', null);
    mocks.createExecutorClient.mockResolvedValue(client);

    const result = await handleUnixSyncBranch(
      {
        command: 'unix.sync-branch',
        daemonUrl: 'http://daemon.test',
        sessionToken: 'tenant-scoped-token',
        params: { branchId, daemonUser: 'agor-daemon' },
      },
      {}
    );

    expect(client.branchPatch).toHaveBeenCalledWith(branchId, {
      unix_group: 'agor_wt_019fc9dc1dc57e69b0607855',
    });
    expect(result).toMatchObject({
      success: true,
      data: { groupName: 'agor_wt_019fc9dc1dc57e69b0607855' },
    });
    expect(client.branchPatch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.exec.mock.invocationCallOrder[0]
    );
  });

  it('retains legacy groups during tenant-scoped lifecycle cleanup', async () => {
    mocks.createExecutorClient.mockResolvedValue(makeClient('clone', 'agor_wt_019fc9dc'));

    const result = await handleUnixSyncBranch(
      {
        command: 'unix.sync-branch',
        daemonUrl: 'http://daemon.test',
        sessionToken: 'tenant-scoped-token',
        params: { branchId, daemonUser: 'agor-daemon', delete: true },
      },
      {}
    );

    expect(result).toMatchObject({
      success: true,
      data: { deleted: false, retainedLegacyGroup: true },
    });
    expect(mocks.exec).not.toHaveBeenCalledWith(
      expect.stringContaining('groupdel agor_wt_019fc9dc'),
      expect.any(Function)
    );
  });
});
