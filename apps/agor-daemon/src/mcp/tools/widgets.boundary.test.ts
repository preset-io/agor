import { feathers } from '@agor/core/feathers';
import type { Message, MessageID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { protectExternalWidgetMessageWrites } from '../../widgets/message-boundary.js';

vi.mock('../../utils/append-system-message.js', () => ({
  appendSystemMessage: vi.fn(
    async (opts: {
      app: {
        service: (name: string) => {
          create: (data: Message, params?: unknown) => Promise<Message>;
        };
      };
      sessionId: string;
      taskId?: string;
      content: string;
      contentPreview?: string;
      type?: Message['type'];
      role?: Message['role'];
      metadata?: Message['metadata'];
      messageId?: MessageID;
      params?: unknown;
    }) => {
      if (!opts.messageId) throw new Error('widget message ID must be generated before create');
      return opts.app.service('messages').create(
        {
          message_id: opts.messageId,
          session_id: opts.sessionId as Message['session_id'],
          task_id: opts.taskId as Message['task_id'],
          type: opts.type ?? 'system',
          role: opts.role ?? MessageRole.SYSTEM,
          index: 0,
          timestamp: '2026-08-11T00:00:00.000Z',
          content_preview: opts.contentPreview ?? opts.content,
          content: opts.content,
          metadata: opts.metadata,
        },
        opts.params
      );
    }
  ),
}));

import { appendSystemMessage } from '../../utils/append-system-message.js';
import { registerWidgetTools } from './widgets.js';

function makeBoundaryApp(options: { createFailures?: number } = {}) {
  const rows = new Map<string, Message>();
  const createdEvents: Message[] = [];
  const taskPatchParams: unknown[] = [];
  let remainingCreateFailures = options.createFailures ?? 0;
  const app = feathers();

  app.use('messages', {
    async create(data: Message) {
      if (remainingCreateFailures > 0) {
        remainingCreateFailures -= 1;
        throw new Error('synthetic widget create failure');
      }
      rows.set(data.message_id, data);
      createdEvents.push(data);
      return data;
    },
    async patch(id: string, data: Partial<Message>) {
      const current = rows.get(id);
      if (!current) throw new Error(`message not found: ${id}`);
      const next = { ...current, ...data } as Message;
      rows.set(id, next);
      return next;
    },
  } as never);

  const messages = app.service('messages') as unknown as {
    hooks(hooks: { before: Record<string, Array<(context: never) => Promise<never>>> }): void;
  };
  messages.hooks({
    before: {
      create: [protectExternalWidgetMessageWrites(async (id) => rows.get(id) ?? null) as never],
      patch: [protectExternalWidgetMessageWrites(async (id) => rows.get(id) ?? null) as never],
    },
  });

  const services: Record<string, Record<string, (...args: unknown[]) => unknown>> = {
    messages: app.service('messages') as never,
    sessions: {
      get: async () => ({ session_id: 'sess-1', branch_id: 'branch-1', created_by: 'user-1' }),
    },
    users: {
      get: async () => ({ user_id: 'user-1', env_vars: {} }),
    },
    tasks: {
      find: async () => ({
        data: [
          {
            task_id: 'task-host-1',
            status: 'running',
            created_at: '2026-08-11T00:00:00.000Z',
            message_range: { start_index: 0, end_index: 0 },
          },
        ],
        total: 1,
        limit: 1000,
        skip: 0,
      }),
      patch: async (...args: unknown[]) => {
        taskPatchParams.push(args[2]);
        return { task_id: args[0], ...(args[1] as Record<string, unknown>) };
      },
    },
    'gateway-channels': {
      get: async () => ({
        id: 'channel-1',
        name: 'Engineering Slack',
        channel_type: 'slack',
        target_branch_id: 'branch-1',
        config: { bot_token: 'xoxb-redacted', app_token: 'xapp-redacted' },
      }),
    },
  };

  return {
    app: {
      service(name: string) {
        const service = services[name];
        if (!service) throw new Error(`Unexpected service call: ${name}`);
        return service;
      },
    },
    messageService: app.service('messages'),
    rows,
    createdEvents,
    taskPatchParams,
  };
}

function widgetContext(app: unknown): Parameters<typeof registerWidgetTools>[1] {
  return {
    app: app as never,
    db: { run: vi.fn() } as never,
    userId: 'user-1' as never,
    sessionId: 'sess-1' as never,
    authenticatedUser: { user_id: 'user-1', role: 'admin' } as never,
    baseServiceParams: {
      user: { user_id: 'user-1', role: 'admin' },
      authenticated: true,
      provider: 'mcp',
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
    } as never,
  };
}

async function callThroughMcp(
  app: unknown,
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const server = new McpServer({ name: 'widget-boundary-test', version: '1.0.0' });
  registerWidgetTools(server, widgetContext(app));
  const client = new Client({ name: 'widget-boundary-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
    };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('widget MCP/service boundary', () => {
  beforeEach(() => {
    vi.mocked(appendSystemMessage).mockClear();
  });

  it('creates env widgets with their final ID through the real message boundary', async () => {
    const fixture = makeBoundaryApp();
    const result = await callThroughMcp(fixture.app, 'agor_widgets_request_env_vars', {
      names: ['HUBSPOT_API_KEY'],
      reason: 'call hubspot',
      auto_resume: true,
    });
    const widgetId = JSON.parse(result.content[0].text).widget_id as string;
    const row = fixture.rows.get(widgetId);

    expect(row?.message_id).toBe(widgetId);
    expect(row?.metadata?.widget?.widget_id).toBe(widgetId);
    expect(row?.metadata?.widget?.widget_id).not.toBe('pending');
    expect(fixture.createdEvents).toHaveLength(1);
    expect(fixture.createdEvents[0].metadata?.widget?.widget_id).toBe(widgetId);
    expect(fixture.taskPatchParams[0]).toMatchObject({
      user: { user_id: 'user-1', role: 'admin' },
      authenticated: true,
      provider: undefined,
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
    });

    await expect(
      (fixture.messageService as never).patch(
        widgetId,
        { content: 'external mutation' },
        {
          user: { user_id: 'user-1', role: 'admin' },
          authenticated: true,
          provider: 'mcp',
          tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
        }
      )
    ).rejects.toThrow('Widget messages can only be changed through widget resolution routes');
  });

  it('uses the same final-ID invariant for gateway-token widgets', async () => {
    const fixture = makeBoundaryApp();
    const result = await callThroughMcp(fixture.app, 'agor_widgets_request_gateway_token', {
      gatewayChannelId: 'channel-1',
      reason: 'finish Slack setup',
    });
    const widgetId = JSON.parse(result.content[0].text).widget_id as string;
    const row = fixture.rows.get(widgetId);

    expect(row?.message_id).toBe(widgetId);
    expect(row?.metadata?.widget?.widget_type).toBe('gateway_token');
    expect(row?.metadata?.widget?.widget_id).toBe(widgetId);
    expect(row?.metadata?.widget?.widget_id).not.toBe('pending');
  });

  it('does not publish a failed create and retries with a new final ID', async () => {
    const fixture = makeBoundaryApp({ createFailures: 1 });

    const failed = await callThroughMcp(fixture.app, 'agor_widgets_request_env_vars', {
      names: ['HUBSPOT_API_KEY'],
      reason: 'call hubspot',
      auto_resume: true,
    });

    expect(failed).toMatchObject({ isError: true });
    expect(failed.content[0].text).toContain('synthetic widget create failure');
    expect(fixture.rows.size).toBe(0);
    expect(fixture.createdEvents).toHaveLength(0);

    const retry = await callThroughMcp(fixture.app, 'agor_widgets_request_env_vars', {
      names: ['HUBSPOT_API_KEY'],
      reason: 'call hubspot',
      auto_resume: true,
    });
    const retryId = JSON.parse(retry.content[0].text).widget_id as string;

    expect(retryId).not.toBe('pending');
    expect(fixture.rows.get(retryId)?.metadata?.widget?.widget_id).toBe(retryId);
    expect(fixture.createdEvents).toHaveLength(1);
    expect(fixture.createdEvents[0].metadata?.widget?.widget_id).toBe(retryId);
  });

  it('keeps concurrent widget creates bound to their final IDs', async () => {
    const fixture = makeBoundaryApp();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        callThroughMcp(fixture.app, 'agor_widgets_request_env_vars', {
          names: ['HUBSPOT_API_KEY'],
          reason: 'call hubspot',
          auto_resume: true,
        })
      )
    );
    const widgetIds = results.map(
      (result) => JSON.parse(result.content[0].text).widget_id as string
    );

    expect(new Set(widgetIds).size).toBe(widgetIds.length);
    expect(widgetIds).not.toContain('pending');
    expect(new Set(fixture.createdEvents.map((event) => event.message_id))).toEqual(
      new Set(widgetIds)
    );
    expect(
      fixture.createdEvents.every((event) => event.metadata?.widget?.widget_id === event.message_id)
    ).toBe(true);
  });

  it('still rejects a direct MCP widget create at the Feathers boundary', async () => {
    const fixture = makeBoundaryApp();
    await expect(
      (fixture.messageService as never).create(
        {
          message_id: 'external-widget' as MessageID,
          session_id: 'sess-1' as never,
          type: 'widget_request',
          role: MessageRole.SYSTEM,
          index: 0,
          timestamp: '2026-08-11T00:00:00.000Z',
          content_preview: 'external',
          content: 'external',
          metadata: { widget: { widget_id: 'external-widget' } },
        },
        {
          provider: 'mcp',
          authenticated: true,
          user: { user_id: 'user-1', role: 'admin' },
          tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
        }
      )
    ).rejects.toThrow('Widget messages can only be created by the daemon');
  });
});
