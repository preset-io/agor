import {
  BranchRepository,
  GatewayChannelRepository,
  ThreadSessionMapRepository,
} from '@agor/core/db';
import { getConnector } from '@agor/core/gateway';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return {
    ...actual,
    getConnector: vi.fn(),
  };
});

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

const slackChannel = {
  id: 'chan-1',
  created_by: 'admin-1',
  name: 'Eng Slack',
  channel_type: 'slack',
  target_branch_id: 'branch-1',
  agor_user_id: 'user-1',
  channel_key: 'raw-channel-key',
  config: { bot_token: 'xoxb-secret', app_token: 'xapp-secret' },
  agentic_config: null,
  enabled: true,
  created_at: '2026-06-22T00:00:00.000Z',
  updated_at: '2026-06-22T00:00:00.000Z',
  last_message_at: null,
};

const branch = {
  branch_id: 'branch-1',
  name: 'slack-work',
  others_can: 'view',
};

const threadMapping = {
  id: 'map-1',
  channel_id: 'chan-1',
  thread_id: 'C123-171234.000100',
  session_id: 'sess-42',
  branch_id: 'branch-1',
  created_at: '2026-06-22T00:00:00.000Z',
  last_message_at: '2026-06-22T00:01:00.000Z',
  status: 'active',
  metadata: {
    slack_last_delivered_ts: '171233.000099',
    slack_last_summon_ts: '171234.000100',
    slack_active_thread_id: 'C123-171234.000100',
    slack_bot_user_id: 'U_BOT',
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(getConnector).mockReset();
});

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

  it('validates Slack thread history lookup inputs', async () => {
    const tools = await captureTools('member');

    expect(
      tools.agor_gateway_slack_thread_history_get.cfg.inputSchema.safeParse({
        sessionId: 'sess-42',
      }).success
    ).toBe(true);
    expect(
      tools.agor_gateway_slack_thread_history_get.cfg.inputSchema.safeParse({
        gatewayChannelId: 'chan-1',
        threadId: 'C123-171234.000100',
      }).success
    ).toBe(true);
    const missingExplicit = tools.agor_gateway_slack_thread_history_get.cfg.inputSchema.safeParse({
      gatewayChannelId: 'chan-1',
    });
    expect(missingExplicit.success).toBe(false);
    expect(String(missingExplicit.error)).toContain('threadId is required');
  });

  it('fetches Slack thread history by session mapping without exposing tokens', async () => {
    const fetchThreadHistory = vi.fn(async () => ({
      threadId: 'C123-171234.000100',
      channel: 'C123',
      thread_ts: '171234.000100',
      has_more: true,
      messages: [
        {
          ts: '171234.000100',
          iso_time: '2026-06-22T00:00:00.000Z',
          user_id: 'U1',
          user_name: 'alice',
          actor_label: 'Alice',
          text: '<@U_BOT> please review',
          is_bot: false,
          is_trigger: true,
          is_mention: true,
        },
      ],
    }));
    vi.mocked(getConnector).mockReturnValue({ fetchThreadHistory } as any);
    vi.spyOn(ThreadSessionMapRepository.prototype, 'findBySession').mockResolvedValue(
      threadMapping as any
    );
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(slackChannel as any);
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

    const sessionsGet = vi.fn(async () => ({ session_id: 'sess-42', branch_id: 'branch-1' }));
    const tools = await captureTools('member', makeFakeApp({ sessions: { get: sessionsGet } }));
    const result = await tools.agor_gateway_slack_thread_history_get.handler({
      sessionId: 'sess-42',
      oldestTs: '171233.000099',
      latestTs: '171234.000100',
      inclusive: true,
      limit: 999,
      includeBotMessages: true,
    });
    const payload = JSON.parse(result.content[0].text);

    expect(sessionsGet).toHaveBeenCalledWith('sess-42', {
      authenticated: true,
      user: { user_id: 'user-1', role: 'member' },
    });
    expect(fetchThreadHistory).toHaveBeenCalledWith({
      threadId: 'C123-171234.000100',
      oldestTs: '171233.000099',
      latestTs: '171234.000100',
      inclusive: true,
      limit: 200,
      includeBotMessages: true,
      triggerTs: '171234.000100',
    });
    expect(payload.warning).toContain('untrusted external content');
    expect(payload.gateway_channel).toMatchObject({
      id: 'chan-1',
      name: 'Eng Slack',
      channel_type: 'slack',
      target_branch_id: 'branch-1',
      target_branch_name: 'slack-work',
    });
    expect(payload.thread).toMatchObject({
      thread_id: 'C123-171234.000100',
      session_id: 'sess-42',
      mapping_id: 'map-1',
      slack_last_delivered_ts: '171233.000099',
      slack_bot_user_id: 'U_BOT',
    });
    expect(payload.pagination).toMatchObject({
      requested_limit: 200,
      returned: 1,
      has_more: true,
      truncated: true,
    });
    expect(payload.messages[0]).toMatchObject({
      actor_label: 'Alice',
      text: '<@U_BOT> please review',
      is_mention: true,
      is_trigger: true,
    });
    expect(JSON.stringify(payload)).not.toContain('xoxb-secret');
    expect(JSON.stringify(payload)).not.toContain('xapp-secret');
    expect(JSON.stringify(payload)).not.toContain('channel_key');
  });

  it('fetches explicit Slack thread history for callers with branch all permission', async () => {
    const fetchThreadHistory = vi.fn(async () => ({
      threadId: 'C123-171234.000100',
      channel: 'C123',
      thread_ts: '171234.000100',
      has_more: false,
      messages: [
        {
          ts: '171234.000200',
          iso_time: '2026-06-22T00:00:01.000Z',
          actor_label: 'bob',
          text: 'more context',
          is_bot: false,
          is_trigger: true,
          is_mention: false,
        },
      ],
    }));
    vi.mocked(getConnector).mockReturnValue({ fetchThreadHistory } as any);
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(slackChannel as any);
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);
    vi.spyOn(BranchRepository.prototype, 'isOwner').mockResolvedValue(false);
    vi.spyOn(BranchRepository.prototype, 'resolveUserPermission').mockResolvedValue('all');
    vi.spyOn(ThreadSessionMapRepository.prototype, 'findByChannelAndThread').mockResolvedValue(
      threadMapping as any
    );

    const tools = await captureTools('member');
    const result = await tools.agor_gateway_slack_thread_history_get.handler({
      gatewayChannelId: 'chan-1',
      threadId: 'C123-171234.000100',
      latestTs: '171234.000200',
      format: 'markdown',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(fetchThreadHistory).toHaveBeenCalledWith({
      threadId: 'C123-171234.000100',
      latestTs: '171234.000200',
      limit: 50,
      includeBotMessages: false,
      triggerTs: '171234.000100',
    });
    expect(payload.thread).toMatchObject({
      source: 'explicit',
      thread_id: 'C123-171234.000100',
      session_id: 'sess-42',
      mapping_id: 'map-1',
    });
    expect(payload.markdown).toContain('# Slack thread C123-171234.000100');
    expect(payload.markdown).toContain('more context');
    expect(payload.messages).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('xoxb-secret');
  });

  it('denies mapped explicit Slack thread history without branch all permission', async () => {
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(slackChannel as any);
    vi.spyOn(ThreadSessionMapRepository.prototype, 'findByChannelAndThread').mockResolvedValue(
      threadMapping as any
    );
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);
    vi.spyOn(BranchRepository.prototype, 'isOwner').mockResolvedValue(false);
    vi.spyOn(BranchRepository.prototype, 'resolveUserPermission').mockResolvedValue('view');

    const tools = await captureTools('member');
    await expect(
      tools.agor_gateway_slack_thread_history_get.handler({
        gatewayChannelId: 'chan-1',
        threadId: 'C123-171234.000100',
      })
    ).rejects.toThrow("'all' branch permission");

    expect(getConnector).not.toHaveBeenCalled();
  });

  it('denies unmapped explicit Slack thread history to non-admins even with branch all permission', async () => {
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(slackChannel as any);
    vi.spyOn(ThreadSessionMapRepository.prototype, 'findByChannelAndThread').mockResolvedValue(
      null
    );
    vi.spyOn(BranchRepository.prototype, 'isOwner').mockResolvedValue(false);
    vi.spyOn(BranchRepository.prototype, 'resolveUserPermission').mockResolvedValue('all');

    const tools = await captureTools('member');
    await expect(
      tools.agor_gateway_slack_thread_history_get.handler({
        gatewayChannelId: 'chan-1',
        threadId: 'C123-171234.000100',
      })
    ).rejects.toThrow('admin role required to read unmapped Slack thread history');

    expect(getConnector).not.toHaveBeenCalled();
  });

  it('allows admins to fetch unmapped explicit Slack thread history', async () => {
    const fetchThreadHistory = vi.fn(async () => ({
      threadId: 'C123-171234.000100',
      channel: 'C123',
      thread_ts: '171234.000100',
      has_more: false,
      messages: [],
    }));
    vi.mocked(getConnector).mockReturnValue({ fetchThreadHistory } as any);
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(slackChannel as any);
    vi.spyOn(ThreadSessionMapRepository.prototype, 'findByChannelAndThread').mockResolvedValue(
      null
    );
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_slack_thread_history_get.handler({
      gatewayChannelId: 'chan-1',
      threadId: 'C123-171234.000100',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(fetchThreadHistory).toHaveBeenCalledWith({
      threadId: 'C123-171234.000100',
      limit: 50,
      includeBotMessages: false,
    });
    expect(payload.thread).toMatchObject({
      source: 'explicit',
      thread_id: 'C123-171234.000100',
    });
    expect(payload.thread.mapping_id).toBeUndefined();
  });

  it('rejects Slack history for non-Slack gateway mappings before connector use', async () => {
    vi.spyOn(ThreadSessionMapRepository.prototype, 'findBySession').mockResolvedValue(
      threadMapping as any
    );
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue({
      ...slackChannel,
      channel_type: 'github',
      config: { private_key: 'secret' },
    } as any);
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

    const tools = await captureTools(
      'member',
      makeFakeApp({ sessions: { get: vi.fn(async () => ({ session_id: 'sess-42' })) } })
    );
    await expect(
      tools.agor_gateway_slack_thread_history_get.handler({ sessionId: 'sess-42' })
    ).rejects.toThrow('not slack');

    expect(getConnector).not.toHaveBeenCalled();
  });

  it('emits outbound messages through the gateway service without returning secrets', async () => {
    const emitMessage = vi.fn(async () => ({
      success: true,
      gateway_outbound_message_id: 'out-1',
      gateway_channel_id: 'chan-1',
      channel_type: 'slack',
      platform_channel_id: 'C123',
      platform_message_id: '171234.000100',
      platform_thread_id: 'C123-171234.000100',
      platform_permalink: 'https://slack.example/archives/C123/p171234000100',
    }));
    const app = makeFakeApp({
      gateway: { emitMessage },
    });

    const tools = await captureTools('member', app);
    const result = await tools.agor_gateway_emit_message.handler({
      gatewayChannelId: 'chan-1',
      message: 'Hello Slack',
      target: 'channel:C123',
      purpose: 'test',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(emitMessage).toHaveBeenCalledWith({
      gatewayChannelId: 'chan-1',
      message: 'Hello Slack',
      target: 'channel:C123',
      purpose: 'test',
      emittedByUserId: 'user-1',
      emittedBySessionId: 'sess-1',
      userRole: 'member',
    });
    expect(payload).toMatchObject({
      success: true,
      gateway_outbound_message_id: 'out-1',
      platform_thread_id: 'C123-171234.000100',
    });
    expect(JSON.stringify(payload)).not.toContain('xoxb');
    expect(JSON.stringify(payload)).not.toContain('channel_key');
  });

  it('validates outbound target grammar', async () => {
    const tools = await captureTools('member', makeFakeApp({ gateway: { emitMessage: vi.fn() } }));

    for (const target of [
      'channel:C123',
      '#project-updates',
      'channel_name:project-updates',
      'user@example.com',
    ]) {
      const parsed = tools.agor_gateway_emit_message.cfg.inputSchema.safeParse({
        gatewayChannelId: 'chan-1',
        message: 'Hello',
        target,
      });
      expect(parsed.success).toBe(true);
    }

    const bareChannel = tools.agor_gateway_emit_message.cfg.inputSchema.safeParse({
      gatewayChannelId: 'chan-1',
      message: 'Hello',
      target: 'C123',
    });
    expect(bareChannel.success).toBe(false);

    const existingThread = tools.agor_gateway_emit_message.cfg.inputSchema.safeParse({
      gatewayChannelId: 'chan-1',
      message: 'Hello',
      target: 'thread:C123:171234.000100',
    });
    expect(existingThread.success).toBe(false);
  });
});
