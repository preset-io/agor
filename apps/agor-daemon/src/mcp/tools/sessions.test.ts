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
  resolveBranchId: async (_ctx: unknown, id: string) => id,
  resolveMcpServerId: async (_ctx: unknown, id: string) => `full-${id}`,
}));

vi.mock('../../utils/branch-authorization.js', () => ({
  ensureCanPromptTargetSession: vi.fn(async () => undefined),
}));

vi.mock('@agor/core/db', () => ({
  BranchRepository: class FakeBranchRepository {},
  SessionRelationshipRepository: class FakeSessionRelationshipRepository {
    create = vi.fn(async (data: Record<string, unknown>) => ({
      relationship_id: 'rel-1',
      ...data,
      created_at: new Date(0).toISOString(),
    }));
    get = vi.fn(async (relationshipId: string) => ({
      relationship_id: relationshipId,
      source_session_id: 'sess-source',
      target_session_id: 'sess-target',
      relationship_type: 'remote_create',
      created_by: 'user-1',
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      callback_enabled: false,
      callback_session_id: null,
      data: null,
    }));
    setCallbackEnabled = vi.fn(async (relationshipId: string, callbackEnabled: boolean) => ({
      relationship_id: relationshipId,
      source_session_id: 'sess-source',
      target_session_id: 'sess-target',
      relationship_type: 'remote_create',
      created_by: 'user-1',
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      callback_enabled: callbackEnabled,
      callback_session_id: null,
      data: null,
    }));
  },
  UserApiKeysRepository: class FakeUserApiKeysRepository {},
  shortId: (id: string) => id,
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
  isError?: boolean;
}>;

/** Cfg captured alongside the handler — includes inputSchema for tests that
 * exercise Zod validation/coercion (the fake server below bypasses the SDK's
 * automatic schema parsing). */
type CapturedTool = {
  cfg: { inputSchema?: { parse: (v: unknown) => unknown; safeParse: (v: unknown) => any } };
  cb: ToolHandler;
};

async function registerAndCaptureTools(
  ctx: {
    app: unknown;
    userId: string;
    sessionId?: string;
  },
  toolNames: string[]
): Promise<Record<string, CapturedTool>> {
  const { registerSessionTools } = await import('./sessions.js');
  const captured: Record<string, CapturedTool> = {};
  const fakeServer = {
    registerTool: (name: string, cfg: unknown, cb: ToolHandler) => {
      if (toolNames.includes(name)) {
        captured[name] = { cfg: cfg as CapturedTool['cfg'], cb };
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

async function registerAndCaptureHandlers(
  ctx: { app: unknown; userId: string; sessionId?: string },
  toolNames: string[]
): Promise<Record<string, ToolHandler>> {
  const tools = await registerAndCaptureTools(ctx, toolNames);
  return Object.fromEntries(Object.entries(tools).map(([name, { cb }]) => [name, cb]));
}

describe('sessionless MCP context', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('agor_sessions_get_current returns an actionable session-context error', async () => {
    const sessionsGet = vi.fn();
    const app = makeFakeApp({
      sessions: { get: sessionsGet },
    });
    const { agor_sessions_get_current } = await registerAndCaptureHandlers(
      { app, userId: 'user-1' },
      ['agor_sessions_get_current']
    );

    const result = await agor_sessions_get_current({});
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/requires current Agor session context/i);
    expect(parsed.error).toMatch(/X-Agor-Session-Id/);
    expect(parsed.error).toMatch(/\?sessionId=/);
    expect(sessionsGet).not.toHaveBeenCalled();
  }, 30_000);

  it('agor_sessions_spawn returns an actionable session-context error', async () => {
    const spawn = vi.fn();
    const app = makeFakeApp({
      sessions: { spawn },
      '/sessions/:id/prompt': { create: vi.fn() },
    });
    const { agor_sessions_spawn } = await registerAndCaptureHandlers({ app, userId: 'user-1' }, [
      'agor_sessions_spawn',
    ]);

    const result = await agor_sessions_spawn({ prompt: 'delegate this' });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/requires current Agor session context/i);
    expect(parsed.error).toMatch(/X-Agor-Session-Id/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('agor_sessions_list', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('enforces branchId filtering even if the sessions service returns broader data', async () => {
    const findCalls: unknown[] = [];
    const app = makeFakeApp({
      branches: { get: async (id: string) => ({ branch_id: id }) },
      sessions: {
        find: async (params: unknown) => {
          findCalls.push(params);
          return {
            total: 2,
            limit: 50,
            skip: 0,
            data: [
              { session_id: 'sess-target', branch_id: 'wt-1', status: 'idle', mcp_token: 'tok1' },
              { session_id: 'sess-other', branch_id: 'wt-2', status: 'idle', mcp_token: 'tok2' },
            ],
          };
        },
      },
    });

    const { agor_sessions_list } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_list']
    );

    const result = await agor_sessions_list({ branchId: 'wt-1' });
    const parsed = JSON.parse(result.content[0].text);

    expect(findCalls[0]).toMatchObject({ query: { branch_id: 'wt-1', archived: false } });
    expect(parsed.total).toBe(1);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].session_id).toBe('sess-target');
    expect(parsed.data[0]).not.toHaveProperty('mcp_token');
  });

  it('filters boardId using session.branch_board_id instead of legacy sessions.board_id', async () => {
    const findCalls: unknown[] = [];
    const app = makeFakeApp({
      sessions: {
        find: async (params: unknown) => {
          findCalls.push(params);
          return {
            total: 2,
            limit: 10000,
            skip: 0,
            data: [
              {
                session_id: 'sess-on-board',
                branch_id: 'wt-1',
                branch_board_id: 'board-1',
                status: 'idle',
                mcp_token: 'tok1',
              },
              {
                session_id: 'sess-other-board',
                branch_id: 'wt-2',
                branch_board_id: 'board-2',
                status: 'idle',
                mcp_token: 'tok2',
              },
            ],
          };
        },
      },
    });

    const { agor_sessions_list } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_list']
    );

    const result = await agor_sessions_list({ boardId: 'board-1', limit: 10 });
    const parsed = JSON.parse(result.content[0].text);

    expect(findCalls[0]).toMatchObject({
      query: { archived: false, $limit: 10000 },
    });
    expect(findCalls[0]).not.toMatchObject({ query: { board_id: 'board-1' } });
    expect(parsed.total).toBe(1);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].session_id).toBe('sess-on-board');
    expect(parsed.data[0]).not.toHaveProperty('mcp_token');
  });
});

describe('agor_sessions_get', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('redacts mcp_token from the returned session payload', async () => {
    const app = makeFakeApp({
      sessions: {
        get: async (id: string) => ({
          session_id: id,
          branch_id: 'wt-1',
          status: 'idle',
          mcp_token: 'secret-token',
        }),
      },
      'session-mcp-servers': { find: async () => ({ data: [] }) },
    });

    const { agor_sessions_get } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_get']
    );

    const result = await agor_sessions_get({ sessionId: 'sess-target' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.session_id).toBe('sess-target');
    expect(parsed).not.toHaveProperty('mcp_token');
  });
});

