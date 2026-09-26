import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMcpCallerSandboxMounts } from './caller-sandbox-mounts.js';
import type { McpContext } from './server.js';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({ sandboxHomeStore: '/data/tenants/tenant-a/homes/caller' })),
  scopedDb: { scoped: true },
}));

vi.mock('../utils/branch-executor-sandbox.js', () => ({
  resolveBranchExecutorSandboxMounts: mocks.resolve,
}));
vi.mock('./tenant-scope.js', () => ({
  runWithMcpTenantDatabaseScope: async (_ctx: unknown, work: (db: unknown) => unknown) =>
    work(mocks.scopedDb),
}));

const branch = { repo_id: 'repo-1', storage_mode: 'worktree' } as const;
const perUserSandbox = { execution: { sandbox: { enabled: true, home_mode: 'per_user' } } };

function ctx(config: unknown, tenantId?: string): McpContext {
  return {
    app: { get: () => config },
    userId: 'caller',
    baseServiceParams: tenantId ? { tenant: { tenant_id: tenantId } } : {},
  } as unknown as McpContext;
}

describe('resolveMcpCallerSandboxMounts', () => {
  beforeEach(() => mocks.resolve.mockClear());

  it('resolves the caller home in the MCP tenant scope', async () => {
    await expect(
      resolveMcpCallerSandboxMounts(ctx(perUserSandbox, 'tenant-a'), branch)
    ).resolves.toEqual({ sandboxHomeStore: '/data/tenants/tenant-a/homes/caller' });
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        executionUserId: 'caller',
        branch,
        db: mocks.scopedDb,
      })
    );
  });

  it('skips resolution when the sandbox is disabled', async () => {
    await expect(resolveMcpCallerSandboxMounts(ctx({}), branch)).resolves.toEqual({});
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('fails closed without trusted tenant identity', async () => {
    await expect(resolveMcpCallerSandboxMounts(ctx(perUserSandbox), branch)).rejects.toThrow(
      'Trusted tenant context is required'
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
