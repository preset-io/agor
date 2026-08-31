import {
  BranchRepository,
  getCurrentTenantDatabaseScope,
  runWithTenantContext,
} from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestExecutor } from '../utils/spawn-executor.js';
import { FilesService } from './files.js';

vi.mock('../utils/executor-delegated-home.js', () => ({
  resolveDelegatedExecutionHomeKey: vi.fn(async () => undefined),
}));

vi.mock('../utils/spawn-executor.js', () => ({
  getDaemonUrl: vi.fn(() => 'http://daemon.test'),
  requestExecutor: vi.fn(),
}));

const app = {
  get: () => ({}),
  sessionTokenService: { generateCommandToken: vi.fn(async () => 'user-token') },
  settings: { authentication: { secret: 'test' } },
} as never;

describe('FilesService tenant scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(BranchRepository.prototype, 'resolveUserAccess').mockResolvedValue({
      can: 'view',
      fs_access: 'read',
      is_owner: false,
      source: 'others',
    });
  });

  it('fails before repository access when tenant identity is missing', async () => {
    const service = new FilesService({ run: vi.fn() } as never, app);

    await expect(
      service.find({
        query: { sessionId: 'session-1' as never, search: 'readme' },
        user: { user_id: 'user-1', email: 'member@example.com', role: 'member' },
      })
    ).rejects.toThrow('Missing active tenant context for files database access');
    expect(requestExecutor).not.toHaveBeenCalled();
  });

  it('uses RBAC-preloaded records in a short database scope and executes afterward', async () => {
    vi.mocked(requestExecutor).mockImplementation(async () => {
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      return { success: true, data: { results: [] } };
    });
    const service = new FilesService({ run: vi.fn() } as never, app);

    await runWithTenantContext('tenant-a', () =>
      service.find({
        query: { sessionId: 'session-1' as never, search: 'readme' },
        session: { session_id: 'session-1', branch_id: 'branch-1' },
        branch: { branch_id: 'branch-1', path: '/tenant-a/branch-1' },
        user: { user_id: 'user-1', email: 'member@example.com', role: 'member' },
      } as never)
    );

    expect(requestExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'branch.files.list',
        params: expect.objectContaining({
          cwd: '/tenant-a/branch-1',
          principalBranchAccess: 'read',
        }),
      }),
      expect.objectContaining({
        templateVariables: {
          branch_id: 'branch-1',
          user_id: 'user-1',
          branch_fs_access: 'read',
        },
      })
    );
  });

  it('does not swallow a conflicting tenant scope as empty autocomplete', async () => {
    const service = new FilesService({ run: vi.fn() } as never, app);

    await runWithTenantContext('tenant-a', async () => {
      expect(() =>
        runWithTenantContext('tenant-b', () =>
          service.find({
            query: { sessionId: 'session-1' as never, search: 'readme' },
          })
        )
      ).toThrow('Cannot enter tenant context tenant-b');
    });
    expect(requestExecutor).not.toHaveBeenCalled();
  });

  it('does not expose autocomplete results without normalized filesystem read access', async () => {
    vi.spyOn(BranchRepository.prototype, 'resolveUserAccess').mockResolvedValue({
      can: 'view',
      fs_access: 'none',
      is_owner: false,
      source: 'others',
    });
    const service = new FilesService({ run: vi.fn() } as never, app);

    await expect(
      runWithTenantContext('tenant-a', () =>
        service.find({
          query: { sessionId: 'session-1' as never, search: 'readme' },
          session: { session_id: 'session-1', branch_id: 'branch-1' },
          branch: { branch_id: 'branch-1', path: '/tenant-a/branch-1' },
          user: { user_id: 'user-1', email: 'member@example.com', role: 'member' },
        } as never)
      )
    ).rejects.toThrow('branch filesystem read access required');
    expect(requestExecutor).not.toHaveBeenCalled();
  });
});
