import type { BranchID, SessionID, TaskID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock minimal dependencies
vi.mock('@agor/core', () => ({
  validateDirectory: vi.fn().mockResolvedValue(undefined),
  // shortId is used in log lines inside query-builder; passthrough mock.
  shortId: vi.fn((id: string) => id),
}));
vi.mock('@agor/core/sdk', () => ({ Claude: { query: vi.fn() } }));
vi.mock('@agor/core/templates/session-context', () => ({
  renderAgorSystemPrompt: vi.fn().mockResolvedValue('prompt'),
}));
vi.mock('@agor/core/tools/mcp/http-headers', () => ({
  mergeMCPRemoteHeaders: vi.fn(({ custom, auth }) => ({ ...(custom || {}), ...(auth || {}) })),
}));
vi.mock('@agor/core/tools/mcp/jwt-auth', () => ({
  resolveMCPAuthHeaders: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../config.js', () => ({
  getDaemonUrl: vi.fn().mockResolvedValue('http://localhost:3030'),
  resolveUserEnvironment: vi.fn().mockReturnValue({ env: {} }),
}));
vi.mock('../base/mcp-scoping.js', () => ({
  getMcpServersForSession: vi.fn().mockResolvedValue([]),
}));
vi.mock('./models.js', () => ({
  DEFAULT_CLAUDE_MODEL: 'claude-sonnet-4-6',
}));
vi.mock('./model-utils.js', () => ({
  parseModelWithBetas: vi.fn((model: string) => ({
    model: model.replace('[1m]', ''),
    betas: model.includes('[1m]') ? ['context-1m-2025-08-07'] : [],
  })),
}));
vi.mock('./permissions/permission-hooks.js', () => ({
  createCanUseToolCallback: vi.fn(
    () => () => Promise.resolve({ behavior: 'allow', updatedInput: {} })
  ),
}));

import { Claude } from '@agor/core/sdk';
import { resolveMCPAuthHeaders } from '@agor/core/tools/mcp/jwt-auth';
import { getMcpServersForSession } from '../base/mcp-scoping.js';
import { CLAUDE_CODE_DISALLOWED_TOOLS } from './constants.js';
import { formatListForLog, type QuerySetupDeps, setupQuery } from './query-builder.js';

describe('MCP logging helpers', () => {
  it('formats long server lists without dumping every entry', () => {
    expect(formatListForLog(['a', 'b', 'c'], 5)).toBe('a, b, c');
    expect(formatListForLog(['a', 'b', 'c', 'd'], 2)).toBe('a, b +2 more');
  });
});

describe('setupQuery - Local Settings Support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMcpServersForSession).mockResolvedValue([]);
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
          branch_id: 'test-branch' as BranchID,
        }),
      } as any,
      branchesRepo: {
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
  // (e.g. dropping `ExitBranch`) trips this test, not just the plumbing one.
  // See `constants.ts` for why each name is on the list — #1177 covers
  // AskUserQuestion; the rest were operator-approved at the same time.
  // `ScheduleWakeup` added in #1253 (Agor schedules supersede /loop).
  it('locks the disallowed-tools list to the operator-approved names', () => {
    expect(CLAUDE_CODE_DISALLOWED_TOOLS).toEqual([
      'AskUserQuestion',
      'ExitPlanMode',
      'EnterBranch',
      'ExitBranch',
      'ScheduleWakeup',
    ]);
  });

  // Plumbing: whatever's in the constant must reach the SDK.
  it('passes the Claude Code disallowed-tools list to the SDK', async () => {
    const deps = createMockDeps();

    await setupQuery('test-session' as SessionID, 'test prompt', deps);

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    expect(callArgs.options.disallowedTools).toEqual([...CLAUDE_CODE_DISALLOWED_TOOLS]);
  });

  it('blocks on MCP startup for gateway sessions', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.sessionsRepo.findById).mockResolvedValue({
      session_id: 'test-session' as SessionID,
      branch_id: 'test-branch' as BranchID,
      mcp_token: 'test-token',
      custom_context: { gateway_source: { channel_id: 'channel-1' } },
    } as any);
    deps.sessionMCPRepo = {} as any;
    deps.mcpServerRepo = {} as any;
    vi.mocked(getMcpServersForSession).mockResolvedValue([
      {
        server: {
          name: 'remote',
          transport: 'http',
          url: 'https://example.com/mcp',
        },
      } as any,
    ]);

    await setupQuery('test-session' as SessionID, 'test prompt', deps);

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    const mcpServers = callArgs.options.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcpServers.agor).toMatchObject({ alwaysLoad: true });
    expect(mcpServers.remote).toMatchObject({ alwaysLoad: true });
  });

  it('keeps MCP startup lazy for non-gateway sessions', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.sessionsRepo.findById).mockResolvedValue({
      session_id: 'test-session' as SessionID,
      branch_id: 'test-branch' as BranchID,
      mcp_token: 'test-token',
    } as any);
    deps.sessionMCPRepo = {} as any;
    deps.mcpServerRepo = {} as any;
    vi.mocked(getMcpServersForSession).mockResolvedValue([
      {
        server: {
          name: 'remote',
          transport: 'http',
          url: 'https://example.com/mcp',
        },
      } as any,
    ]);

    await setupQuery('test-session' as SessionID, 'test prompt', deps);

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    const mcpServers = callArgs.options.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcpServers.agor.alwaysLoad).toBeUndefined();
    expect(mcpServers.remote.alwaysLoad).toBeUndefined();
  });

  it('does not block gateway startup on unauthenticated OAuth servers with custom headers', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.sessionsRepo.findById).mockResolvedValue({
      session_id: 'test-session' as SessionID,
      branch_id: 'test-branch' as BranchID,
      mcp_token: 'test-token',
      custom_context: { gateway_source: { channel_id: 'channel-1' } },
    } as any);
    deps.sessionMCPRepo = {} as any;
    deps.mcpServerRepo = {} as any;
    vi.mocked(resolveMCPAuthHeaders).mockResolvedValue(undefined);
    vi.mocked(getMcpServersForSession).mockResolvedValue([
      {
        server: {
          name: 'oauthRemote',
          transport: 'http',
          url: 'https://example.com/mcp',
          auth: { type: 'oauth' },
          headers: { 'X-Tenant': 'tenant-1' },
        },
      } as any,
    ]);

    await setupQuery('test-session' as SessionID, 'test prompt', deps);

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    const mcpServers = callArgs.options.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcpServers.agor).toMatchObject({ alwaysLoad: true });
    expect(mcpServers.oauthRemote).toMatchObject({
      headers: { 'X-Tenant': 'tenant-1' },
    });
    expect(mcpServers.oauthRemote.alwaysLoad).toBeUndefined();
  });

  it('does not block gateway startup on remote Bearer or JWT servers without resolved auth', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.sessionsRepo.findById).mockResolvedValue({
      session_id: 'test-session' as SessionID,
      branch_id: 'test-branch' as BranchID,
      mcp_token: 'test-token',
      custom_context: { gateway_source: { channel_id: 'channel-1' } },
    } as any);
    deps.sessionMCPRepo = {} as any;
    deps.mcpServerRepo = {} as any;
    vi.mocked(resolveMCPAuthHeaders).mockResolvedValue(undefined);
    vi.mocked(getMcpServersForSession).mockResolvedValue([
      {
        server: {
          name: 'bearerRemote',
          transport: 'http',
          url: 'https://bearer.example.com/mcp',
          auth: { type: 'bearer' },
        },
      } as any,
      {
        server: {
          name: 'jwtRemote',
          transport: 'http',
          url: 'https://jwt.example.com/mcp',
          auth: { type: 'jwt' },
        },
      } as any,
    ]);

    await setupQuery('test-session' as SessionID, 'test prompt', deps);

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    const mcpServers = callArgs.options.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcpServers.agor).toMatchObject({ alwaysLoad: true });
    expect(mcpServers.bearerRemote.alwaysLoad).toBeUndefined();
    expect(mcpServers.jwtRemote.alwaysLoad).toBeUndefined();
  });

  it('passes session advisorModel through the --advisor CLI flag, NOT settings', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.sessionsRepo.findById).mockResolvedValue({
      session_id: 'test-session' as SessionID,
      branch_id: 'test-branch' as BranchID,
      model_config: {
        mode: 'alias',
        model: 'claude-sonnet-4-6',
        updated_at: '2026-06-11T00:00:00.000Z',
        advisorModel: 'opus',
      },
    } as any);

    await setupQuery('test-session' as SessionID, 'test prompt', deps);

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    // The advisor goes through the SDK's extraArgs → `--advisor opus`.
    expect(callArgs.options.extraArgs).toMatchObject({ advisor: 'opus' });
    // EACCES regression guard: we must NOT pass `settings` as an object, which
    // makes the CLI materialize a content-addressed /tmp/claude-settings-*.json
    // that collides across sessions/users (EACCES on open). See query-builder.ts.
    expect(callArgs.options.settings).toBeUndefined();
  });

  it('strips advisorModel [1m] suffix, passes base model via --advisor, adds the SDK beta', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.sessionsRepo.findById).mockResolvedValue({
      session_id: 'test-session' as SessionID,
      branch_id: 'test-branch' as BranchID,
      model_config: {
        mode: 'alias',
        model: 'claude-sonnet-4-6',
        updated_at: '2026-06-11T00:00:00.000Z',
        advisorModel: 'claude-opus-4-7[1m]',
      },
    } as any);

    await setupQuery('test-session' as SessionID, 'test prompt', deps);

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    expect(callArgs.options.extraArgs).toMatchObject({ advisor: 'claude-opus-4-7' });
    expect(callArgs.options.settings).toBeUndefined();
    expect(callArgs.options.betas).toEqual(['context-1m-2025-08-07']);
  });

  it('omits --advisor (and settings) entirely when no advisorModel is set', async () => {
    // Turn-off contract: clearing the advisor leaves no --advisor flag and no
    // settings object, so the session starts exactly as it did pre-advisor.
    const deps = createMockDeps();
    vi.mocked(deps.sessionsRepo.findById).mockResolvedValue({
      session_id: 'test-session' as SessionID,
      branch_id: 'test-branch' as BranchID,
      model_config: {
        mode: 'alias',
        model: 'claude-sonnet-4-6',
        updated_at: '2026-06-11T00:00:00.000Z',
        // no advisorModel
      },
    } as any);

    await setupQuery('test-session' as SessionID, 'test prompt', deps);

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    expect(
      (callArgs.options.extraArgs as Record<string, unknown> | undefined)?.advisor
    ).toBeUndefined();
    expect(callArgs.options.settings).toBeUndefined();
  });

  it('ignores a whitespace-only advisorModel (no --advisor, no settings)', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.sessionsRepo.findById).mockResolvedValue({
      session_id: 'test-session' as SessionID,
      branch_id: 'test-branch' as BranchID,
      model_config: {
        mode: 'alias',
        model: 'claude-sonnet-4-6',
        updated_at: '2026-06-11T00:00:00.000Z',
        advisorModel: '   ',
      },
    } as any);

    await setupQuery('test-session' as SessionID, 'test prompt', deps);

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    expect(
      (callArgs.options.extraArgs as Record<string, unknown> | undefined)?.advisor
    ).toBeUndefined();
    expect(callArgs.options.settings).toBeUndefined();
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
          branch_id: 'test-branch' as BranchID,
        }),
      } as any,
      branchesRepo: {
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
