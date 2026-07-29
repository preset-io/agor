import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runExecutorCommand } from '../utils/spawn-executor.js';
import { FileService } from './file.js';

vi.mock('../utils/executor-read-impersonation.js', () => ({
  resolveExecutorReadAsUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/spawn-executor.js', () => ({
  generateScopedServiceToken: vi.fn(() => 'service-token'),
  getDaemonUrl: vi.fn(() => 'http://daemon.test'),
  runExecutorCommand: vi.fn(),
}));

describe('FileService executor failures', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not report executor failure as an empty repository', async () => {
    vi.mocked(runExecutorCommand).mockResolvedValue({
      success: false,
      error: { code: 'EXECUTOR_FAILED', message: 'executor unavailable' },
    });
    const service = new FileService(
      { findById: vi.fn().mockResolvedValue({ branch_id: 'branch-1' }) } as never,
      null as never,
      { settings: { authentication: { secret: 'test' } } } as never
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
});
