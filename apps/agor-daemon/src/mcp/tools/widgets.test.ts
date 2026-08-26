/**
 * agor_widgets_request_env_vars MCP tool — handler tests.
 *
 * Covers Part 2 §7 of the design doc:
 *   - Normal path: creates a `widget_request` message with status 'pending',
 *     returns `{ widget_id, status: 'requested' }`.
 *   - `already_present` short-circuit: when the user already has all names
 *     set in GLOBAL scope, marks the widget `already_present` and queues
 *     an auto-resume task with a "values already configured" prompt —
 *     without rendering a form.
 *   - Negative short-circuit: missing one name → falls back to the normal
 *     pending path.
 *   - `auto_resume: false` + `already_present`: status flips but no task
 *     creation.
 */

import type { MessageID } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/append-system-message.js', () => ({
  appendSystemMessage: vi.fn(),
}));

import { appendSystemMessage } from '../../utils/append-system-message.js';
import { widgetAutoResumeTaskId } from '../../utils/durable-task-id.js';
import { registerWidgetTools } from './widgets.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

type CapturedTool = {
  cfg: { description?: string; inputSchema?: { safeParse: (v: unknown) => unknown } };
  cb: ToolHandler;
};

function registerAndCapture(ctx: {
  app: unknown;
  db?: unknown;
  userId: string;
  sessionId: string;
  /** Authenticated caller role — defaults to 'member'. Set 'admin' to exercise
   * the gateway-token admin gate. */
  role?: string;
  baseServiceParams?: Parameters<typeof registerWidgetTools>[1]['baseServiceParams'];
}): Record<string, CapturedTool> {
  const captured: Record<string, CapturedTool> = {};
  const fakeServer = {
    registerTool: (name: string, cfg: unknown, cb: ToolHandler) => {
      captured[name] = { cfg: cfg as CapturedTool['cfg'], cb };
    },
  } as unknown as McpServer;

  registerWidgetTools(fakeServer, {
    app: ctx.app as unknown as Parameters<typeof registerWidgetTools>[1]['app'],
    db: (ctx.db ?? {}) as Parameters<typeof registerWidgetTools>[1]['db'],
    userId: ctx.userId as unknown as Parameters<typeof registerWidgetTools>[1]['userId'],
    sessionId: ctx.sessionId as unknown as Parameters<typeof registerWidgetTools>[1]['sessionId'],
    authenticatedUser: { user_id: ctx.userId, role: ctx.role ?? 'member' } as unknown as Parameters<
      typeof registerWidgetTools
    >[1]['authenticatedUser'],
    baseServiceParams: ctx.baseServiceParams ?? {},
  });
  return captured;
}

interface ServiceCall {
  service: string;
  method: string;
  args: unknown[];
}

interface FakeTask {
  task_id: string;
  status: string;
  created_at?: string;
  started_at?: string;
  message_range?: { start_index: number; end_index: number };
}

