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

  it.each([
    'unix.symlink.create',
    'unix.symlink.remove',
    'unix.symlink.cleanupBroken',
    'git.remoteCredentials.scrubManaged',
  ])('rejects removed maintenance action %s', async (action) => {
    const operations = host();
    const service = createLocalActionsService(operations);
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

  it('does not register local host operations in hosted mode', () => {
    expect(
      shouldRegisterLocalHostOperations({
        multi_tenancy: { mode: 'required_from_auth' },
      })
    ).toBe(false);
    expect(shouldRegisterLocalHostOperations({ multi_tenancy: { mode: 'static' } })).toBe(true);
  });
});