describe('agor_sessions_create', () => {
  const baseBranch = {
    branch_id: 'wt-1',
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
    vi.doMock('../../utils/branch-inspect.js', () => ({
      inspectBranchViaExecutor: async () => ({ currentSha: 'sha-abc', currentRef: 'main' }),
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
      branches: { get: async () => baseBranch },
      sessions: {
        create: async (data: unknown) => {
          sessionCreates.push(data);
          return {
            session_id: 'sess-new',
            mcp_token: 'secret-token',
            ...(data as Record<string, unknown>),
          };
        },
        get: async (id: string) => ({
          session_id: id,
          branch_id: 'wt-1',
          genealogy: { children: [] },
        }),
        patch: async () => ({}),
      },
      '/sessions/:id/mcp-servers': { create: async () => ({}) },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );

    const result = await agor_sessions_create({
      branchId: 'wt-1',
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

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.session).not.toHaveProperty('mcp_token');
  });

  it('falls back to user default modelConfig when none is explicitly provided', async () => {
    const sessionCreates: unknown[] = [];
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      branches: { get: async () => baseBranch },
      sessions: {
        create: async (data: unknown) => {
          sessionCreates.push(data);
          return { session_id: 'sess-new', ...(data as Record<string, unknown>) };
        },
        get: async (id: string) => ({
          session_id: id,
          branch_id: 'wt-1',
          genealogy: { children: [] },
        }),
        patch: async () => ({}),
      },
      '/sessions/:id/mcp-servers': { create: async () => ({}) },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );

    await agor_sessions_create({
      branchId: 'wt-1',
      agenticTool: 'claude-code',
      // no modelConfig
    });

    const created = sessionCreates[0] as Record<string, any>;
    expect(created.model_config.model).toBe('claude-sonnet-4-6'); // user default
    expect(created.model_config.effort).toBe('medium');
  });

  it('attaches explicit mcpServerIds via the /sessions/:id/mcp-servers route (Bug 1)', async () => {
    // Regression: previously called the flat `session-mcp-servers` service which
    // is read-only (find-only), so every attach silently failed with
    // "ctx.app.service(...).create is not a function". The correct surface is
    // the session-scoped REST route with `{ mcpServerId }` in the body and
    // `route: { id: <session_id> }` in the params.
    const attachCalls: Array<{ data: any; params: any }> = [];
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      branches: { get: async () => baseBranch },
      sessions: {
        create: async (data: unknown) => ({
          session_id: 'sess-new',
          ...(data as Record<string, unknown>),
        }),
        get: async (id: string) => ({
          session_id: id,
          branch_id: 'wt-1',
          genealogy: { children: [] },
        }),
        patch: async () => ({}),
      },
      '/sessions/:id/mcp-servers': {
        create: async (data: unknown, params: unknown) => {
          attachCalls.push({ data, params });
          return data;
        },
      },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );

    const result = await agor_sessions_create({
      branchId: 'wt-1',
      agenticTool: 'claude-code',
      mcpServerIds: ['short-id-1', 'short-id-2'],
    });

    expect(attachCalls).toHaveLength(2);
    // resolveMcpServerId mock prefixes with 'full-'
    expect(attachCalls[0].data.mcpServerId).toBe('full-short-id-1');
    expect(attachCalls[0].params.route.id).toBe('sess-new');
    expect(attachCalls[1].data.mcpServerId).toBe('full-short-id-2');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.mcpAttachFailures).toBeUndefined();
  });

  it('surfaces attach failures in the response when caller explicitly requested mcpServerIds', async () => {
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      branches: { get: async () => baseBranch },
      sessions: {
        create: async () => ({ session_id: 'sess-new' }),
        get: async (id: string) => ({
          session_id: id,
          branch_id: 'wt-1',
          genealogy: { children: [] },
        }),
        patch: async () => ({}),
      },
      '/sessions/:id/mcp-servers': {
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
      branchId: 'wt-1',
      agenticTool: 'claude-code',
      mcpServerIds: ['short-id-1'],
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.mcpAttachFailures).toHaveLength(1);
    expect(parsed.mcpAttachFailures[0].mcp_server_id).toBe('full-short-id-1');
    expect(parsed.mcpAttachFailures[0].reason).toContain('RBAC');
  });

  it('silently skips (does not surface) attach failures for inherited mcpServerIds', async () => {
    const branchWithMcps = {
      ...baseBranch,
      mcp_server_ids: ['inherited-1'],
    };
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      branches: { get: async () => branchWithMcps },
      sessions: {
        create: async () => ({ session_id: 'sess-new' }),
        get: async (id: string) => ({
          session_id: id,
          branch_id: 'wt-1',
          genealogy: { children: [] },
        }),
        patch: async () => ({}),
      },
      '/sessions/:id/mcp-servers': {
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
      branchId: 'wt-1',
      agenticTool: 'claude-code',
      // no explicit mcpServerIds → inherits from branch
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.mcpAttachFailures).toBeUndefined();
  });

  it('auto-links to calling session when ctx.sessionId is set', async () => {
    const patchCalls: Array<{ id: unknown; data: unknown }> = [];
    const sessionCreates: unknown[] = [];
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      branches: { get: async () => baseBranch },
      sessions: {
        create: async (data: unknown) => {
          sessionCreates.push(data);
          return { session_id: 'sess-new', ...(data as Record<string, unknown>) };
        },
        get: async (id: string) => ({
          session_id: id,
          branch_id: 'wt-1',
          genealogy: { children: ['existing-child'] },
        }),
        patch: async (id: unknown, data: unknown) => {
          patchCalls.push({ id, data });
          return {};
        },
      },
      '/sessions/:id/mcp-servers': { create: async () => ({}) },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );

    const result = await agor_sessions_create({
      branchId: 'wt-1',
      agenticTool: 'claude-code',
    });

    // New session genealogy should reference the calling session as parent
    const created = sessionCreates[0] as Record<string, any>;
    expect(created.genealogy.parent_session_id).toBe('sess-caller');

    // Parent's children list should be updated to include the new session
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe('sess-caller');
    const patchData = patchCalls[0].data as Record<string, any>;
    expect(patchData.genealogy.children).toContain('sess-new');
    expect(patchData.genealogy.children).toContain('existing-child');

    // Note in response should mention the parent link
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.note).toContain('sess-caller');
  });

  it('does not set parent_session_id when called without session context', async () => {
    const sessionCreates: unknown[] = [];
    const patchCalls: unknown[] = [];
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      branches: { get: async () => baseBranch },
      sessions: {
        create: async (data: unknown) => {
          sessionCreates.push(data);
          return { session_id: 'sess-new', ...(data as Record<string, unknown>) };
        },
        patch: async (id: unknown, data: unknown) => {
          patchCalls.push({ id, data });
          return {};
        },
      },
      '/sessions/:id/mcp-servers': { create: async () => ({}) },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1' }, // no sessionId
      ['agor_sessions_create']
    );

    await agor_sessions_create({
      branchId: 'wt-1',
      agenticTool: 'claude-code',
    });

    const created = sessionCreates[0] as Record<string, any>;
    expect(created.genealogy.parent_session_id).toBeUndefined();
    expect(created.callback_config).toBeUndefined();
    expect(patchCalls).toHaveLength(0);
  });

  it('respects explicit parentSessionId when provided', async () => {
    const sessionCreates: unknown[] = [];
    const patchCalls: Array<{ id: unknown; data: unknown }> = [];
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      branches: { get: async () => baseBranch },
      sessions: {
        create: async (data: unknown) => {
          sessionCreates.push(data);
          return { session_id: 'sess-new', ...(data as Record<string, unknown>) };
        },
        get: async (id: string) => ({
          session_id: id,
          branch_id: 'wt-1',
          genealogy: { children: [] },
        }),
        patch: async (id: unknown, data: unknown) => {
          patchCalls.push({ id, data });
          return {};
        },
      },
      '/sessions/:id/mcp-servers': { create: async () => ({}) },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );

    await agor_sessions_create({
      branchId: 'wt-1',
      agenticTool: 'claude-code',
      parentSessionId: 'sess-explicit-parent',
    });

    const created = sessionCreates[0] as Record<string, any>;
    // Explicit value overrides ctx.sessionId
    expect(created.genealogy.parent_session_id).toBe('sess-explicit-parent');
    expect(patchCalls[0].id).toBe('sess-explicit-parent');
  });

  it('creates root session (no parent) when parentSessionId: null is passed', async () => {
    const sessionCreates: unknown[] = [];
    const patchCalls: unknown[] = [];
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      branches: { get: async () => baseBranch },
      sessions: {
        create: async (data: unknown) => {
          sessionCreates.push(data);
          return { session_id: 'sess-new', ...(data as Record<string, unknown>) };
        },
        patch: async (...args: unknown[]) => {
          patchCalls.push(args);
          return {};
        },
      },
      '/sessions/:id/mcp-servers': { create: async () => ({}) },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );

    await agor_sessions_create({
      branchId: 'wt-1',
      agenticTool: 'claude-code',
      parentSessionId: null,
    });

    const created = sessionCreates[0] as Record<string, any>;
    expect(created.genealogy.parent_session_id).toBeUndefined();
    // No patch to update a parent's children list
    expect(patchCalls).toHaveLength(0);
  });

  it('does not auto-link to the calling session when creating in a different branch', async () => {
    const sessionCreates: unknown[] = [];
    const patchCalls: unknown[] = [];
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      branches: { get: async () => ({ ...baseBranch, branch_id: 'wt-target' }) },
      sessions: {
        create: async (data: unknown) => {
          sessionCreates.push(data);
          return { session_id: 'sess-new', ...(data as Record<string, unknown>) };
        },
        get: async (id: string) => ({
          session_id: id,
          branch_id: 'wt-caller',
          genealogy: { children: ['existing-child'] },
        }),
        patch: async (...args: unknown[]) => {
          patchCalls.push(args);
          return {};
        },
      },
      '/sessions/:id/mcp-servers': { create: async () => ({}) },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );

    const result = await agor_sessions_create({
      branchId: 'wt-target',
      agenticTool: 'claude-code',
    });

    const created = sessionCreates[0] as Record<string, any>;
    expect(created.genealogy.parent_session_id).toBeUndefined();
    expect(created.callback_config).toMatchObject({
      enabled: false,
      callback_session_id: 'sess-caller',
      callback_created_by: 'user-1',
    });
    expect(patchCalls).toHaveLength(0);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.note).toContain('target branch differs');
    expect(parsed.remoteRelationship).toMatchObject({
      source_session_id: 'sess-caller',
      target_session_id: 'sess-new',
      relationship_type: 'remote_create',
      callback_enabled: false,
      callback_session_id: 'sess-caller',
    });
  });

  it('enables remote relationship callbacks using the source session as fallback target', async () => {
    const patchCalls: unknown[] = [];
    const getCalls: string[] = [];
    const app = makeFakeApp({
      sessions: {
        get: async (id: string) => {
          getCalls.push(id);
          return {
            session_id: id,
            branch_id: id === 'sess-source' ? 'wt-source' : 'wt-target',
            callback_config: {},
          };
        },
        patch: async (...args: unknown[]) => {
          patchCalls.push(args);
          return {};
        },
      },
    });

    const { agor_session_relationships_set_callback } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_session_relationships_set_callback']
    );

    await agor_session_relationships_set_callback({
      relationshipId: 'rel-1',
      callbackEnabled: true,
    });

    expect(getCalls).toEqual(['sess-source', 'sess-target']);
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toMatchObject([
      'sess-target',
      {
        callback_config: {
          enabled: true,
          callback_session_id: 'sess-source',
        },
      },
      {
        _skipRelationshipCallbackSync: true,
      },
    ]);
  });

  it('rejects explicit parentSessionId from a different branch', async () => {
    const sessionCreates: unknown[] = [];
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      branches: { get: async () => ({ ...baseBranch, branch_id: 'wt-target' }) },
      sessions: {
        create: async (data: unknown) => {
          sessionCreates.push(data);
          return { session_id: 'sess-new', ...(data as Record<string, unknown>) };
        },
        get: async (id: string) => ({
          session_id: id,
          branch_id: 'wt-other',
          genealogy: { children: [] },
        }),
        patch: async () => ({}),
      },
      '/sessions/:id/mcp-servers': { create: async () => ({}) },
    });

    const { agor_sessions_create } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );

    await expect(
      agor_sessions_create({
        branchId: 'wt-target',
        agenticTool: 'claude-code',
        parentSessionId: 'sess-explicit-parent',
      })
    ).rejects.toThrow(/target branch/i);
    expect(sessionCreates).toHaveLength(0);
  });
});

