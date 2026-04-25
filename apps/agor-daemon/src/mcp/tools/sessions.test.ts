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

/** Cfg captured alongside the handler — includes inputSchema for tests that
 * exercise Zod validation/coercion (the fake server below bypasses the SDK's
 * automatic schema parsing). */
type CapturedTool = { cfg: { inputSchema?: { parse: (v: unknown) => unknown } }; cb: ToolHandler };

async function registerAndCaptureTools(
  ctx: {
    app: unknown;
    userId: string;
    sessionId: string;
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
  ctx: { app: unknown; userId: string; sessionId: string },
  toolNames: string[]
): Promise<Record<string, ToolHandler>> {
  const tools = await registerAndCaptureTools(ctx, toolNames);
  return Object.fromEntries(Object.entries(tools).map(([name, { cb }]) => [name, cb]));
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
      '/sessions/:id/mcp-servers': { create: async () => ({}) },
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
      '/sessions/:id/mcp-servers': { create: async () => ({}) },
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

  it('attaches explicit mcpServerIds via the /sessions/:id/mcp-servers route (Bug 1)', async () => {
    // Regression: previously called the flat `session-mcp-servers` service which
    // is read-only (find-only), so every attach silently failed with
    // "ctx.app.service(...).create is not a function". The correct surface is
    // the session-scoped REST route with `{ mcpServerId }` in the body and
    // `route: { id: <session_id> }` in the params.
    const attachCalls: Array<{ data: any; params: any }> = [];
    const app = makeFakeApp({
      users: { get: async () => baseUser },
      worktrees: { get: async () => baseWorktree },
      sessions: {
        create: async (data: unknown) => ({
          session_id: 'sess-new',
          ...(data as Record<string, unknown>),
        }),
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
      worktreeId: 'wt-1',
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
      worktrees: { get: async () => baseWorktree },
      sessions: {
        create: async () => ({ session_id: 'sess-new' }),
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

describe('modelConfig schema (string shorthand coercion)', () => {
  // The MCP-tool boundary historically required `modelConfig` as a structured
  // `{ mode, model, effort, provider }` object. Several MCP clients silently
  // mangle nested objects in tool args, and asking an agent to construct that
  // shape just to pin a model is hostile UX. We now accept either form. The
  // schema validates the union without transforming (so `toJSONSchema` works);
  // handlers normalize the string form to `{ model: <id> }` internally.
  it('accepts a plain string for modelConfig', async () => {
    const tools = await registerAndCaptureTools(
      { app: {}, userId: 'user-1', sessionId: 'sess-caller' },
      ['agor_sessions_create']
    );
    const schema = tools.agor_sessions_create.cfg.inputSchema!;

    const parsed = schema.parse({
      worktreeId: 'wt-1',
      agenticTool: 'claude-code',
      modelConfig: 'claude-opus-4-6',
    }) as Record<string, unknown>;

    // Schema validates but does NOT transform — coercion happens in handlers
    // so the JSON Schema export (used by `agor_search_tools(detail:"full")`)
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
      worktreeId: 'wt-1',
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
        worktreeId: 'wt-1',
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
      worktrees: {
        get: async () => ({ worktree_id: 'wt-1', path: '/tmp/wt', mcp_server_ids: [] }),
      },
      sessions: {
        create: async (data: unknown) => {
          sessionCreates.push(data);
          return { session_id: 'sess-new', ...(data as Record<string, unknown>) };
        },
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
      worktreeId: 'wt-1',
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
  // `agor_search_tools(detail:"full")`. Keep this test green to ensure the
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
          worktree_id: null, // skip worktree denormalization for brevity
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
