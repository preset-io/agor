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
    maintenance: {
      createHomeSymlink: vi.fn(result),
      removeHomeSymlink: vi.fn(result),
      cleanupHomeSymlinks: vi.fn(result),
      scrubManagedGitRemotes: vi.fn(result),
    },
  };
}

describe('local daemon host operations service', () => {
  it('validates and delegates identity operations with dry-run options', async () => {
    const operations = host();
    const service = createLocalActionsService(operations);
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

  it('keeps maintenance capabilities separate and validates managed homes', async () => {
    const operations = host();
    const service = createLocalActionsService(operations);
    await expect(
      service.create({
        action: 'unix.symlink.create',
        params: {
          username: 'alice',
          branchName: 'x',
          branchPath: '/tmp/x',
          homeBase: '/srv/home',
        },
      })
    ).rejects.toThrow(/managed Agor home base/);
    expect(operations.maintenance.createHomeSymlink).not.toHaveBeenCalled();
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