function makeApp(opts: {
  sessionCreator: string;
  gatewayChannel?: {
    id: string;
    name: string;
    channel_type: string;
    target_branch_id: string;
    config: Record<string, unknown>;
  };
  creatorEnvVars?: Record<string, { set: true; scope: 'global' | 'session' }>;
  /**
   * The session's tasks. The fake below applies the same exact status, sort,
   * skip, and limit query semantics used by the host-Task selector.
   */
  sessionTasks?: FakeTask[] | null;
}): {
  app: unknown;
  calls: ServiceCall[];
} {
  const calls: ServiceCall[] = [];
  const defaultTasks: FakeTask[] = [
    {
      task_id: 'task-host-1',
      status: 'running',
      created_at: '2026-05-19T00:00:00.000Z',
      message_range: { start_index: 0, end_index: 4 },
    },
  ];
  const sessionTasks = opts.sessionTasks === undefined ? defaultTasks : (opts.sessionTasks ?? []);
  const tasksById = new Map(sessionTasks.map((t) => [t.task_id, t]));
  const services: Record<string, Record<string, (...args: unknown[]) => unknown>> = {
    sessions: {
      get: async (...args: unknown[]) => {
        calls.push({ service: 'sessions', method: 'get', args });
        return { session_id: 'sess-1', branch_id: 'wt-1', created_by: opts.sessionCreator };
      },
    },
    users: {
      get: async (...args: unknown[]) => {
        calls.push({ service: 'users', method: 'get', args });
        return {
          user_id: args[0],
          env_vars: opts.creatorEnvVars ?? {},
        };
      },
    },
    tasks: {
      find: async (...args: unknown[]) => {
        calls.push({ service: 'tasks', method: 'find', args });
        const query = ((args[0] as { query?: Record<string, unknown> } | undefined)?.query ??
          {}) as Record<string, unknown>;
        const filtered = query.status
          ? sessionTasks.filter((task) => task.status === query.status)
          : [...sessionTasks];
        const sort = (query.$sort ?? {}) as Record<string, 1 | -1>;
        const sortEntries = Object.entries(sort);
        if (sortEntries.length > 0) {
          filtered.sort((left, right) => {
            for (const [field, direction] of sortEntries) {
              const a = String(left[field as keyof FakeTask] ?? '');
              const b = String(right[field as keyof FakeTask] ?? '');
              const comparison = a.localeCompare(b);
              if (comparison !== 0) return comparison * direction;
            }
            return 0;
          });
        }
        const skip = typeof query.$skip === 'number' ? query.$skip : 0;
        const limit = typeof query.$limit === 'number' ? query.$limit : filtered.length;
        return {
          data: filtered.slice(skip, skip + limit),
          total: filtered.length,
          limit,
          skip,
        };
      },
      get: async (...args: unknown[]) => {
        calls.push({ service: 'tasks', method: 'get', args });
        const id = args[0] as string;
        const t = tasksById.get(id);
        if (!t) throw new Error(`task not found: ${id}`);
        return t;
      },
      patch: async (...args: unknown[]) => {
        calls.push({ service: 'tasks', method: 'patch', args });
        const id = args[0] as string;
        const t = tasksById.get(id);
        return { ...t, ...(args[1] as Record<string, unknown>) };
      },
    },
    '/sessions/:id/prompt': {
      create: async (...args: unknown[]) => {
        calls.push({ service: '/sessions/:id/prompt', method: 'create', args });
        return { task_id: 'task-stub' };
      },
    },
  };
  if (opts.gatewayChannel) {
    services['gateway-channels'] = {
      get: async (...args: unknown[]) => {
        calls.push({ service: 'gateway-channels', method: 'get', args });
        return opts.gatewayChannel;
      },
    };
  }
  return {
    app: {
      service(name: string) {
        const svc = services[name];
        if (!svc) throw new Error(`Unexpected service call: ${name}`);
        return svc;
      },
    },
    calls,
  };
}

