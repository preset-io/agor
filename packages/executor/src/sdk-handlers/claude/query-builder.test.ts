import type {
  BranchID,
  MCPRuntimeRefreshRequest,
  MCPRuntimeReprojection,
  SessionID,
  TaskID,
} from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { claudeQuery, claudeSdkMocks, mcpAuthMocks } = vi.hoisted(() => {
  const claudeQuery = vi.fn();
  return {
    claudeQuery,
    claudeSdkMocks: { query: claudeQuery },
    mcpAuthMocks: { resolveMCPAuthHeaders: vi.fn() },
  };
});

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
import { CLAUDE_CODE_DISALLOWED_TOOLS } from './constants.js';
import { formatListForLog, type QuerySetupDeps, setupQuery } from './query-builder.js';

describe('MCP logging helpers', () => {
  it('formats long server lists without dumping every entry', () => {
    expect(formatListForLog(['a', 'b', 'c'], 5)).toBe('a, b, c');
    expect(formatListForLog(['a', 'b', 'c', 'd'], 2)).toBe('a, b +2 more');
  });
});

describe('setupQuery - live MCP reprojection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const readyProjection = (): MCPRuntimeReprojection =>
    ({
      task_id: 'test-task',
      session_id: 'test-session',
      request_id: 'refresh-1',
      recovery_generation: 3,
      provider: {
        mode: 'in_place' as const,
        transport_reload: true,
        retries_unstarted_call: false,
      },
      servers: [
        {
          mcp_server_id: 'server-1',
          name: 'fresh',
          transport: 'http' as const,
          url: 'http://daemon/mcp-egress/server-1',
          headers: { 'X-Agor-Mcp-Capability': 'opaque-capability' },
          scope: 'global' as const,
          source: 'user' as const,
          enabled: true,
        },
      ],
      states: [],
    }) as MCPRuntimeReprojection;

  const refreshDeps = (
    reproject: ReturnType<typeof vi.fn>,
    reportRefresh: ReturnType<typeof vi.fn>,
    validateReprojection = vi.fn().mockResolvedValue(undefined),
    sessionOverrides: Record<string, unknown> = {}
  ) =>
    ({
      sessionsRepo: {
        findById: vi.fn().mockResolvedValue({
          session_id: 'test-session',
          branch_id: 'test-branch',
          sdk_session_id: 'sdk-session-retained',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          ...sessionOverrides,
        }),
        update: vi.fn(),
      } as any,
      branchesRepo: {
        findById: vi.fn().mockResolvedValue({ path: '/test/project/path' }),
      } as any,
      sessionMCPRepo: { reproject, validateReprojection, reportRefresh } as any,
      permissionLocks: new Map(),
    }) satisfies QuerySetupDeps;

  it('rebuilds only MCP transport and retains the resumed conversation handle', async () => {
    const setMcpServers = vi.fn().mockResolvedValue({ added: ['fresh'], removed: [], errors: {} });
    claudeQuery.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
      interrupt: () => Promise.resolve(),
      setMcpServers,
    } as any);
    const reportRefresh = vi.fn().mockResolvedValue(undefined);
    const reproject = vi.fn().mockResolvedValue({
      task_id: 'test-task',
      session_id: 'test-session',
      request_id: 'refresh-1',
      recovery_generation: 3,
      provider: {
        mode: 'in_place',
        transport_reload: true,
        retries_unstarted_call: false,
      },
      servers: [
        {
          mcp_server_id: 'server-1',
          name: 'fresh',
          transport: 'http',
          url: 'http://daemon/mcp-egress/server-1',
          headers: { 'X-Agor-Mcp-Capability': 'opaque-capability' },
          scope: 'global',
          source: 'user',
          enabled: true,
        },
      ],
      states: [],
    });
    const deps: QuerySetupDeps = {
      sessionsRepo: {
        findById: vi.fn().mockResolvedValue({
          session_id: 'test-session',
          branch_id: 'test-branch',
          sdk_session_id: 'sdk-session-retained',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        }),
        update: vi.fn(),
      } as any,
      branchesRepo: {
        findById: vi.fn().mockResolvedValue({ path: '/test/project/path' }),
      } as any,
      sessionMCPRepo: {
        reproject,
        validateReprojection: vi.fn().mockResolvedValue(undefined),
        reportRefresh,
      } as any,
      permissionLocks: new Map(),
    };

    const setup = await setupQuery('test-session' as SessionID, 'test prompt', deps, {
      taskId: 'test-task' as TaskID,
    });
    await setup.refreshMcp?.({
      request_id: 'refresh-1',
      reason: 'user_reconnect',
      expected_generation: 3,
    });

    expect(claudeQuery.mock.calls[0][0].options.resume).toBe('sdk-session-retained');
    expect(setMcpServers).toHaveBeenCalledWith({
      fresh: {
        type: 'http',
        url: 'http://daemon/mcp-egress/server-1',
        headers: { 'X-Agor-Mcp-Capability': 'opaque-capability' },
      },
    });
    expect(reportRefresh).toHaveBeenCalledWith('test-task', {
      request_id: 'refresh-1',
      expected_generation: 3,
      ok: true,
    });
    expect(deps.sessionsRepo.update).not.toHaveBeenCalled();
  });

  it('does not relabel an acknowledgement failure as a provider apply failure', async () => {
    const setMcpServers = vi.fn().mockResolvedValue({ added: ['fresh'], removed: [], errors: {} });
    claudeQuery.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
      interrupt: () => Promise.resolve(),
      setMcpServers,
    } as any);
    const reproject = vi.fn().mockResolvedValue(readyProjection());
    const reportRefresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('SECRET_ACK_FAILURE'))
      .mockResolvedValueOnce(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const setup = await setupQuery(
      'test-session' as SessionID,
      'test prompt',
      refreshDeps(reproject, reportRefresh),
      { taskId: 'test-task' as TaskID }
    );

    await expect(
      setup.refreshMcp!({
        request_id: 'refresh-1',
        reason: 'authority_changed',
        expected_generation: 3,
      })
    ).resolves.toMatchObject({ request_id: 'refresh-1' });
    await expect(
      setup.refreshMcp!({
        request_id: 'refresh-1',
        reason: 'user_reconnect',
        expected_generation: 3,
      })
    ).resolves.toMatchObject({ request_id: 'refresh-1' });
    expect(setMcpServers).toHaveBeenCalledTimes(1);
    expect(reportRefresh).toHaveBeenCalledTimes(2);
    expect(reportRefresh).toHaveBeenCalledWith('test-task', {
      request_id: 'refresh-1',
      expected_generation: 3,
      ok: true,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_ACK_FAILURE');
  });

  it('does not let an installed-A cache acknowledge a rejected authority-B duplicate', async () => {
    const setMcpServers = vi.fn().mockResolvedValue({ added: ['fresh'], removed: [], errors: {} });
    claudeQuery.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
      interrupt: () => Promise.resolve(),
      setMcpServers,
    } as any);
    const projectionA = readyProjection();
    const reproject = vi
      .fn()
      .mockResolvedValueOnce(projectionA)
      .mockRejectedValueOnce(new Error('durable projection A cannot be rebound to authority B'));
    const reportRefresh = vi.fn().mockRejectedValueOnce(new Error('ack transport unavailable'));
    const setup = await setupQuery(
      'test-session' as SessionID,
      'test prompt',
      refreshDeps(reproject, reportRefresh),
      { taskId: 'test-task' as TaskID }
    );
    const request = {
      request_id: 'refresh-1',
      reason: 'authority_changed' as const,
      expected_generation: 3,
    };

    await expect(setup.refreshMcp!(request)).resolves.toBe(projectionA);
    await expect(setup.refreshMcp!({ ...request, reason: 'user_reconnect' })).rejects.toThrow(
      'cannot be rebound to authority B'
    );
    expect(setMcpServers).toHaveBeenCalledTimes(1);
    expect(reportRefresh).toHaveBeenCalledTimes(1);
  });

  it('preserves blocking alwaysLoad semantics for gateway-session reprojection', async () => {
    const setMcpServers = vi.fn().mockResolvedValue({ added: ['fresh'], removed: [], errors: {} });
    claudeQuery.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
      interrupt: () => Promise.resolve(),
      setMcpServers,
    } as any);
    const setup = await setupQuery(
      'test-session' as SessionID,
      'test prompt',
      refreshDeps(
        vi.fn().mockResolvedValue(readyProjection()),
        vi.fn().mockResolvedValue(undefined),
        vi.fn().mockResolvedValue(undefined),
        { custom_context: { gateway_source: 'slack' } }
      ),
      { taskId: 'test-task' as TaskID }
    );
    await setup.refreshMcp!({
      request_id: 'refresh-1',
      reason: 'authority_changed',
      expected_generation: 3,
    });
    expect(setMcpServers).toHaveBeenCalledWith({
      fresh: expect.objectContaining({ alwaysLoad: true }),
    });
  });

  it('reports partial setMcpServers application as a truthful provider failure', async () => {
    const setMcpServers = vi.fn().mockResolvedValue({
      added: ['other'],
      removed: [],
      errors: { fresh: 'connection failed' },
    });
    claudeQuery.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
      interrupt: () => Promise.resolve(),
      setMcpServers,
    } as any);
    const reproject = vi.fn().mockResolvedValue(readyProjection());
    const reportRefresh = vi.fn().mockResolvedValue(undefined);
    const setup = await setupQuery(
      'test-session' as SessionID,
      'test prompt',
      refreshDeps(reproject, reportRefresh),
      { taskId: 'test-task' as TaskID }
    );

    await expect(
      setup.refreshMcp!({
        request_id: 'refresh-1',
        reason: 'authority_changed',
        expected_generation: 3,
      })
    ).rejects.toThrow('partially applied');
    expect(reportRefresh).toHaveBeenCalledTimes(1);
    expect(reportRefresh).toHaveBeenCalledWith('test-task', {
      request_id: 'refresh-1',
      expected_generation: 3,
      ok: false,
    });
  });

  it('applies a mixed projection ready subset while retaining excluded state for acknowledgement', async () => {
    const setMcpServers = vi
      .fn()
      .mockResolvedValue({ added: ['ready-http'], removed: [], errors: {} });
    claudeQuery.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
      interrupt: () => Promise.resolve(),
      setMcpServers,
    } as any);
    const projected = readyProjection();
    projected.servers[0]!.name = 'ready-http';
    projected.states = [
      {
        mcp_server_id: 'server-1',
        name: 'ready-http',
        code: 'ready',
        action: 'none',
        message: 'Ready through the daemon MCP gateway.',
      },
      {
        mcp_server_id: 'server-stdio',
        name: 'Local tools',
        code: 'transport_not_mediated',
        action: 'review_configuration',
        message: 'This server configuration cannot be mediated by the live MCP gateway.',
      },
    ];
    const reproject = vi.fn().mockResolvedValue(projected);
    const reportRefresh = vi.fn().mockResolvedValue(undefined);
    const setup = await setupQuery(
      'test-session' as SessionID,
      'test prompt',
      refreshDeps(reproject, reportRefresh),
      { taskId: 'test-task' as TaskID }
    );

    await expect(
      setup.refreshMcp!({
        request_id: 'refresh-1',
        reason: 'authority_changed',
        expected_generation: 3,
      })
    ).resolves.toMatchObject({
      states: [
        { name: 'ready-http', code: 'ready' },
        { name: 'Local tools', code: 'transport_not_mediated' },
      ],
    });
    expect(setMcpServers).toHaveBeenCalledWith({
      'ready-http': expect.objectContaining({ url: 'http://daemon/mcp-egress/server-1' }),
    });
    expect(reportRefresh).toHaveBeenCalledWith('test-task', {
      request_id: 'refresh-1',
      expected_generation: 3,
      ok: true,
    });
  });

  it('does not report provider failure when durable pre-apply validation rejects', async () => {
    const setMcpServers = vi.fn();
    claudeQuery.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
      interrupt: () => Promise.resolve(),
      setMcpServers,
    } as any);
    const reproject = vi.fn().mockResolvedValue(readyProjection());
    const validateReprojection = vi.fn().mockRejectedValue(new Error('stale durable generation'));
    const reportRefresh = vi.fn();
    const setup = await setupQuery(
      'test-session' as SessionID,
      'test prompt',
      refreshDeps(reproject, reportRefresh, validateReprojection),
      { taskId: 'test-task' as TaskID }
    );

    await expect(
      setup.refreshMcp!({
        request_id: 'refresh-1',
        reason: 'authority_changed',
        expected_generation: 3,
      })
    ).rejects.toThrow('stale durable generation');
    expect(setMcpServers).not.toHaveBeenCalled();
    expect(reportRefresh).not.toHaveBeenCalled();
  });

  it('times out an uncertain SDK apply and fences every later live apply in the turn', async () => {
    vi.useFakeTimers();
    const setMcpServers = vi.fn(() => new Promise<never>(() => undefined));
    claudeQuery.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
      interrupt: () => Promise.resolve(),
      setMcpServers,
    } as any);
    const reportRefresh = vi.fn().mockResolvedValue(undefined);
    const reproject = vi.fn(async (_taskId: TaskID, request: MCPRuntimeRefreshRequest) => ({
      ...readyProjection(),
      request_id: request.request_id,
      recovery_generation: request.expected_generation,
    }));
    const setup = await setupQuery(
      'test-session' as SessionID,
      'test prompt',
      refreshDeps(reproject, reportRefresh),
      { taskId: 'test-task' as TaskID }
    );
    const first = setup.refreshMcp!({
      request_id: 'refresh-1',
      reason: 'authority_changed',
      expected_generation: 3,
    });
    const firstRejection = expect(first).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15_001);
    await firstRejection;
    await expect(
      setup.refreshMcp!({
        request_id: 'refresh-2',
        reason: 'user_reconnect',
        expected_generation: 4,
      })
    ).rejects.toThrow('outcome is uncertain');
    expect(setMcpServers).toHaveBeenCalledTimes(1);
    expect(reportRefresh.mock.calls).toEqual([
      [
        'test-task',
        {
          request_id: 'refresh-1',
          expected_generation: 3,
          ok: false,
          failure: 'transport_outcome_uncertain',
        },
      ],
      [
        'test-task',
        {
          request_id: 'refresh-2',
          expected_generation: 4,
          ok: false,
          failure: 'transport_outcome_uncertain',
        },
      ],
    ]);
    vi.useRealTimers();
  });

  it('never applies an older projection after a newer refresh succeeds', async () => {
    const setMcpServers = vi.fn().mockResolvedValue({ added: [], removed: [], errors: {} });
    claudeQuery.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
      interrupt: () => Promise.resolve(),
      setMcpServers,
    } as any);
    let resolveOld!: (value: MCPRuntimeReprojection) => void;
    const oldProjection = new Promise<MCPRuntimeReprojection>((resolve) => {
      resolveOld = resolve;
    });
    const projection = (requestId: string, generation: number, name: string) =>
      ({
        task_id: 'test-task',
        session_id: 'test-session',
        request_id: requestId,
        recovery_generation: generation,
        provider: {
          mode: 'in_place',
          transport_reload: true,
          retries_unstarted_call: false,
        },
        servers: [
          {
            mcp_server_id: `server-${generation}`,
            name,
            transport: 'http',
            url: `http://daemon/mcp-egress/server-${generation}`,
            headers: { 'X-Agor-Mcp-Capability': `opaque-${generation}` },
            scope: 'global',
            source: 'user',
            enabled: true,
          },
        ],
        states: [],
      }) as MCPRuntimeReprojection;
    const reproject = vi.fn(async (_taskId: TaskID, request: MCPRuntimeRefreshRequest) => {
      if (request.request_id === 'old') {
        return oldProjection;
      }
      return projection('new', 2, 'newest');
    });
    const validateReprojection = vi.fn(
      async (_taskId: TaskID, request: MCPRuntimeRefreshRequest) => {
        if (request.request_id === 'old') throw new Error('stale durable generation');
      }
    );
    const reportRefresh = vi.fn().mockResolvedValue(undefined);
    const setup = await setupQuery(
      'test-session' as SessionID,
      'test prompt',
      {
        sessionsRepo: {
          findById: vi.fn().mockResolvedValue({
            session_id: 'test-session',
            branch_id: 'test-branch',
            sdk_session_id: 'sdk-session-retained',
            created_at: new Date().toISOString(),
            last_updated: new Date().toISOString(),
          }),
          update: vi.fn(),
        } as any,
        branchesRepo: {
          findById: vi.fn().mockResolvedValue({ path: '/test/project/path' }),
        } as any,
        sessionMCPRepo: { reproject, validateReprojection, reportRefresh } as any,
        permissionLocks: new Map(),
      },
      { taskId: 'test-task' as TaskID }
    );

    const old = setup.refreshMcp!({
      request_id: 'old',
      reason: 'authority_changed',
      expected_generation: 1,
    });
    await vi.waitFor(() => expect(reproject).toHaveBeenCalledTimes(1));
    await expect(
      setup.refreshMcp!({
        request_id: 'new',
        reason: 'authority_changed',
        expected_generation: 2,
      })
    ).resolves.toMatchObject({ request_id: 'new', recovery_generation: 2 });

    resolveOld(projection('old', 1, 'stale'));
    await expect(old).rejects.toThrow('stale durable generation');
    expect(setMcpServers).toHaveBeenCalledTimes(1);
    expect(setMcpServers).toHaveBeenCalledWith({
      newest: {
        type: 'http',
        url: 'http://daemon/mcp-egress/server-2',
        headers: { 'X-Agor-Mcp-Capability': 'opaque-2' },
      },
    });
    expect(reportRefresh).toHaveBeenCalledWith('test-task', {
      request_id: 'new',
      expected_generation: 2,
      ok: true,
    });
  });
});

