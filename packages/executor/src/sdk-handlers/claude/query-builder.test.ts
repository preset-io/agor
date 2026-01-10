import type { SessionID, WorktreeID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock minimal dependencies
vi.mock('@agor/core', () => ({ validateDirectory: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@agor/core/sdk', () => ({ Claude: { query: vi.fn() } }));
vi.mock('@agor/core/templates/session-context', () => ({
  renderAgorSystemPrompt: vi.fn().mockResolvedValue('prompt'),
}));
vi.mock('../../config.js', () => ({
  getDaemonUrl: vi.fn().mockResolvedValue('http://localhost:3030'),
  resolveUserEnvironment: vi.fn().mockReturnValue({ env: {} }),
}));

import { Claude } from '@agor/core/sdk';
import { type QuerySetupDeps, setupQuery } from './query-builder.js';

describe('setupQuery - Local Settings Support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Claude.query).mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
      interrupt: () => Promise.resolve(),
    } as any);
  });

  function createMockDeps(): QuerySetupDeps {
    return {
      sessionsRepo: {
        findById: vi.fn().mockResolvedValue({
          session_id: 'test-session' as SessionID,
          worktree_id: 'test-worktree' as WorktreeID,
        }),
      } as any,
      worktreesRepo: {
        findById: vi.fn().mockResolvedValue({ path: '/test/project/path' }),
      } as any,
      permissionLocks: new Map(),
    };
  }

  it('includes "local" in the SDK settingSources', async () => {
    const deps = createMockDeps();

    await setupQuery('test-session' as SessionID, 'test prompt', deps);

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];

    // This is the core test for your feature:
    // It ensures 'local' is passed alongside 'user' and 'project'
    expect(callArgs.options.settingSources).toContain('local');
    expect(callArgs.options.settingSources).toEqual(
      expect.arrayContaining(['user', 'project', 'local'])
    );
  });
});