describe('agor_widgets_request_env_vars', () => {
  const appendStub = appendSystemMessage as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    appendStub.mockReset();
    // Default: return a freshly-created widget message row.
    appendStub.mockImplementation(
      async (opts: {
        content: string;
        messageId?: MessageID;
        metadata?: Record<string, unknown>;
      }) => ({
        message_id: opts.messageId ?? ('widget-msg-1' as MessageID),
        session_id: 'sess-1',
        type: 'widget_request',
        role: 'system',
        index: 0,
        timestamp: '2026-05-19T00:00:00.000Z',
        content: opts.content,
        content_preview: opts.content,
        metadata: opts.metadata,
      })
    );
  });

  it('normal path: creates a pending widget_request and returns status "requested"', async () => {
    const { app, calls } = makeApp({ sessionCreator: 'user-creator' });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });

    const handler = captured.agor_widgets_request_env_vars.cb;
    const res = await handler({
      names: ['HUBSPOT_API_KEY'],
      reason: 'call hubspot',
      auto_resume: true,
    });

    expect(appendStub).toHaveBeenCalledTimes(1);
    const appendArgs = appendStub.mock.calls[0][0];
    expect(appendArgs.type).toBe('widget_request');
    expect(appendArgs.metadata.widget.status).toBe('pending');
    expect(appendArgs.metadata.widget.widget_type).toBe('env_vars');

    // Returns the new widget_id + "requested"
    const text = JSON.parse(res.content[0].text);
    expect(text.status).toBe('requested');
    expect(text.widget_id).toBe(appendArgs.metadata.widget.widget_id);
    expect(text.widget_id).not.toBe('pending');

    // No auto-resume task on the normal path — it fires only after the user
    // submits/dismisses, via the resolve handler.
    expect(calls.find((c) => c.service === '/sessions/:id/prompt')).toBeUndefined();

    // Regression: the widget message MUST be bound to the host task — the
    // transcript renderer loads messages by `task_id`, so an orphaned widget
    // is invisible in the conversation pane.
    expect(appendArgs.taskId).toBe('task-host-1');

    // And the host task's message_range.end_index should be extended to cover
    // the newly-inserted widget message.
    const taskPatch = calls.find((c) => c.service === 'tasks' && c.method === 'patch');
    expect(taskPatch).toBeDefined();
    const patchBody = taskPatch?.args[1] as {
      message_range: { end_index: number };
    };
    expect(patchBody.message_range.end_index).toBe(0); // index of the appended widget
  });

  it('generates the persisted widget id before the MCP message create', async () => {
    const { app, calls } = makeApp({ sessionCreator: 'user-creator' });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
      baseServiceParams: {
        user: { user_id: 'user-creator', role: 'member' },
        authenticated: true,
        provider: 'mcp',
        tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
      },
      db: { run: vi.fn() },
    });

    const res = await captured.agor_widgets_request_env_vars.cb({
      names: ['HUBSPOT_API_KEY'],
      reason: 'call hubspot',
      auto_resume: true,
    });

    const appendArgs = appendStub.mock.calls[0][0];
    const widgetId = appendArgs.metadata.widget.widget_id;
    expect(appendArgs.messageId).toBe(widgetId);
    expect(widgetId).not.toBe('pending');
    expect(
      calls.find((call) => call.service === 'messages' && call.method === 'patch')
    ).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      widget_id: widgetId,
      status: 'requested',
    });
  });

  it('normalizes requested names before storing widget metadata and preview text', async () => {
    const { app } = makeApp({ sessionCreator: 'user-creator' });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });

    const handler = captured.agor_widgets_request_env_vars.cb;
    await handler({
      names: ['STRIPE_SECRET_KEY', 'HUBSPOT_API_KEY'],
      reason: 'two integrations',
      auto_resume: true,
    });

    const appendArgs = appendStub.mock.calls[0][0];
    expect(appendArgs.metadata.widget.params.names).toEqual([
      'HUBSPOT_API_KEY',
      'STRIPE_SECRET_KEY',
    ]);
    expect(appendArgs.content).toContain('HUBSPOT_API_KEY, STRIPE_SECRET_KEY');
    expect(appendArgs.contentPreview).toBe('Widget: env_vars (HUBSPOT_API_KEY, STRIPE_SECRET_KEY)');
  });

  it('does not persist server-derived availability in widget params', async () => {
    const { app } = makeApp({
      sessionCreator: 'user-creator',
      creatorEnvVars: { HUBSPOT_API_KEY: { set: true, scope: 'global' } },
    });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });

    const handler = captured.agor_widgets_request_env_vars.cb;
    await handler({
      names: ['STRIPE_SECRET_KEY', 'HUBSPOT_API_KEY'],
      reason: 'two integrations',
      auto_resume: true,
    });

    const appendArgs = appendStub.mock.calls[0][0];
    expect(appendArgs.metadata.widget.status).toBe('pending');
    expect(appendArgs.metadata.widget.params.existing).toBeUndefined();
    expect(JSON.stringify(appendArgs.metadata.widget.params)).not.toContain('secret');
  });

  it('stores safe per-variable display metadata in widget params', async () => {
    const { app } = makeApp({ sessionCreator: 'user-creator' });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });

    const handler = captured.agor_widgets_request_env_vars.cb;
    await handler({
      names: ['API_TOKEN'],
      reason: 'call api',
      variable_metadata: {
        API_TOKEN: {
          description: 'From the API dashboard.',
          placeholder: 'Paste token',
          format_hint: 'Starts with tok_',
          input_type: 'text',
        },
      },
      auto_resume: true,
    });

    const appendArgs = appendStub.mock.calls[0][0];
    expect(appendArgs.metadata.widget.params.variable_metadata).toEqual({
      API_TOKEN: {
        description: 'From the API dashboard.',
        placeholder: 'Paste token',
        format_hint: 'Starts with tok_',
        input_type: 'text',
      },
    });
  });

  it('gracefully omits taskId when no task exists yet (e.g. brand-new session)', async () => {
    const { app, calls } = makeApp({
      sessionCreator: 'user-creator',
      sessionTasks: [],
    });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });

    const handler = captured.agor_widgets_request_env_vars.cb;
    await handler({
      names: ['HUBSPOT_API_KEY'],
      reason: 'call hubspot',
      auto_resume: true,
    });

    const appendArgs = appendStub.mock.calls[0][0];
    expect(appendArgs.taskId).toBeUndefined();
    // No task to patch
    expect(calls.find((c) => c.service === 'tasks' && c.method === 'patch')).toBeUndefined();
  });

  it('binds to the RUNNING task, not the oldest, when several completed tasks exist', async () => {
    // Repro for the bug from initial live test: TasksService.find short-circuits
    // on session_id and returns ALL session tasks in created_at ASC, ignoring
    // the status filter. The fix must filter to active statuses in-process.
    const { app, calls } = makeApp({
      sessionCreator: 'user-creator',
      sessionTasks: [
        {
          task_id: 'task-bootstrap',
          status: 'completed',
          created_at: '2026-05-19T22:21:29.000Z',
          message_range: { start_index: 0, end_index: 11 },
        },
        {
          task_id: 'task-first-prompt',
          status: 'completed',
          created_at: '2026-05-20T01:58:10.000Z',
          message_range: { start_index: 12, end_index: 16 },
        },
        {
          task_id: 'task-current',
          status: 'running',
          created_at: '2026-05-20T02:12:35.000Z',
          message_range: { start_index: 17, end_index: 18 },
        },
      ],
    });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });

    const handler = captured.agor_widgets_request_env_vars.cb;
    await handler({
      names: ['HUBSPOT_API_KEY'],
      reason: 'call hubspot',
      auto_resume: true,
    });

    const appendArgs = appendStub.mock.calls[0][0];
    expect(appendArgs.taskId).toBe('task-current'); // NOT 'task-bootstrap'

    // And the patch extends the CURRENT task's range, not the bootstrap's.
    const taskPatch = calls.find((c) => c.service === 'tasks' && c.method === 'patch');
    expect(taskPatch?.args[0]).toBe('task-current');
  });

  it('falls back to most-recent task when no task is RUNNING', async () => {
    // Defensive: the MCP tool is invoked by a running agent, so this shouldn't
    // normally happen — but if all tasks are somehow non-active, pick the
    // most recent so the widget still renders SOMEWHERE rather than nowhere.
    const { app } = makeApp({
      sessionCreator: 'user-creator',
      sessionTasks: [
        {
          task_id: 'task-old',
          status: 'completed',
          created_at: '2026-05-19T22:21:29.000Z',
          message_range: { start_index: 0, end_index: 11 },
        },
        {
          task_id: 'task-newer',
          status: 'completed',
          created_at: '2026-05-20T02:12:35.000Z',
          message_range: { start_index: 12, end_index: 18 },
        },
      ],
    });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });

    const handler = captured.agor_widgets_request_env_vars.cb;
    await handler({
      names: ['HUBSPOT_API_KEY'],
      reason: 'call hubspot',
      auto_resume: true,
    });

    const appendArgs = appendStub.mock.calls[0][0];
    expect(appendArgs.taskId).toBe('task-newer');
  });

  it('already_present short-circuit: status flips, auto-resume task queued, no form-render', async () => {
    const { app, calls } = makeApp({
      sessionCreator: 'user-creator',
      creatorEnvVars: { HUBSPOT_API_KEY: { set: true, scope: 'global' } },
    });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });

    const handler = captured.agor_widgets_request_env_vars.cb;
    const res = await handler({
      names: ['HUBSPOT_API_KEY'],
      reason: 'call hubspot',
      auto_resume: true,
    });

    const text = JSON.parse(res.content[0].text);
    expect(text.status).toBe('already_present');

    // The created message must be marked already_present from the get-go.
    const appendArgs = appendStub.mock.calls[0][0];
    expect(appendArgs.metadata.widget.status).toBe('already_present');

    // The auto-resume task must have been queued with a "already configured" prompt
    const promptCall = calls.find(
      (c) => c.service === '/sessions/:id/prompt' && c.method === 'create'
    );
    expect(promptCall).toBeDefined();
    const promptData = promptCall?.args[0] as {
      prompt: string;
      idempotencyTaskId: string;
      metadata: Record<string, unknown>;
    };
    expect(promptData.prompt).toContain('HUBSPOT_API_KEY');
    expect(promptData.prompt.toLowerCase()).toContain('already configured');
    expect(promptData.metadata.system_authored).toBe(true);
    const widgetId = appendStub.mock.calls[0][0].metadata.widget.widget_id;
    expect(promptData.metadata.widget_id).toBe(widgetId);
    expect(promptData.idempotencyTaskId).toBe(widgetAutoResumeTaskId(widgetId as MessageID));
    expect(promptData.idempotencyTaskId).not.toBe(widgetId);
  });

  it('reads the prompt actor env vars rather than the shared Session owner', async () => {
    const { app, calls } = makeApp({
      sessionCreator: 'session-owner',
      creatorEnvVars: { HUBSPOT_API_KEY: { set: true, scope: 'global' } },
    });
    const captured = registerAndCapture({
      app,
      userId: 'prompt-actor',
      sessionId: 'sess-1',
    });

    const result = await captured.agor_widgets_request_env_vars.cb({
      names: ['HUBSPOT_API_KEY'],
      reason: 'call hubspot',
      auto_resume: true,
    });

    expect(JSON.parse(result.content[0].text).status).toBe('already_present');
    const userLookup = calls.find((call) => call.service === 'users' && call.method === 'get');
    expect(userLookup?.args[0]).toBe('prompt-actor');
  });

  it('does NOT short-circuit when even one requested name is missing', async () => {
    const { app, calls } = makeApp({
      sessionCreator: 'user-creator',
      creatorEnvVars: { HUBSPOT_API_KEY: { set: true, scope: 'global' } },
    });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });

    const handler = captured.agor_widgets_request_env_vars.cb;
    const res = await handler({
      names: ['HUBSPOT_API_KEY', 'STRIPE_SECRET_KEY'],
      reason: 'two integrations',
      auto_resume: true,
    });

    const text = JSON.parse(res.content[0].text);
    expect(text.status).toBe('requested');
    expect(calls.find((c) => c.service === '/sessions/:id/prompt')).toBeUndefined();
  });

  it('does NOT short-circuit when the name is set only in session scope (short-circuit is global-only)', async () => {
    const { app, calls } = makeApp({
      sessionCreator: 'user-creator',
      // Stored under session scope; short-circuit only fires for global.
      creatorEnvVars: { HUBSPOT_API_KEY: { set: true, scope: 'session' } },
    });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });

    const handler = captured.agor_widgets_request_env_vars.cb;
    const res = await handler({
      names: ['HUBSPOT_API_KEY'],
      reason: 'why',
      auto_resume: true,
    });

    const text = JSON.parse(res.content[0].text);
    expect(text.status).toBe('requested');
    expect(calls.find((c) => c.service === '/sessions/:id/prompt')).toBeUndefined();
  });

  it('already_present + auto_resume:false skips the task creation', async () => {
    const { app, calls } = makeApp({
      sessionCreator: 'user-creator',
      creatorEnvVars: { HUBSPOT_API_KEY: { set: true, scope: 'global' } },
    });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });

    const handler = captured.agor_widgets_request_env_vars.cb;
    const res = await handler({
      names: ['HUBSPOT_API_KEY'],
      reason: 'why',
      auto_resume: false,
    });

    const text = JSON.parse(res.content[0].text);
    expect(text.status).toBe('already_present');
    expect(calls.find((c) => c.service === '/sessions/:id/prompt')).toBeUndefined();
  });

  it('tool description tells the agent this is fire-and-forget', () => {
    const { app } = makeApp({ sessionCreator: 'u' });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });
    const desc = captured.agor_widgets_request_env_vars.cfg.description ?? '';
    expect(desc.toLowerCase()).toContain('fire-and-forget');
    expect(desc.toLowerCase()).toContain('end your turn');
    expect(desc.toLowerCase()).toContain('never enter your context');
  });

  it('tool description steers the agent to PREFER the widget over Settings instructions', () => {
    // Regression guard for the "prefer widget over manual Settings" guidance:
    // the agent-facing contract must keep telling agents to call the widget
    // rather than pointing users at Settings → Environment Variables.
    const { app } = makeApp({ sessionCreator: 'u' });
    const captured = registerAndCapture({
      app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });
    const desc = (captured.agor_widgets_request_env_vars.cfg.description ?? '').toLowerCase();
    expect(desc).toContain('prefer');
    expect(desc).toContain('settings');
  });

  it('renders a grammatical singular/plural preview line for the widget row', async () => {
    const captured = registerAndCapture({
      app: makeApp({ sessionCreator: 'user-creator' }).app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });
    await captured.agor_widgets_request_env_vars.cb({
      names: ['HUBSPOT_API_KEY'],
      reason: 'call hubspot',
      auto_resume: true,
    });
    expect(appendStub.mock.calls[0][0].content).toBe(
      'Please provide variable HUBSPOT_API_KEY: call hubspot'
    );

    appendStub.mockClear();
    const captured2 = registerAndCapture({
      app: makeApp({ sessionCreator: 'user-creator' }).app,
      userId: 'user-creator',
      sessionId: 'sess-1',
    });
    await captured2.agor_widgets_request_env_vars.cb({
      names: ['STRIPE_SECRET_KEY', 'HUBSPOT_API_KEY'],
      reason: 'two integrations',
      auto_resume: true,
    });
    expect(appendStub.mock.calls[0][0].content).toBe(
      'Please provide variables HUBSPOT_API_KEY, STRIPE_SECRET_KEY: two integrations'
    );
  });
});

