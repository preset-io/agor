import { getCurrentTenantDatabaseScope, runWithTenantContext } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runExecutorCommand } from '../utils/spawn-executor.js';
import { FileService } from './file.js';

const impersonationMocks = vi.hoisted(() => ({
  resolveExecutorReadAsUser: vi.fn(),
}));

vi.mock('../utils/executor-read-impersonation.js', () => ({
  resolveExecutorReadAsUser: impersonationMocks.resolveExecutorReadAsUser,
}));

vi.mock('../utils/spawn-executor.js', () => ({
  generateScopedServiceToken: vi.fn(() => 'service-token'),
  getDaemonUrl: vi.fn(() => 'http://daemon.test'),
  runExecutorCommand: vi.fn(),
}));

describe('FileService executor failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    impersonationMocks.resolveExecutorReadAsUser.mockResolvedValue(undefined);
  });

  it('does not report executor failure as an empty repository', async () => {
    vi.mocked(runExecutorCommand).mockResolvedValue({
      success: false,
      error: { code: 'EXECUTOR_FAILED', message: 'executor unavailable' },
    });
    const service = new FileService(
      { findById: vi.fn().mockResolvedValue({ branch_id: 'branch-1' }) } as never,
      { run: vi.fn() } as never,
      { get: () => ({}), settings: { authentication: { secret: 'test' } } } as never
    );

    await expect(
      service.find({
        query: { branch_id: 'branch-1' },
        user: {
          user_id: 'user-1',
          email: 'member@example.com',
          role: 'member',
        },
      })
    ).rejects.toThrow('Failed to browse files: executor unavailable');
  });

  it.each([
    {
      operation: 'listing',
      invoke: (service: FileService, params: Parameters<FileService['find']>[0]) =>
        service.find(params),
      command: 'branch.files.browse',
      data: { files: [] },
    },
    {
      operation: 'reading/preview',
      invoke: (service: FileService, params: Parameters<FileService['get']>[1]) =>
        service.get('README.md', params),
      command: 'branch.files.read',
      data: {
        file: {
          path: 'README.md',
          title: 'README',
          size: 0,
          lastModified: '2026-07-30T00:00:00.000Z',
          isText: true,
          mimeType: 'text/markdown',
          content: '',
          encoding: 'utf-8',
        },
      },
    },
  ])(
    'passes the resolved execution-substrate identity through file $operation',
    async ({ invoke, command, data }) => {
      impersonationMocks.resolveExecutorReadAsUser.mockResolvedValue('alice');
      vi.mocked(runExecutorCommand).mockResolvedValue({ success: true, data });
      const service = new FileService(
        { findById: vi.fn().mockResolvedValue({ branch_id: 'branch-1' }) } as never,
        { run: vi.fn() } as never,
        { get: () => ({}), settings: { authentication: { secret: 'test' } } } as never
      );
      const params = {
        query: { branch_id: 'branch-1' },
        user: {
          user_id: 'user-1',
          email: 'member@example.com',
          role: 'member' as const,
        },
      };

      await invoke(service, params);

      expect(runExecutorCommand).toHaveBeenCalledWith(
        expect.objectContaining({ command }),
        expect.objectContaining({ asUser: 'alice' })
      );
    }
  );

  it('scopes database reads but leaves executor work outside the transaction', async () => {
    const db = { run: vi.fn() } as never;
    const findById = vi.fn(async () => {
      expect(getCurrentTenantDatabaseScope()?.tenantId).toBe('tenant-a');
      return { branch_id: 'branch-1' };
    });
    impersonationMocks.resolveExecutorReadAsUser.mockImplementation(async () => {
      expect(getCurrentTenantDatabaseScope()?.tenantId).toBe('tenant-a');
      return 'alice';
    });
    vi.mocked(runExecutorCommand).mockImplementation(async () => {
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      return { success: true, data: { files: [] } };
    });
    const service = new FileService({ findById } as never, db, {
      get: () => ({}),
      settings: { authentication: { secret: 'test' } },
    } as never);

    await runWithTenantContext('tenant-a', () =>
      service.find({
        query: { branch_id: 'branch-1' },
        user: { user_id: 'user-1', email: 'member@example.com', role: 'member' },
      })
    );

    expect(findById).toHaveBeenCalledOnce();
    expect(runExecutorCommand).toHaveBeenCalledOnce();
  });
});
