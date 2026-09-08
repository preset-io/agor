import type { BranchID, SessionID, TaskID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mcpAuthMocks = vi.hoisted(() => ({ resolveMCPAuthHeaders: vi.fn() }));
const claudeSdkMocks = vi.hoisted(() => ({ query: vi.fn() }));

// Mock minimal dependencies
vi.mock('@agor/core/lib/validation', () => ({
  validateDirectory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@agor/core/db', () => ({
  // shortId is used in log lines inside query-builder; passthrough mock.
  shortId: vi.fn((id: string) => id),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => claudeSdkMocks);
vi.mock('@agor/core/agentic-integrations', () => ({
  loadManagedAgenticToolSdk: vi.fn(async () => claudeSdkMocks),
}));
vi.mock('@agor/core/templates/session-context', () => ({
  renderAgorSystemPrompt: vi.fn().mockResolvedValue('prompt'),
}));
vi.mock('@agor/core/tools/mcp/http-headers', () => ({
  mergeMCPRemoteHeaders: vi.fn(({ custom, auth }) => ({ ...(custom || {}), ...(auth || {}) })),
}));
vi.mock('@agor/core/tools/mcp/jwt-auth', () => mcpAuthMocks);
vi.mock('../../config.js', () => ({
  getDaemonUrl: vi.fn().mockResolvedValue('http://localhost:3030'),
}));
vi.mock('@agor/core/mcp', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/mcp')>('@agor/core/mcp');
  return {
    ...actual,
    getMcpServersForSession: vi.fn().mockResolvedValue([]),
    resolveScopedMCPAuthHeaders: vi.fn(({ server }) =>
      mcpAuthMocks.resolveMCPAuthHeaders(server.auth, server.url)
    ),
  };
});
vi.mock('./models.js', () => ({
  DEFAULT_CLAUDE_MODEL: 'claude-sonnet-4-6',
}));
vi.mock('../base/permission-hooks.js', () => ({
  createCanUseToolCallback: vi.fn(
    () => () => Promise.resolve({ behavior: 'allow', updatedInput: {} })
  ),
}));

import { getMcpServersForSession } from '@agor/core/mcp';
import { resolveMCPAuthHeaders } from '@agor/core/tools/mcp/jwt-auth';
import * as Claude from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_CODE_DISALLOWED_TOOLS, CLAUDE_CODE_TODO_TOOLS } from './constants.js';
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
    vi.mocked(resolveMCPAuthHeaders).mockResolvedValue(undefined);
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

  it.each([
    [{ kind: 'human' as const }, { kind: 'human' }],
    [
      { kind: 'channel' as const, server: 'slack' },
      { kind: 'channel', server: 'slack' },
    ],
    [undefined, undefined],
  ])('passes only daemon-derived prompt origin to the SDK (%j)', async (promptOrigin, expected) => {
    const setup = await setupQuery('test-session' as SessionID, 'test prompt', createMockDeps(), {
      promptOrigin,
    });
    const prompt = vi.mocked(Claude.query).mock.calls[0][0].prompt;
    expect(typeof prompt).not.toBe('string');

    const first = await (prompt as AsyncIterable<Record<string, unknown>>)
      [Symbol.asyncIterator]()
      .next();
    if (expected) {
      expect(first.value).toMatchObject({ origin: expected });
    } else {
      expect(first.value).not.toHaveProperty('origin');
    }
    setup.query.releaseInput();
  });

  it('logs only the generic prompt start and passes resume and prompt data to the SDK', async () => {
    const prompt = 'sk-ant-SECRET_QUERY_SENTINEL\r\nsecond line\nDATABASE_URL=do-not-log';
    const deps = createMockDeps();
    const now = new Date().toISOString();
    vi.mocked(deps.sessionsRepo.findById).mockResolvedValue({
      session_id: 'test-session' as SessionID,
      branch_id: 'test-branch' as BranchID,
      mcp_token: 'test-token',
      sdk_session_id: 'sdk-session-secret',
      created_at: now,
      last_updated: now,
      permission_config: { mode: 'default' },
      model_config: {
        mode: 'alias',
        model: 'claude-sonnet-4-6',
        updated_at: now,
        effort: 'high',
        advisorModel: 'opus',
      },
    } as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await setupQuery('test-session' as SessionID, prompt, deps, {
        promptOrigin: { kind: 'human' },
      });

      expect(logSpy.mock.calls).toEqual([['🤖 Prompting Claude for session test-session...']]);

      const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
      expect(callArgs.options).not.toHaveProperty('debug');
      expect(callArgs.options.resume).toBe('sdk-session-secret');
      const promptIterator = callArgs.prompt[Symbol.asyncIterator]();
      const firstMessage = await promptIterator.next();
      expect(firstMessage.value.message.content).toEqual([{ type: 'text', text: prompt }]);
      expect(firstMessage.value.origin).toEqual({ kind: 'human' });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('keeps canonical Claude state for fork/resume while credentials use executor env', async () => {
    const deps = createMockDeps();
    const now = new Date().toISOString();
    vi.mocked(deps.sessionsRepo.findById)
      .mockResolvedValueOnce({
        session_id: 'fork-session' as SessionID,
        branch_id: 'test-branch' as BranchID,
        created_at: now,
        last_updated: now,
        genealogy: { forked_from_session_id: 'parent-session' as SessionID },
      } as any)
      .mockResolvedValueOnce({
        session_id: 'parent-session' as SessionID,
        branch_id: 'test-branch' as BranchID,
        sdk_session_id: 'parent-sdk-session',
      } as any);

    await setupQuery('fork-session' as SessionID, 'continue from parent', deps);
    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    expect(callArgs.options).toMatchObject({
      resume: 'parent-sdk-session',
      forkSession: true,
      settingSources: expect.arrayContaining(['user', 'project', 'local']),
    });
    // Runtime containment keeps the canonical .claude state directory writable
    // while masking only credential authority leaves. It must not redirect
    // CLAUDE_CONFIG_DIR, which would strand path-keyed transcripts/settings.
    expect(callArgs.options).not.toHaveProperty('env.CLAUDE_CONFIG_DIR');
  });

  it('retains only UTF-8 byte metadata from provider stderr', async () => {
    const deps = createMockDeps();
    const setup = await setupQuery('test-session' as SessionID, 'test prompt', deps);
    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    const captureStderr = callArgs.options.stderr as (data: unknown) => void;
    const sentinel = 'SENTINEL_CLAUDE_STDERR_SECRET_🔐';

    captureStderr(sentinel);
    captureStderr({ reflected: sentinel });

    expect(setup.getStderrMetadata()).toEqual({
      hasStderr: true,
      byteLength: Buffer.byteLength(sentinel),
    });
    expect(JSON.stringify(setup.getStderrMetadata())).not.toContain(sentinel);
  });

  // Pin the literal disallow list so a stray edit to the constant
  // (e.g. dropping `ExitWorktree`) trips this test, not just the plumbing one.
  // See `constants.ts` for why each name is on the list — #1177 covers
  // AskUserQuestion; the rest were operator-approved at the same time.
  // `ScheduleWakeup` added in #1253 (Agor schedules supersede /loop).
  it('locks the disallowed-tools list to the operator-approved names', () => {
    expect(CLAUDE_CODE_DISALLOWED_TOOLS).toEqual([
      'AskUserQuestion',
      'ExitPlanMode',
      'EnterWorktree',
      'ExitWorktree',
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

  it('opts into the Claude task tools that back Agor todo rendering', async () => {
    await setupQuery('test-session' as SessionID, 'test prompt', createMockDeps());

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    expect(CLAUDE_CODE_TODO_TOOLS).toEqual(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']);
    expect(callArgs.options.allowedTools).toEqual([...CLAUDE_CODE_TODO_TOOLS]);
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

  it('always loads authenticated OAuth MCP servers for non-gateway sessions', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.sessionsRepo.findById).mockResolvedValue({
      session_id: 'test-session' as SessionID,
      branch_id: 'test-branch' as BranchID,
      mcp_token: 'test-token',
    } as any);
    deps.sessionMCPRepo = {} as any;
    deps.mcpServerRepo = {} as any;
    vi.mocked(resolveMCPAuthHeaders).mockResolvedValue({ Authorization: 'Bearer oauth-token' });
    vi.mocked(getMcpServersForSession).mockResolvedValue([
      {
        server: {
          name: 'oauthRemote',
          transport: 'http',
          url: 'https://example.com/mcp',
          auth: { type: 'oauth', oauth_access_token: 'oauth-token' },
        },
      } as any,
    ]);

    await setupQuery('test-session' as SessionID, 'test prompt', deps);

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    const mcpServers = callArgs.options.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcpServers.agor.alwaysLoad).toBeUndefined();
    expect(mcpServers.oauthRemote).toMatchObject({
      headers: { Authorization: 'Bearer oauth-token' },
      alwaysLoad: true,
    });
  });

  it('does not log or dispatch secret-bearing MCP auth exceptions', async () => {
    const sentinel = 'SENTINEL_CLAUDE_AUTH_EXCEPTION_7f1a';
    const deps = createMockDeps();
    deps.sessionMCPRepo = {} as any;
    deps.mcpServerRepo = {} as any;
    vi.mocked(getMcpServersForSession).mockResolvedValue([
      {
        server: {
          mcp_server_id: 'server-secret',
          name: 'remote',
          transport: 'http',
          url: 'https://example.test/mcp',
          auth: { type: 'jwt' },
        },
      } as any,
    ]);
    vi.mocked(resolveMCPAuthHeaders).mockRejectedValue(
      new Error(`TLS provider reflected ${sentinel}`)
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await setupQuery('test-session' as SessionID, 'test prompt', deps);
      const calls = vi.mocked(Claude.query).mock.calls;
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
      expect(JSON.stringify(calls)).not.toContain(sentinel);
      const mcpServers = calls[0][0].options.mcpServers as Record<string, Record<string, unknown>>;
      expect(mcpServers.remote.headers).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
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
        model: 'claude-sonnet-4-6[1m]',
        updated_at: '2026-06-11T00:00:00.000Z',
        advisorModel: 'opus',
      },
    } as any);

    await setupQuery('test-session' as SessionID, 'test prompt', deps);

    const callArgs = vi.mocked(Claude.query).mock.calls[0][0];
    expect(callArgs.options.model).toBe('claude-sonnet-4-6[1m]');
    // The advisor goes through the SDK's extraArgs → `--advisor opus`.
    expect(callArgs.options.extraArgs).toMatchObject({ advisor: 'opus' });
    // EACCES regression guard: we must NOT pass `settings` as an object, which
    // makes the CLI materialize a content-addressed /tmp/claude-settings-*.json
    // that collides across sessions/users (EACCES on open). See query-builder.ts.
    expect(callArgs.options.settings).toBeUndefined();
  });

  it('passes advisorModel [1m] through to Claude Code without translating it to a beta', async () => {
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
    expect(callArgs.options.extraArgs).toMatchObject({ advisor: 'claude-opus-4-7[1m]' });
    expect(callArgs.options.settings).toBeUndefined();
    expect(callArgs.options.betas).toBeUndefined();
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

/**
 * `bypassPermissions` removes the approval channel, which leaves an `ask` tool
 * unanswerable. It resolves to a refusal rather than to `allow`, so the mode is
 * "stop asking me" for everything except the tools an operator explicitly asked
 * to be prompted about.
 */
describe('setupQuery - ask under bypassPermissions', () => {
  const GATED_SERVER = 'files';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Claude.query).mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
      interrupt: () => Promise.resolve(),
    } as any);
    vi.mocked(getMcpServersForSession).mockResolvedValue([
      {
        server: {
          mcp_server_id: 'files-server',
          name: GATED_SERVER,
          transport: 'stdio',
          command: 'noop',
          scope: 'global',
          source: 'user',
          enabled: true,
          tool_permissions: { write_file: 'ask', read_file: 'allow' },
        },
        source: 'global',
      },
    ] as any);
  });

  function createDepsWithGatedServer(): QuerySetupDeps {
    return {
      sessionsRepo: {
        findById: vi.fn().mockResolvedValue({
          session_id: 'test-session' as SessionID,
          branch_id: 'test-branch' as BranchID,
          mcp_token: 'token',
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

  it('hard-denies an "ask" tool when there is nowhere to ask', async () => {
    await setupQuery('test-session' as SessionID, 'test prompt', createDepsWithGatedServer(), {
      taskId: 'test-task' as TaskID,
      permissionMode: 'bypassPermissions',
    });

    const options = vi.mocked(Claude.query).mock.calls[0][0].options;
    // `disallowedTools` is mode-independent, so this holds even though bypass
    // skips canUseTool and could skip hooks.
    expect(options.disallowedTools).toContain(`mcp__${GATED_SERVER}__write_file`);
    // An "allow" tool is untouched: the mode is not a blanket refusal.
    expect(options.disallowedTools).not.toContain(`mcp__${GATED_SERVER}__read_file`);
  });

  it('leaves an "ask" tool promptable when an approval channel exists', async () => {
    await setupQuery('test-session' as SessionID, 'test prompt', createDepsWithGatedServer(), {
      taskId: 'test-task' as TaskID,
      permissionMode: 'default',
    });

    const options = vi.mocked(Claude.query).mock.calls[0][0].options;
    expect(options.disallowedTools).not.toContain(`mcp__${GATED_SERVER}__write_file`);
    // Positive control: the server really was processed, so the absence above
    // is the promptable path and not a fixture that produced no servers.
    expect(Object.keys(options.mcpServers ?? {})).toContain(GATED_SERVER);
    expect(options.canUseTool).toBeTypeOf('function');
  });
});

/**
 * The CLI rewrites both halves of a namespaced name into `[a-zA-Z0-9_-]`, and
 * matches rules against the rewritten form. A rule carrying the raw tool name
 * binds to nothing, which reads as unconfigured — allow.
 */
describe('setupQuery - tool names the CLI has to rewrite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Claude.query).mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
      interrupt: () => Promise.resolve(),
    } as any);
    vi.mocked(getMcpServersForSession).mockResolvedValue([
      {
        server: {
          mcp_server_id: 'gh-server',
          name: 'My.Server',
          transport: 'stdio',
          command: 'noop',
          scope: 'global',
          source: 'user',
          enabled: true,
          tool_permissions: { 'repo.create': 'deny', repo_read: 'allow' },
        },
        source: 'global',
      },
    ] as any);
  });

  function deps(): QuerySetupDeps {
    return {
      sessionsRepo: {
        findById: vi.fn().mockResolvedValue({
          session_id: 'test-session' as SessionID,
          branch_id: 'test-branch' as BranchID,
          mcp_token: 'token',
        }),
      } as any,
      branchesRepo: { findById: vi.fn().mockResolvedValue({ path: '/test/project/path' }) } as any,
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

  it('denies under the rewritten tool name, not only the raw one', async () => {
    await setupQuery('test-session' as SessionID, 'test prompt', deps(), {
      taskId: 'test-task' as TaskID,
      permissionMode: 'default',
    });

    const disallowed = vi.mocked(Claude.query).mock.calls[0][0].options.disallowedTools as string[];

    // What the CLI actually offers the model, and therefore the only form that
    // can bind: both halves rewritten.
    expect(disallowed).toContain('mcp__My_Server__repo_create');
    // The raw form stays listed too — a rule that matches nothing is inert.
    expect(disallowed).toContain('mcp__My.Server__repo.create');
    // An "allow" tool is not swept in by the rewrite.
    expect(disallowed).not.toContain('mcp__My_Server__repo_read');
  });
});
