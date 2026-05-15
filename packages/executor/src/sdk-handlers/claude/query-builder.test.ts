import type { SessionID, TaskID, WorktreeID } from '@agor/core/types';
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
import { CLAUDE_CODE_DISALLOWED_TOOLS } from './constants.js';
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

  // Pin the literal disallow list so a stray edit to the constant
  // (e.g. dropping `ExitWorktree`) trips this test, not just the plumbing one.
  // See `constants.ts` for why each name is on the list — #1177 covers
  // AskUserQuestion; the rest were operator-approved at the same time.
  it('locks the disallowed-tools list to the four operator-approved names', () => {
    expect(CLAUDE_CODE_DISALLOWED_TOOLS).toEqual([
      'AskUserQuestion',
      'ExitPlanMode',
      'EnterWorktree',
      'ExitWorktree',
    ]);
  });

  // Plumbing: whatever's in the constant must reach the SDK.
  it('passes the Claude Code disallowed-tools list to the SDK', async () => {
    const deps = createMockDeps();

    await setupQuery('test-session' as SessionID, 'test prompt', deps);

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    expect(callArgs.options.disallowedTools).toEqual([...CLAUDE_CODE_DISALLOWED_TOOLS]);
  });
});

describe('setupQuery - canUseTool registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Claude.query).mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
      interrupt: () => Promise.resolve(),
    } as any);
  });

  function createPermissionDeps(): QuerySetupDeps {
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
      messagesRepo: {} as any,
      sessionMCPRepo: {} as any,
      mcpServerRepo: {} as any,
      permissionService: {} as any,
      tasksService: {} as any,
      messagesService: {} as any,
      sessionsService: {} as any,
      permissionLocks: new Map(),
    };
  }

  // With AskUserQuestion now disallowed (#1177), the SDK no longer needs
  // canUseTool registered in bypass mode — the previous workaround that
  // forced registration to intercept AskUserQuestion is gone. Bypass mode
  // should now skip canUseTool entirely, matching SDK semantics.
  it('does not register canUseTool when permissionMode is "bypassPermissions"', async () => {
    const deps = createPermissionDeps();

    await setupQuery('test-session' as SessionID, 'test prompt', deps, {
      taskId: 'test-task' as TaskID,
      permissionMode: 'bypassPermissions',
    });

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    expect(callArgs.options.canUseTool).toBeUndefined();
    expect(callArgs.options.permissionMode).toBe('bypassPermissions');
  });

  it('registers canUseTool in default permission mode', async () => {
    const deps = createPermissionDeps();

    await setupQuery('test-session' as SessionID, 'test prompt', deps, {
      taskId: 'test-task' as TaskID,
      permissionMode: 'default',
    });

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    expect(callArgs.options.canUseTool).toBeTypeOf('function');
  });

  it('does not register canUseTool when required deps are missing (no taskId)', async () => {
    const deps = createPermissionDeps();

    await setupQuery('test-session' as SessionID, 'test prompt', deps, {
      permissionMode: 'bypassPermissions',
      // no taskId
    });

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    expect(callArgs.options.canUseTool).toBeUndefined();
  });
});