describe('agor_widgets_request_gateway_token', () => {
  const appendStub = appendSystemMessage as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    appendStub.mockReset();
  });

  it('preflights the session target branch before rendering a Discord secret widget', async () => {
    const { app } = makeApp({
      sessionCreator: 'user-creator',
      gatewayChannel: {
        id: 'channel-1',
        name: 'Discord',
        channel_type: 'discord',
        target_branch_id: 'different-branch',
        config: {},
      },
    });
    const captured = registerAndCapture({
      app,
      userId: 'user-admin',
      sessionId: 'sess-1',
      role: 'admin',
    });
    await expect(
      captured.agor_widgets_request_gateway_token.cb({ gatewayChannelId: 'channel-1' })
    ).rejects.toThrow(/target branch/i);
    expect(appendStub).not.toHaveBeenCalled();
  });

  it('renders a provider-aware Discord widget only after branch preflight', async () => {
    const { app } = makeApp({
      sessionCreator: 'user-creator',
      gatewayChannel: {
        id: 'channel-1',
        name: 'Discord',
        channel_type: 'discord',
        target_branch_id: 'wt-1',
        config: {},
      },
    });
    appendStub.mockResolvedValue({ index: 5 });
    const captured = registerAndCapture({
      app,
      userId: 'user-admin',
      sessionId: 'sess-1',
      role: 'admin',
    });
    const result = await captured.agor_widgets_request_gateway_token.cb({
      gatewayChannelId: 'channel-1',
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('requested');
    const params = appendStub.mock.calls[0][0].metadata.widget.params;
    expect(params.channelType).toBe('discord');
    expect(params.fields).toEqual(['bot_token']);
    expect(JSON.stringify(params)).not.toContain('xoxb');
  });

  it('rejects a non-admin caller before creating any widget (admin-only)', async () => {
    // The gateway-token widget mints platform credentials, so a non-admin agent
    // must NOT be able to render the form. requireAdmin runs before any service
    // call, so no gateway-channels/messages plumbing is needed here.
    const { app } = makeApp({ sessionCreator: 'user-creator' });
    const captured = registerAndCapture({
      app,
      userId: 'user-member',
      sessionId: 'sess-1',
      role: 'member',
    });

    await expect(
      captured.agor_widgets_request_gateway_token.cb({ gatewayChannelId: 'channel-1' })
    ).rejects.toThrow(/admin role required/i);

    // No widget message was created for the dead-end form.
    expect(appendStub).not.toHaveBeenCalled();
  });

  it('tool description marks it admin-only and prefers the widget over manual setup', () => {
    const { app } = makeApp({ sessionCreator: 'user-creator' });
    const captured = registerAndCapture({
      app,
      userId: 'user-admin',
      sessionId: 'sess-1',
      role: 'admin',
    });
    const desc = (captured.agor_widgets_request_gateway_token.cfg.description ?? '').toLowerCase();
    expect(desc).toContain('admin-only');
    expect(desc).toContain('prefer');
    expect(desc).toContain('fire-and-forget');
  });
});