describe('setupQuery - Local Settings Support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMcpServersForSession).mockResolvedValue([]);
    vi.mocked(resolveMCPAuthHeaders).mockResolvedValue(undefined);
    claudeQuery.mockReturnValue({
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

    const callArgs = claudeQuery.mock.calls[0][0];

    // This is the core test for your feature:
    // It ensures 'local' is passed alongside 'user' and 'project'
    expect(callArgs.options.settingSources).toContain('local');
    expect(callArgs.options.settingSources).toEqual(
      expect.arrayContaining(['user', 'project', 'local'])
    );
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
      await setupQuery('test-session' as SessionID, prompt, deps);

      expect(logSpy.mock.calls).toEqual([['🤖 Prompting Claude for session test-session...']]);

      const callArgs = claudeQuery.mock.calls[0][0];
      expect(callArgs.options).not.toHaveProperty('debug');
      expect(callArgs.options.resume).toBe('sdk-session-secret');
      const promptIterator = callArgs.prompt[Symbol.asyncIterator]();
      const firstMessage = await promptIterator.next();
      expect(firstMessage.value.message.content).toEqual([{ type: 'text', text: prompt }]);
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
    const callArgs = claudeQuery.mock.calls[0][0];
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

    const callArgs = claudeQuery.mock.calls[0][0];
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

    const callArgs = claudeQuery.mock.calls[0][0];
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

    const callArgs = claudeQuery.mock.calls[0][0];
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

    const callArgs = claudeQuery.mock.calls[0][0];
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
      const calls = claudeQuery.mock.calls;
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

    const callArgs = claudeQuery.mock.calls[0][0];
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

    const callArgs = claudeQuery.mock.calls[0][0];
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

    const callArgs = claudeQuery.mock.calls[0][0];
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

    const callArgs = claudeQuery.mock.calls[0][0];
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

    const callArgs = claudeQuery.mock.calls[0][0];
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

    const callArgs = claudeQuery.mock.calls[0][0];
    expect(
      (callArgs.options.extraArgs as Record<string, unknown> | undefined)?.advisor
    ).toBeUndefined();
    expect(callArgs.options.settings).toBeUndefined();
  });
});