describe('agor_sessions_spawn', () => {
  beforeEach(() => {
    vi.doMock('../../utils/branch-inspect.js', () => ({
      inspectBranchViaExecutor: async () => ({ currentSha: 'sha-abc', currentRef: 'main' }),
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
        // Returns a Task-shaped object — the route returns the entity directly.
        create: async () => ({ task_id: 't1', status: 'running' }),
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
        // Returns a Task-shaped object — the route returns the entity directly.
        create: async () => ({ task_id: 't1', status: 'running' }),
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
    vi.doMock('../../utils/branch-inspect.js', () => ({
      inspectBranchViaExecutor: async () => ({ currentSha: 'sha-abc', currentRef: 'main' }),
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
        // Returns a Task-shaped object — the route returns the entity directly.
        create: async () => ({ task_id: 't1', status: 'running' }),
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

describe('MCP session input validation clarity', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('rejects missing required ids with field-specific messages', async () => {
    const tools = await registerAndCaptureTools(
      { app: {}, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_get']
    );

    const result = tools.agor_sessions_get.cfg.inputSchema!.safeParse({});

    expect(result.success).toBe(false);
    expect(String(result.error.message)).toMatch(/sessionId is required and must be a string/);
  });

  it('rejects empty required prompts and optional titles when provided', async () => {
    const tools = await registerAndCaptureTools(
      { app: {}, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_prompt']
    );

    const emptyPrompt = tools.agor_sessions_prompt.cfg.inputSchema!.safeParse({
      sessionId: 'sess-target',
      mode: 'continue',
      prompt: '',
    });
    expect(emptyPrompt.success).toBe(false);
    expect(String(emptyPrompt.error.message)).toMatch(/prompt cannot be empty/);

    const emptyTitle = tools.agor_sessions_prompt.cfg.inputSchema!.safeParse({
      sessionId: 'sess-target',
      mode: 'fork',
      prompt: 'do work',
      title: '',
    });
    expect(emptyTitle.success).toBe(false);
    expect(String(emptyTitle.error.message)).toMatch(/title cannot be empty/);
  });

  it('rejects invalid pagination limits before handlers run', async () => {
    const tools = await registerAndCaptureTools(
      { app: {}, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_list']
    );

    const result = tools.agor_sessions_list.cfg.inputSchema!.safeParse({ limit: 0 });

    expect(result.success).toBe(false);
    expect(String(result.error.message)).toMatch(/limit must be greater than 0/);
  });
});

describe('modelConfig schema (string shorthand coercion)', () => {
  // The MCP-tool boundary historically required `modelConfig` as a structured
  // `{ mode, model, effort, advisorModel, provider }` object. Several MCP
  // clients silently mangle nested objects in tool args, and asking an agent to
  // construct that shape just to pin a model is hostile UX. We now accept either
  // form. The schema validates the union without transforming (so `toJSONSchema`
  // works); handlers normalize the string form to `{ model: <id> }` internally.
  it('accepts a plain string for modelConfig', async () => {
    const tools = await registerAndCaptureTools(
      { app: {}, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );
    const schema = tools.agor_sessions_create.cfg.inputSchema!;

    const parsed = schema.parse({
      branchId: 'wt-1',
      agenticTool: 'claude-code',
      modelConfig: 'claude-opus-4-6',
    }) as Record<string, unknown>;

    // Schema validates but does NOT transform — coercion happens in handlers
    // so the JSON Schema export (used by `agor_get_tool_details`)
    // doesn't blow up on a Zod transform.
    expect(parsed.modelConfig).toBe('claude-opus-4-6');
  });

  it('passes through the full object form unchanged', async () => {
    const tools = await registerAndCaptureTools(
      { app: {}, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );
    const schema = tools.agor_sessions_create.cfg.inputSchema!;

    const parsed = schema.parse({
      branchId: 'wt-1',
      agenticTool: 'claude-code',
      modelConfig: { mode: 'alias', model: 'claude-sonnet-4-6', effort: 'high' },
    }) as Record<string, unknown>;

    expect(parsed.modelConfig).toEqual({
      mode: 'alias',
      model: 'claude-sonnet-4-6',
      effort: 'high',
    });
  });

  it('rejects an empty string (would otherwise silently fall through to user default)', async () => {
    const tools = await registerAndCaptureTools(
      { app: {}, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );
    const schema = tools.agor_sessions_create.cfg.inputSchema!;

    expect(() =>
      schema.parse({
        branchId: 'wt-1',
        agenticTool: 'claude-code',
        modelConfig: '',
      })
    ).toThrow();
  });

  it('end-to-end: string modelConfig reaches session.model_config.model', async () => {
    const sessionCreates: unknown[] = [];
    const app = makeFakeApp({
      users: {
        get: async () => ({
          user_id: 'user-1',
          unix_username: 'alice',
          default_agentic_config: {},
        }),
      },
      branches: {
        get: async () => ({ branch_id: 'wt-1', path: '/tmp/wt', mcp_server_ids: [] }),
      },
      sessions: {
        create: async (data: unknown) => {
          sessionCreates.push(data);
          return { session_id: 'sess-new', ...(data as Record<string, unknown>) };
        },
        get: async (id: string) => ({
          session_id: id,
          branch_id: 'wt-1',
          genealogy: { children: [] },
        }),
        patch: async () => ({}),
      },
      '/sessions/:id/mcp-servers': { create: async () => ({}) },
    });
    vi.doMock('@agor/core/git', () => ({
      getGitState: async () => 'sha',
      getCurrentBranch: async () => 'main',
    }));
    vi.doMock('@agor/core/types', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('@agor/core/types');
      return { ...actual, getDefaultPermissionMode: () => 'acceptEdits' };
    });
    vi.doMock('@agor/core/utils/permission-mode-mapper', () => ({
      mapPermissionMode: (m: string) => m,
    }));

    const tools = await registerAndCaptureTools(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );
    const schema = tools.agor_sessions_create.cfg.inputSchema!;

    // Parse with Zod (string → object), then dispatch to handler
    const parsed = schema.parse({
      branchId: 'wt-1',
      agenticTool: 'claude-code',
      modelConfig: 'claude-opus-4-6',
    }) as Record<string, unknown>;
    await tools.agor_sessions_create.cb(parsed);

    expect(sessionCreates).toHaveLength(1);
    const created = sessionCreates[0] as Record<string, any>;
    expect(created.model_config.model).toBe('claude-opus-4-6');
    expect(created.model_config.mode).toBe('alias'); // default applied by resolveModelConfig
  });
});

describe('agor_models_list', () => {
  it('returns model registries grouped by agenticTool', async () => {
    const { agor_models_list } = await registerAndCaptureHandlers(
      { app: {}, userId: 'user-1', sessionId: 'sess-1' },
      ['agor_models_list']
    );

    const result = await agor_models_list({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed['claude-code']).toBeDefined();
    expect(parsed.codex).toBeDefined();
    expect(parsed.gemini).toBeDefined();

    expect(parsed['claude-code'].default).toBe('claude-sonnet-4-6');
    expect(Array.isArray(parsed['claude-code'].models)).toBe(true);
    expect(parsed['claude-code'].models[0]).toMatchObject({
      id: expect.any(String),
      displayName: expect.any(String),
    });

    // Sanity: the canonical aliases an agent would want to pin should be discoverable
    const claudeIds = parsed['claude-code'].models.map((m: { id: string }) => m.id);
    expect(claudeIds).toContain('claude-opus-4-6');
    expect(claudeIds).toContain('claude-sonnet-4-6');
  });

  it('filters to a single agenticTool when requested', async () => {
    const { agor_models_list } = await registerAndCaptureHandlers(
      { app: {}, userId: 'user-1', sessionId: 'sess-1' },
      ['agor_models_list']
    );

    const result = await agor_models_list({ agenticTool: 'codex' });
    const parsed = JSON.parse(result.content[0].text);

    expect(Object.keys(parsed)).toEqual(['codex']);
    expect(parsed.codex.models.length).toBeGreaterThan(0);
    expect(parsed.codex.models[0]).toMatchObject({
      id: expect.any(String),
      displayName: expect.any(String),
      description: expect.any(String),
    });
  });
});

describe('inputSchema → JSON Schema conversion (MCP discovery)', () => {
  // Regression: a Zod `.transform()` on `modelConfig` made `toJSONSchema` throw
  // ("Transforms cannot be represented in JSON Schema"). The catch in
  // `mcp/server.ts` then degraded the *entire* containing tool's schema to
  // `{ type: 'object' }`, hiding every parameter from MCP clients calling
  // `agor_get_tool_details`. Keep this test green to ensure the
  // string-or-object union stays JSON-Schema-representable.
  it('produces a non-empty JSON Schema for tools that accept modelConfig', async () => {
    const { toJSONSchema } = await import('zod/v4-mini');
    const tools = await registerAndCaptureTools(
      { app: {}, userId: 'user-1', sessionId: 'sess-1' },
      ['agor_sessions_create', 'agor_sessions_spawn', 'agor_sessions_prompt']
    );

    for (const name of ['agor_sessions_create', 'agor_sessions_spawn', 'agor_sessions_prompt']) {
      const schema = tools[name].cfg.inputSchema!;
      const jsonSchema = toJSONSchema(schema as Parameters<typeof toJSONSchema>[0]) as Record<
        string,
        any
      >;

      // Sanity: real param surface, not the `{ type: 'object' }` fallback
      expect(jsonSchema.type).toBe('object');
      expect(jsonSchema.properties).toBeDefined();
      expect(Object.keys(jsonSchema.properties).length).toBeGreaterThan(1);

      // The modelConfig union should be expressed as anyOf (string | object)
      const mc = jsonSchema.properties.modelConfig;
      expect(mc).toBeDefined();
      expect(Array.isArray(mc.anyOf)).toBe(true);
    }
  });
});

describe('attached_mcp_servers in session-info tools', () => {
  // The catalog (`agor_mcp_servers_list`) and the per-session attachment view
  // are now distinct: catalog = "what could I attach", attached = "what IS
  // attached to this session". This test pins the attachment view onto
  // `agor_sessions_get_current` and `agor_sessions_get`, since previously the
  // only way to read it was a session-biased version of `agor_mcp_servers_list`.
  it('agor_sessions_get_current returns attached_mcp_servers from the junction', async () => {
    const app = makeFakeApp({
      sessions: {
        get: async (id: string) => ({
          session_id: id,
          branch_id: null, // skip branch denormalization for brevity
        }),
      },
      'session-mcp-servers': {
        find: async () => ({ data: [{ mcp_server_id: 'srv-1' }, { mcp_server_id: 'srv-2' }] }),
      },
      'mcp-servers': {
        get: async (id: string) => ({
          mcp_server_id: id,
          name: `name-${id}`,
          display_name: `Display ${id}`,
          transport: 'http',
          enabled: true,
          auth: { type: 'none' },
        }),
      },
    });

    const tools = await registerAndCaptureTools(
      { app, userId: 'user-1', sessionId: 'sess-current' },
      ['agor_sessions_get_current']
    );
    const result = await tools.agor_sessions_get_current.cb({});
    const payload = JSON.parse(result.content[0].text);

    expect(Array.isArray(payload.attached_mcp_servers)).toBe(true);
    expect(payload.attached_mcp_servers).toHaveLength(2);
    expect(payload.attached_mcp_servers[0]).toMatchObject({
      mcp_server_id: 'srv-1',
      name: 'name-srv-1',
      transport: 'http',
      auth_type: 'none',
      oauth_authenticated: true,
      enabled: true,
    });
  });

  it('agor_sessions_get returns attached_mcp_servers for the requested session', async () => {
    const app = makeFakeApp({
      sessions: {
        get: async (id: string) => ({ session_id: id }),
      },
      'session-mcp-servers': {
        find: async (params: { query?: { session_id?: string } }) => ({
          data: params?.query?.session_id === 'sess-other' ? [{ mcp_server_id: 'srv-x' }] : [],
        }),
      },
      'mcp-servers': {
        get: async (id: string) => ({
          mcp_server_id: id,
          name: `name-${id}`,
          transport: 'stdio',
          enabled: true,
          auth: { type: 'none' },
        }),
      },
    });

    const tools = await registerAndCaptureTools(
      { app, userId: 'user-1', sessionId: 'sess-current' },
      ['agor_sessions_get']
    );
    const result = await tools.agor_sessions_get.cb({ sessionId: 'sess-other' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.attached_mcp_servers).toEqual([
      expect.objectContaining({ mcp_server_id: 'srv-x', auth_type: 'none' }),
    ]);
  });
});
