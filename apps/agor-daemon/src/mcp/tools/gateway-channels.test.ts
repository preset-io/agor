import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

type ServiceStub = Record<string, (...args: unknown[]) => unknown>;
function makeFakeApp(services: Record<string, ServiceStub>) {
  return {
    service: (name: string) => {
      const svc = services[name];
      if (!svc) throw new Error(`Unexpected service call: ${name}`);
      return svc;
    },
  };
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

async function captureTools(role: 'admin' | 'member' = 'admin', app = makeFakeApp({})) {
  const { registerGatewayChannelTools } = await import('./gateway-channels.js');
  const tools: Record<string, { cfg: any; handler: ToolHandler }> = {};
  const fakeServer = {
    registerTool: (name: string, cfg: any, cb: ToolHandler) => {
      tools[name] = { cfg, handler: cb };
    },
  } as unknown as McpServer;
  registerGatewayChannelTools(fakeServer, {
    app: app as any,
    db: {} as any,
    userId: 'user-1' as any,
    sessionId: 'sess-1' as any,
    authenticatedUser: { user_id: 'user-1', role } as any,
    baseServiceParams: { authenticated: true, user: { user_id: 'user-1', role } } as any,
  });
  return tools;
}

describe('agor_gateway_channels MCP tools', () => {
  it('validates Slack Socket Mode config on create', async () => {
    const tools = await captureTools();
    const missingBot = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Eng Slack',
      targetBranchId: 'branch-1',
      channelType: 'slack',
      config: { connection_mode: 'socket', app_token: 'xapp-1' },
    });
    expect(missingBot.success).toBe(false);
    expect(String(missingBot.error)).toContain('config.bot_token is required for Slack');

    const missingApp = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Eng Slack',
      targetBranchId: 'branch-1',
      channelType: 'slack',
      config: { connection_mode: 'socket', bot_token: 'xoxb-1' },
    });
    expect(missingApp.success).toBe(false);
    expect(String(missingApp.error)).toContain(
      'config.app_token is required for Slack Socket Mode'
    );
  });

  it('creates through gateway-channels service and redacts returned secrets', async () => {
    const createCalls: Array<{ data: Record<string, unknown>; params: unknown }> = [];
    const app = makeFakeApp({
      'gateway-channels': {
        create: async (data: Record<string, unknown>, params: unknown) => {
          createCalls.push({ data, params });
          return {
            id: 'chan-1',
            created_by: 'admin-1',
            name: data.name,
            channel_type: data.channel_type,
            target_branch_id: data.target_branch_id,
            agor_user_id: data.agor_user_id,
            channel_key: 'raw-channel-key',
            config: { ...(data.config as Record<string, unknown>) },
            agentic_config: data.agentic_config,
            enabled: data.enabled,
            created_at: '2026-06-22T00:00:00.000Z',
            updated_at: '2026-06-22T00:00:00.000Z',
            last_message_at: null,
          };
        },
      },
    });

    const tools = await captureTools('admin', app);
    const result = await tools.agor_gateway_channels_create.handler({
      name: 'Eng Slack',
      channelType: 'slack',
      targetBranchId: 'branch-1',
      agorUserId: 'user-runner',
      config: {
        bot_token: 'xoxb-secret',
        app_token: 'xapp-secret',
        connection_mode: 'socket',
        enable_channels: true,
      },
      agenticConfig: {
        agent: 'claude-code',
        envVars: [{ key: 'SERVICE_TOKEN', value: 'raw-env-secret', forceOverride: true }],
      },
    });
    const payload = JSON.parse(result.content[0].text);

    expect(createCalls).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Eng Slack',
          channel_type: 'slack',
          target_branch_id: 'branch-1',
          agor_user_id: 'user-runner',
          enabled: true,
          config: expect.objectContaining({ bot_token: 'xoxb-secret' }),
        }),
      }),
    ]);
    expect(payload.gateway_channel.channel_key).toBe('••••••••');
    expect(payload.gateway_channel.config.bot_token).toBe('••••••••');
    expect(payload.gateway_channel.config.app_token).toBe('••••••••');
    expect(payload.gateway_channel.agentic_config.envVars[0].value).toBe('••••••••');
    expect(JSON.stringify(payload)).not.toContain('xoxb-secret');
    expect(JSON.stringify(payload)).not.toContain('raw-channel-key');
    expect(JSON.stringify(payload)).not.toContain('raw-env-secret');
  });

  it('lists with filters and redacts Teams app_password', async () => {
    const findCalls: Array<Record<string, unknown> | undefined> = [];
    const app = makeFakeApp({
      'gateway-channels': {
        find: async (params: { query?: Record<string, unknown> }) => {
          findCalls.push(params.query);
          return {
            total: 1,
            limit: params.query?.$limit,
            skip: params.query?.$skip,
            data: [
              {
                id: 'chan-teams',
                created_by: 'admin-1',
                name: 'Teams',
                channel_type: 'teams',
                target_branch_id: 'branch-1',
                agor_user_id: 'user-1',
                channel_key: 'teams-key',
                config: { app_id: 'app', app_password: 'teams-secret' },
                agentic_config: null,
                enabled: true,
                created_at: '2026-06-22T00:00:00.000Z',
                updated_at: '2026-06-22T00:00:00.000Z',
                last_message_at: null,
              },
            ],
          };
        },
      },
    });

    const tools = await captureTools('admin', app);
    const result = await tools.agor_gateway_channels_list.handler({
      includeDisabled: false,
      channelType: 'teams',
      limit: 25,
      skip: 10,
    });
    const payload = JSON.parse(result.content[0].text);

    expect(findCalls[0]).toMatchObject({
      enabled: true,
      channel_type: 'teams',
      $limit: 25,
      $skip: 10,
    });
    expect(payload.gateway_channels).toHaveLength(1);
    expect(payload.gateway_channels[0]).toMatchObject({
      id: 'chan-teams',
      channel_key: '••••••••',
      config: { app_id: 'app', app_password: '••••••••' },
    });
    expect(JSON.stringify(payload)).not.toContain('teams-secret');
    expect(payload.pagination).toMatchObject({ total: 1, returned: 1, limit: 25, skip: 10 });
    expect(payload.summary).toMatchObject({ returned: 1, enabled: 1, disabled: 0 });
  });

  it('updates only provided fields through gateway-channels service', async () => {
    const patchCalls: Array<{ id: string; data: Record<string, unknown> }> = [];
    const app = makeFakeApp({
      'gateway-channels': {
        patch: async (id: string, data: Record<string, unknown>) => {
          patchCalls.push({ id, data });
          return {
            id,
            created_by: 'admin-1',
            name: data.name ?? 'Slack',
            channel_type: 'slack',
            target_branch_id: 'branch-1',
            agor_user_id: 'user-1',
            channel_key: 'raw-key',
            config: { bot_token: 'xoxb', ...(data.config as Record<string, unknown>) },
            agentic_config: null,
            enabled: data.enabled ?? true,
            created_at: '2026-06-22T00:00:00.000Z',
            updated_at: '2026-06-22T00:00:00.000Z',
            last_message_at: null,
          };
        },
      },
    });

    const tools = await captureTools('admin', app);
    const result = await tools.agor_gateway_channels_update.handler({
      gatewayChannelId: 'chan-1',
      name: 'Slack renamed',
      enabled: false,
      config: { bot_token: '••••••••', require_mention: true },
    });
    const payload = JSON.parse(result.content[0].text);

    expect(patchCalls).toEqual([
      {
        id: 'chan-1',
        data: {
          name: 'Slack renamed',
          enabled: false,
          config: { bot_token: '••••••••', require_mention: true },
        },
      },
    ]);
    expect(payload.gateway_channel.config.bot_token).toBe('••••••••');
  });

  it('passes agenticConfig null through so service hooks can clear it', async () => {
    const patchCalls: Array<{ id: string; data: Record<string, unknown> }> = [];
    const app = makeFakeApp({
      'gateway-channels': {
        patch: async (id: string, data: Record<string, unknown>) => {
          patchCalls.push({ id, data });
          return {
            id,
            created_by: 'admin-1',
            name: 'Slack',
            channel_type: 'slack',
            target_branch_id: 'branch-1',
            agor_user_id: 'user-1',
            channel_key: 'raw-key',
            config: {},
            agentic_config: data.agentic_config,
            enabled: true,
            created_at: '2026-06-22T00:00:00.000Z',
            updated_at: '2026-06-22T00:00:00.000Z',
            last_message_at: null,
          };
        },
      },
    });

    const tools = await captureTools('admin', app);
    await tools.agor_gateway_channels_update.handler({
      gatewayChannelId: 'chan-1',
      agenticConfig: null,
    });

    expect(patchCalls).toEqual([{ id: 'chan-1', data: { agentic_config: null } }]);
  });

  it('denies list/create/update for non-admin users before service calls', async () => {
    const app = makeFakeApp({
      'gateway-channels': {
        find: vi.fn(async () => ({ data: [] })),
        create: vi.fn(async () => ({})),
        patch: vi.fn(async () => ({})),
      },
    });
    const services = app.service('gateway-channels') as Record<string, ReturnType<typeof vi.fn>>;
    const tools = await captureTools('member', app);

    await expect(tools.agor_gateway_channels_list.handler({})).rejects.toThrow(
      'admin role required'
    );
    await expect(
      tools.agor_gateway_channels_create.handler({
        name: 'Eng Slack',
        targetBranchId: 'branch-1',
        config: { bot_token: 'xoxb' },
      })
    ).rejects.toThrow('admin role required');
    await expect(
      tools.agor_gateway_channels_update.handler({ gatewayChannelId: 'chan-1', enabled: false })
    ).rejects.toThrow('admin role required');

    expect(services.find).not.toHaveBeenCalled();
    expect(services.create).not.toHaveBeenCalled();
    expect(services.patch).not.toHaveBeenCalled();
  });
});