describe('setupQuery - canUseTool registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claudeQuery.mockReturnValue({
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

    const callArgs = claudeQuery.mock.calls[0][0];
    expect(callArgs.options.canUseTool).toBeUndefined();
    expect(callArgs.options.permissionMode).toBe('bypassPermissions');
  });

  it('registers canUseTool in default permission mode', async () => {
    const deps = createPermissionDeps();

    await setupQuery('test-session' as SessionID, 'test prompt', deps, {
      taskId: 'test-task' as TaskID,
      permissionMode: 'default',
    });

    const callArgs = claudeQuery.mock.calls[0][0];
    expect(callArgs.options.canUseTool).toBeTypeOf('function');
  });

  it('does not register canUseTool when required deps are missing (no taskId)', async () => {
    const deps = createPermissionDeps();

    await setupQuery('test-session' as SessionID, 'test prompt', deps, {
      permissionMode: 'bypassPermissions',
      // no taskId
    });

    const callArgs = claudeQuery.mock.calls[0][0];
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
    claudeQuery.mockReturnValue({
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

    const options = claudeQuery.mock.calls[0][0].options;
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

    const options = claudeQuery.mock.calls[0][0].options;
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
    claudeQuery.mockReturnValue({
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

    const disallowed = claudeQuery.mock.calls[0][0].options.disallowedTools as string[];

    // What the CLI actually offers the model, and therefore the only form that
    // can bind: both halves rewritten.
    expect(disallowed).toContain('mcp__My_Server__repo_create');
    // The raw form stays listed too — a rule that matches nothing is inert.
    expect(disallowed).toContain('mcp__My.Server__repo.create');
    // An "allow" tool is not swept in by the rewrite.
    expect(disallowed).not.toContain('mcp__My_Server__repo_read');
  });
});
