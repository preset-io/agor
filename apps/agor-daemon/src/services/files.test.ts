import { getCurrentTenantDatabaseScope, runWithTenantContext } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runExecutorCommand } from '../utils/spawn-executor.js';
import { FilesService } from './files.js';

vi.mock('../utils/executor-delegated-home.js', () => ({
  resolveDelegatedExecutionHomeKey: vi.fn(async () => undefined),
}));

vi.mock('../utils/spawn-executor.js', () => ({
  generateScopedServiceToken: vi.fn(() => 'service-token'),
  getDaemonUrl: vi.fn(() => 'http://daemon.test'),
  runExecutorCommand: vi.fn(),
}));

const app = {
  get: () => ({}),
  settings: { authentication: { secret: 'test' } },
} as never;

describe('FilesService tenant scope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fails before repository access when tenant identity is missing', async () => {
    const service = new FilesService({ run: vi.fn() } as never, app);

    await expect(
      service.find({
        query: { sessionId: 'session-1' as never, search: 'readme' },
        user: { user_id: 'user-1', email: 'member@example.com', role: 'member' },
      })
    ).rejects.toThrow('Missing active tenant context for files database access');
    expect(runExecutorCommand).not.toHaveBeenCalled();
  });

  it('uses RBAC-preloaded records in a short database scope and executes afterward', async () => {
    vi.mocked(runExecutorCommand).mockImplementation(async () => {
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      return { success: true, data: { results: [] } };
    });
    const service = new FilesService({ run: vi.fn() } as never, app);

    await runWithTenantContext('tenant-a', () =>
      service.find({
        query: { sessionId: 'session-1' as never, search: 'readme' },
        session: { session_id: 'session-1', branch_id: 'branch-1' },
        branch: { branch_id: 'branch-1', path: '/tenant-a/branch-1' },
      } as never)
    );

    expect(runExecutorCommand).toHaveBeenCalledOnce();
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
    expect(runExecutorCommand).not.toHaveBeenCalled();
  });
});
