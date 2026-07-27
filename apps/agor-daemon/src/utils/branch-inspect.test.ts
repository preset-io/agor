import { describe, expect, it, vi } from 'vitest';
import { inspectBranchViaExecutor } from './branch-inspect';

const mocks = vi.hoisted(() => ({
  generateScopedServiceToken: vi.fn(() => 'service-token'),
  runExecutorCommand: vi.fn(async () => ({
    success: true,
    data: { currentSha: 'abc123', currentRef: 'main' },
  })),
}));

vi.mock('./spawn-executor.js', () => ({
  generateScopedServiceToken: mocks.generateScopedServiceToken,
  getDaemonUrl: () => 'http://localhost:3030',
  runExecutorCommand: mocks.runExecutorCommand,
}));

describe('inspectBranchViaExecutor', () => {
  it('uses one execution scope for both service token and template rendering', async () => {
    const app = { settings: { authentication: { secret: 'secret' } } };
    const executionScope = { tenantId: 'tenant-a' };

    await expect(
      inspectBranchViaExecutor(app as never, 'branch-a' as never, {
        executionScope,
        asUser: 'alice',
      })
    ).resolves.toEqual({ currentSha: 'abc123', currentRef: 'main' });

    expect(mocks.generateScopedServiceToken).toHaveBeenCalledWith(app, executionScope);
    expect(mocks.runExecutorCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'branch.inspect',
        sessionToken: 'service-token',
      }),
      expect.objectContaining({
        asUser: 'alice',
        executionScope,
      })
    );
  });
});
