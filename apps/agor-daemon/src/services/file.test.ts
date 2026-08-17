import { getCurrentTenantDatabaseScope, runWithTenantContext } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runExecutorCommand } from '../utils/spawn-executor.js';
import { FileService, resolveRestFilePath } from './file.js';

describe('resolveRestFilePath', () => {
  it('decodes a REST-provided id, recovering a nested path from its encoded slash', () => {
    const encoded = encodeURIComponent('qa-evidence/pr-ready/screenshot.png');
    expect(resolveRestFilePath(encoded, { provider: 'rest' } as never)).toBe(
      'qa-evidence/pr-ready/screenshot.png'
    );
  });

  it('leaves a non-REST id untouched, since only REST clients percent-encode it', () => {
    // Socket.IO (and internal/no-provider) calls pass the plain path directly —
    // decoding here would wrongly mangle a real "%" in a filename.
    expect(resolveRestFilePath('100%.txt', { provider: 'socketio' } as never)).toBe('100%.txt');
    expect(resolveRestFilePath('100%.txt', undefined)).toBe('100%.txt');
  });

  it('round-trips a root-level filename with no path separators', () => {
    expect(resolveRestFilePath('README.md', { provider: 'rest' } as never)).toBe('README.md');
  });

  it('raises a clean BadRequest instead of an uncaught URIError on malformed REST percent-encoding', () => {
    expect(() => resolveRestFilePath('%c3%28', { provider: 'rest' } as never)).toThrow(BadRequest);
    expect(() => resolveRestFilePath('%', { provider: 'rest' } as never)).toThrow(BadRequest);
  });

  it('never throws for malformed percent-sequences arriving over a non-REST provider', () => {
    // Socket.IO/internal callers never percent-encode, so a literal '%c3%28'
    // filename is passed through untouched rather than rejected.
    expect(resolveRestFilePath('%c3%28', { provider: 'socketio' } as never)).toBe('%c3%28');
  });
});

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
      runWithTenantContext('tenant-a', () =>
        service.find({
          query: { branch_id: 'branch-1' },
          user: {
            user_id: 'user-1',
            email: 'member@example.com',
            role: 'member',
          },
        })
      )
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

      await runWithTenantContext('tenant-a', () => invoke(service, params));

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

  it('fails before repository access when tenant identity is missing', async () => {
    const findById = vi.fn();
    const service = new FileService(
      { findById } as never,
      { run: vi.fn() } as never,
      {
        get: () => ({}),
        settings: { authentication: { secret: 'test' } },
      } as never
    );

    await expect(
      service.find({
        query: { branch_id: 'branch-1' },
        user: { user_id: 'user-1', email: 'member@example.com', role: 'member' },
      })
    ).rejects.toThrow('Missing active tenant context for file database access');
    expect(findById).not.toHaveBeenCalled();
  });

  it('reuses the branch authorized by the registered RBAC preload', async () => {
    const findById = vi.fn();
    vi.mocked(runExecutorCommand).mockResolvedValue({ success: true, data: { files: [] } });
    const service = new FileService(
      { findById } as never,
      { run: vi.fn() } as never,
      {
        get: () => ({}),
        settings: { authentication: { secret: 'test' } },
      } as never
    );

    await runWithTenantContext('tenant-a', () =>
      service.find({
        query: { branch_id: 'branch-1' },
        branch: { branch_id: 'branch-1', path: '/tenant-a/branch-1' },
        user: { user_id: 'user-1', email: 'member@example.com', role: 'member' },
      } as never)
    );

    expect(findById).not.toHaveBeenCalled();
    expect(runExecutorCommand).toHaveBeenCalledOnce();
  });
});
