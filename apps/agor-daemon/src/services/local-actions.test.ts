import { describe, expect, it, vi } from 'vitest';
import { shouldRegisterLocalHostOperations } from '../host/availability.js';
import type { DaemonHostOperations } from '../host/operations.js';
import { createLocalActionsService } from './local-actions.js';

function host(): DaemonHostOperations {
  const result = async () => ({ logs: ['ok'] });
  return {
    identity: {
      createBranchGroup: vi.fn(result),
      deleteBranchGroup: vi.fn(result),
      addUserToGroup: vi.fn(result),
      removeUserFromGroup: vi.fn(result),
      ensureUser: vi.fn(result),
      deleteUser: vi.fn(result),
    },
  };
}

describe('local daemon host operations service', () => {
  it('validates and delegates identity operations with dry-run options', async () => {
    const operations = host();
    const service = createLocalActionsService(
      operations,
      vi.fn(async () => 'agor_wt_019ffd3d')
    );
    await expect(
      service.create({
        action: 'unix.group.addUser',
        params: { username: 'alice', group: 'agor_wt_1' },
        dryRun: true,
      })
    ).resolves.toEqual({ logs: ['ok'] });
    expect(operations.identity.addUserToGroup).toHaveBeenCalledWith({
      username: 'alice',
      group: 'agor_wt_1',
      dryRun: true,
      verbose: false,
    });
  });

  it.each([
    'unix.symlink.create',
    'unix.symlink.remove',
    'unix.symlink.cleanupBroken',
    'git.remoteCredentials.scrubManaged',
  ])('rejects removed maintenance action %s', async (action) => {
    const operations = host();
    const service = createLocalActionsService(
      operations,
      vi.fn(async () => 'agor_wt_019ffd3d')
    );
    await expect(
      service.create({
        action: action as never,
        params: {
          username: 'alice',
          branchName: 'x',
          branchPath: '/tmp/x',
          homeBase: '/srv/home',
        },
      })
    ).rejects.toThrow(/Unsupported local action/);
  });

  it('resolves a persisted branch group before crossing the host boundary', async () => {
    const operations = host();
    const resolvePersistedGroup = vi.fn(async () => 'agor_wt_019ffd3d');
    const service = createLocalActionsService(operations, resolvePersistedGroup);

    await service.create(
      {
        action: 'unix.group.createBranch',
        params: { branchId: '019ffd3d-2cef-79d1-a1c6-407300000001' },
      },
      { provider: 'rest' }
    );

    expect(resolvePersistedGroup).toHaveBeenCalledWith('019ffd3d-2cef-79d1-a1c6-407300000001', {
      provider: 'rest',
    });
    expect(operations.identity.createBranchGroup).toHaveBeenCalledWith({
      group: 'agor_wt_019ffd3d',
      dryRun: false,
      verbose: false,
    });
  });

  it('does not register local host operations in hosted mode', () => {
    expect(
      shouldRegisterLocalHostOperations({
        multi_tenancy: { mode: 'required_from_auth' },
      })
    ).toBe(false);
    expect(shouldRegisterLocalHostOperations({ multi_tenancy: { mode: 'static' } })).toBe(true);
  });
});
