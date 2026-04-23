/**
 * Tests for session-creating MCP tools (`agor_sessions_create`,
 * `agor_sessions_spawn`, `agor_sessions_prompt` subsession mode).
 *
 * Focus: regression coverage for two param-drop bugs in the session-create
 * path:
 *   1. `mcpServerIds` were silently dropped on attach failure, making it look
 *      like the MCP server "didn't stick".
 *   2. `modelConfig` wasn't in the tool's input schema at all, so callers
 *      asking for `claude-opus-4-6` got the default model instead.
 *
 * We capture each tool's registered handler, stub the Feathers services it
 * calls, and assert on the session payload + attach calls.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../resolve-ids.js', () => ({
  resolveBoardId: async (_ctx: unknown, id: string) => id,
  resolveSessionId: async (_ctx: unknown, id: string) => id,
  resolveWorktreeId: async (_ctx: unknown, id: string) => id,
  resolveMcpServerId: async (_ctx: unknown, id: string) => `full-${id}`,
}));

vi.mock('../../utils/worktree-authorization.js', () => ({
  ensureCanPromptTargetSession: vi.fn(async () => undefined),
}));

vi.mock('@agor/core/db', () => ({
  WorktreeRepository: class FakeWorktreeRepository {},
}));

// Helper to build a minimal fake Feathers app. Each test supplies spies for
// the services it exercises; unknown services throw so we don't silently drop
// side-effects the assertion cares about.
type ServiceStub = Record<string, (...args: unknown[]) => unknown>;
function makeFakeApp(services: Record<string, ServiceStub>) {
  return {
    service: (name: string) => {
      const svc = services[name];
      if (!svc) {
        throw new Error(`Unexpected service call: ${name}`);
      }
      return svc;
    },
  };
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

async function registerAndCaptureHandlers(
  ctx: {
    app: unknown;
    userId: string;
    sessionId: string;
  },
  toolNames: string[]
): Promise<Record<string, ToolHandler>> {
  const { registerSessionTools } = await import('./sessions.js');
  const captured: Record<string, ToolHandler> = {};
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
      if (toolNames.includes(name)) {
        captured[name] = cb;
      }
    },
  } as unknown as McpServer;

  registerSessionTools(fakeServer, {
    app: ctx.app as any,
    db: {} as any,
    userId: ctx.userId as any,
    sessionId: ctx.sessionId as any,
    authenticatedUser: { user_id: ctx.userId, role: 'member' } as any,
    baseServiceParams: {},
  });

  for (const name of toolNames) {
    if (!captured[name]) throw new Error(`Tool ${name} was not registered`);
  }
  return captured;
}

describe('agor_sessions_create', () => {
  const baseWorktree = {
    worktree_id: 'wt-1',
    path: '/tmp/wt',
    mcp_server_ids: [],
  };
  const baseUser = {
    user_id: 'user-1',
    unix_username: 'alice',
    default_agentic_config: {
      'claude-code': {
        permissionMode: 'acceptEdits',
        modelConfig: {
          mode: 'alias',
          model: 'claude-sonnet-4-6', // user default
          effort: 'medium',
        },
      },
    },
  };

  beforeEach(() => {
    vi.doMock('@agor/core/git', () => ({
      getGitState: async () => 'sha-abc',
      getCurrentBranch: async () => 'main',
    }));
    vi.doMock('@agor/core/types', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('@agor/core/types');
      return {
        ...actual,
        getDefaultPermissionMode: () => 'acceptEdits',
      };
    });
    vi.doMock('@agor/core/utils/permission-mode-mapper', () => ({
      mapPermissionMode: (m: string) => m,
    }));
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('threads explicit modelConfig through to session.model_config (Bug 2)', async () => {
    const sessionCreates: unknown[] = [];
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      worktrees: { get: async () => baseWorktree },
      sessions: {
        create: async (data: unknown) => {
          sessionCreates.push(data);
          return { session_id: 'sess-new', ...(data as Record<string, unknown>) };
        },
      },
      'session-mcp-servers': { create: async () => ({}) },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );

    await agor_sessions_create({
      worktreeId: 'wt-1',
      agenticTool: 'claude-code',
      modelConfig: { model: 'claude-opus-4-6', mode: 'alias', effort: 'max' },
    });

    expect(sessionCreates).toHaveLength(1);
    const created = sessionCreates[0] as Record<string, any>;
    expect(created.model_config).toBeDefined();
    // Explicit override wins over user default ('claude-sonnet-4-6').
    expect(created.model_config.model).toBe('claude-opus-4-6');
    expect(created.model_config.mode).toBe('alias');
    expect(created.model_config.effort).toBe('max');
    expect(typeof created.model_config.updated_at).toBe('string');
  });

  it('falls back to user default modelConfig when none is explicitly provided', async () => {
    const sessionCreates: unknown[] = [];
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      worktrees: { get: async () => baseWorktree },
      sessions: {
        create: async (data: unknown) => {
          sessionCreates.push(data);
          return { session_id: 'sess-new', ...(data as Record<string, unknown>) };
        },
      },
      'session-mcp-servers': { create: async () => ({}) },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );

    await agor_sessions_create({
      worktreeId: 'wt-1',
      agenticTool: 'claude-code',
      // no modelConfig
    });

    const created = sessionCreates[0] as Record<string, any>;
    expect(created.model_config.model).toBe('claude-sonnet-4-6'); // user default
    expect(created.model_config.effort).toBe('medium');
  });

  it('attaches explicit mcpServerIds to the session via session-mcp-servers (Bug 1)', async () => {
    const attachCalls: unknown[] = [];
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      worktrees: { get: async () => baseWorktree },
      sessions: {
        create: async (data: unknown) => ({
          session_id: 'sess-new',
          ...(data as Record<string, unknown>),
        }),
      },
      'session-mcp-servers': {
        create: async (data: unknown) => {
          attachCalls.push(data);
          return data;
        },
      },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );

    const result = await agor_sessions_create({
      worktreeId: 'wt-1',
      agenticTool: 'claude-code',
      mcpServerIds: ['short-id-1', 'short-id-2'],
    });

    expect(attachCalls).toHaveLength(2);
    // resolveMcpServerId mock prefixes with 'full-'
    expect((attachCalls[0] as any).mcp_server_id).toBe('full-short-id-1');
    expect((attachCalls[0] as any).session_id).toBe('sess-new');
    expect((attachCalls[1] as any).mcp_server_id).toBe('full-short-id-2');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.mcpAttachFailures).toBeUndefined();
  });

  it('surfaces attach failures in the response when caller explicitly requested mcpServerIds', async () => {
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      worktrees: { get: async () => baseWorktree },
      sessions: {
        create: async () => ({ session_id: 'sess-new' }),
      },
      'session-mcp-servers': {
        create: async () => {
          throw new Error('RBAC: forbidden');
        },
      },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );

    const result = await agor_sessions_create({
      worktreeId: 'wt-1',
      agenticTool: 'claude-code',
      mcpServerIds: ['short-id-1'],
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.mcpAttachFailures).toHaveLength(1);
    expect(parsed.mcpAttachFailures[0].mcp_server_id).toBe('full-short-id-1');
    expect(parsed.mcpAttachFailures[0].reason).toContain('RBAC');
  });

  it('silently skips (does not surface) attach failures for inherited mcpServerIds', async () => {
    const worktreeWithMcps = {
      ...baseWorktree,
      mcp_server_ids: ['inherited-1'],
    };
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      worktrees: { get: async () => worktreeWithMcps },
      sessions: {
        create: async () => ({ session_id: 'sess-new' }),
      },
      'session-mcp-servers': {
        create: async () => {
          throw new Error('boom');
        },
      },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );

    const result = await agor_sessions_create({
      worktreeId: 'wt-1',
      agenticTool: 'claude-code',
      // no explicit mcpServerIds → inherits from worktree
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.mcpAttachFailures).toBeUndefined();
  });
});

describe('agor_sessions_spawn', () => {
  beforeEach(() => {
    vi.doMock('@agor/core/git', () => ({
      getGitState: async () => 'sha-abc',
      getCurrentBranch: async () => 'main',
    }));
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('threads modelConfig into SpawnConfig (Bug 2)', async () => {
    const spawnCalls: Array<{ id: string; data: any }> = [];
    const app = makeFakeApp({
      sessions: {
        spawn: async (id: string, data: any) => {
          spawnCalls.push({ id, data });
          return {
            session_id: 'sess-child',
            permission_config: { mode: 'acceptEdits' },
          };
        },
      },
      '/sessions/:id/prompt': {
        create: async () => ({ taskId: 't1', status: 'running' }),
      },
    });

    const { agor_sessions_spawn } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-parent' },
      ['agor_sessions_spawn']
    );

    await agor_sessions_spawn({
      prompt: 'do the thing',
      modelConfig: { model: 'claude-opus-4-6', effort: 'high' },
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].data.modelConfig).toEqual({
      model: 'claude-opus-4-6',
      effort: 'high',
    });
  });

  it('threads provider through SpawnConfig.modelConfig (OpenCode)', async () => {
    const spawnCalls: Array<{ id: string; data: any }> = [];
    const app = makeFakeApp({
      sessions: {
        spawn: async (id: string, data: any) => {
          spawnCalls.push({ id, data });
          return {
            session_id: 'sess-child',
            permission_config: { mode: 'acceptEdits' },
          };
        },
      },
      '/sessions/:id/prompt': {
        create: async () => ({ taskId: 't1', status: 'running' }),
      },
    });

    const { agor_sessions_spawn } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-parent' },
      ['agor_sessions_spawn']
    );

    await agor_sessions_spawn({
      prompt: 'do the thing',
      modelConfig: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
    });

    // Regression guard: without `provider` on SpawnConfig, Zod-validated input
    // would reach the spawn service with provider set, but the service's merge
    // would drop it (or TS would reject the field). This asserts the full
    // shape survives the MCP → service boundary.
    expect(spawnCalls[0].data.modelConfig).toEqual({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
    });
  });
});

describe('agor_sessions_prompt (subsession mode)', () => {
  beforeEach(() => {
    vi.doMock('@agor/core/git', () => ({
      getGitState: async () => 'sha-abc',
      getCurrentBranch: async () => 'main',
    }));
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('threads modelConfig into SpawnConfig when mode="subsession"', async () => {
    const spawnCalls: Array<{ id: string; data: any }> = [];
    const app = makeFakeApp({
      sessions: {
        spawn: async (id: string, data: any) => {
          spawnCalls.push({ id, data });
          return {
            session_id: 'sess-sub',
            permission_config: { mode: 'acceptEdits' },
          };
        },
      },
      '/sessions/:id/prompt': {
        create: async () => ({ taskId: 't1', status: 'running' }),
      },
    });

    const { agor_sessions_prompt } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_prompt']
    );

    await agor_sessions_prompt({
      sessionId: 'sess-target',
      prompt: 'delegated work',
      mode: 'subsession',
      modelConfig: { model: 'claude-opus-4-6', effort: 'max', provider: 'anthropic' },
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].id).toBe('sess-target');
    expect(spawnCalls[0].data.modelConfig).toEqual({
      model: 'claude-opus-4-6',
      effort: 'max',
      provider: 'anthropic',
    });
  });
});
