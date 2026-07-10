import {
  BranchRepository,
  GatewayChannelRepository,
  SessionRepository,
  ThreadSessionMapRepository,
} from '@agor/core/db';
import {
  buildSlackManifest,
  getConnector,
  requiredBotEvents,
  requiredBotScopes,
} from '@agor/core/gateway';
import { getRequiredSecretFields } from '@agor/core/types';
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

async function captureTools(
  role: 'admin' | 'member' = 'admin',
  app = makeFakeApp({}),
  sessionId: string | null = 'sess-1'
) {
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
    ...(sessionId ? { sessionId: sessionId as any } : {}),
    authenticatedUser: { user_id: 'user-1', role } as any,
    baseServiceParams: { authenticated: true, user: { user_id: 'user-1', role } } as any,
  });
  return tools;
}

/**
 * The caller session used for session-branch binding: ctx.sessionId ('sess-1')
 * resolves to a session on the given branch. null simulates a stale/missing
 * session, which the binding must treat as fail-closed.
 */
function spyCallerSessionBranch(branchId: string | null) {
  return vi
    .spyOn(SessionRepository.prototype, 'findById')
    .mockResolvedValue((branchId ? { session_id: 'sess-1', branch_id: branchId } : null) as any);
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

  it('allows creating a disabled Slack channel without secrets', async () => {
    const tools = await captureTools();
    const draft = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Draft Slack',
      targetBranchId: 'branch-1',
      channelType: 'slack',
      enabled: false,
      config: { align_slack_users: true },
    });
    expect(draft.success).toBe(true);

    const enabledMissing = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Eng Slack',
      targetBranchId: 'branch-1',
      channelType: 'slack',
      enabled: true,
      config: {},
    });
    expect(enabledMissing.success).toBe(false);
    expect(String(enabledMissing.error)).toContain('config.bot_token is required for Slack');
  });

  it('enforces non-secret required config on disabled create', async () => {
    const tools = await captureTools();

    const githubDraft = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Draft GitHub',
      targetBranchId: 'branch-1',
      channelType: 'github',
      enabled: false,
      config: {},
    });
    expect(githubDraft.success).toBe(false);
    expect(String(githubDraft.error)).toContain('config.app_id is required for GitHub');
    expect(String(githubDraft.error)).toContain('config.installation_id is required for GitHub');
    expect(String(githubDraft.error)).toContain('config.watch_repos is required for GitHub');
    expect(String(githubDraft.error)).not.toContain('config.private_key is required for GitHub');

    const teamsDraft = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Draft Teams',
      targetBranchId: 'branch-1',
      channelType: 'teams',
      enabled: false,
      config: {},
    });
    expect(teamsDraft.success).toBe(false);
    expect(String(teamsDraft.error)).toContain('config.app_id is required for Teams');
    expect(String(teamsDraft.error)).not.toContain('config.app_password is required for Teams');

    const slackDraft = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Draft Slack',
      targetBranchId: 'branch-1',
      channelType: 'slack',
      enabled: false,
      config: { align_slack_users: true },
    });
    expect(slackDraft.success).toBe(true);

    const githubDraftComplete = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Draft GitHub',
      targetBranchId: 'branch-1',
      channelType: 'github',
      enabled: false,
      config: { app_id: '123', installation_id: '456', watch_repos: ['org/repo'] },
    });
    expect(githubDraftComplete.success).toBe(true);
  });

  it('requires agorUserId for run-as-selected-user Slack channels', async () => {
    const tools = await captureTools();

    // align_slack_users:false (run as selected user) without agorUserId is invalid
    // even for disabled drafts — identity is config, not a secret.
    const runAsMissingUser = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Run-as Slack',
      targetBranchId: 'branch-1',
      channelType: 'slack',
      enabled: false,
      config: { align_slack_users: false },
    });
    expect(runAsMissingUser.success).toBe(false);
    expect(String(runAsMissingUser.error)).toContain('Run-as-selected-user needs agorUserId');

    // Omitting align_slack_users entirely (falsy) is treated the same way.
    const omittedAlign = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Run-as Slack',
      targetBranchId: 'branch-1',
      channelType: 'slack',
      enabled: false,
      config: {},
    });
    expect(omittedAlign.success).toBe(false);
    expect(String(omittedAlign.error)).toContain('Run-as-selected-user needs agorUserId');

    // Providing agorUserId satisfies run-as-selected-user.
    const runAsWithUser = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Run-as Slack',
      targetBranchId: 'branch-1',
      channelType: 'slack',
      enabled: false,
      agorUserId: 'user-runner',
      config: { align_slack_users: false },
    });
    expect(runAsWithUser.success).toBe(true);

    // align_slack_users:true needs no agorUserId — each Slack user runs as their
    // own matched Agor account.
    const aligned = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Aligned Slack',
      targetBranchId: 'branch-1',
      channelType: 'slack',
      enabled: false,
      config: { align_slack_users: true },
    });
    expect(aligned.success).toBe(true);
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
    expect(JSON.stringify(payload.next_steps)).toContain('agor_widgets_request_gateway_token');
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
    spyCallerSessionBranch('branch-1');
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
    spyCallerSessionBranch('branch-1');
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
    spyCallerSessionBranch('branch-1');
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
    spyCallerSessionBranch('branch-1');
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
    spyCallerSessionBranch('branch-1');
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
    spyCallerSessionBranch('branch-1');
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

describe('gateway session branch binding (MCP)', () => {
  const outboundChannelBranch1 = {
    ...slackChannel,
    id: 'chan-b1',
    target_branch_id: 'branch-1',
    config: { ...slackChannel.config, outbound_enabled: true, default_outbound_target: '#eng' },
  };
  const outboundChannelBranch2 = {
    ...slackChannel,
    id: 'chan-b2',
    target_branch_id: 'branch-2',
    config: { ...slackChannel.config, outbound_enabled: true },
  };

  function spyOutboundChannels() {
    vi.spyOn(GatewayChannelRepository.prototype, 'findAll').mockResolvedValue([
      outboundChannelBranch1,
      outboundChannelBranch2,
    ] as any);
    vi.spyOn(BranchRepository.prototype, 'findById').mockImplementation(
      async (id) => ({ branch_id: id, name: `wt-${id}`, others_can: 'view' }) as any
    );
  }

  it('emit inputSchema rejects injected session/user attribution fields', async () => {
    const tools = await captureTools('member', makeFakeApp({ gateway: { emitMessage: vi.fn() } }));

    for (const extra of [
      { emittedBySessionId: 'sess-evil' },
      { sessionId: 'sess-evil' },
      { emittedByUserId: 'user-evil' },
    ]) {
      const parsed = tools.agor_gateway_emit_message.cfg.inputSchema.safeParse({
        gatewayChannelId: 'chan-1',
        message: 'Hello',
        ...extra,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('scopes outbound targets to the calling session branch even for admins', async () => {
    spyCallerSessionBranch('branch-1');
    spyOutboundChannels();

    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_outbound_targets_list.handler({});
    const payload = JSON.parse(result.content[0].text);

    expect(payload.channels).toHaveLength(1);
    expect(payload.channels[0]).toMatchObject({
      gateway_channel_id: 'chan-b1',
      target_branch_id: 'branch-1',
    });
    expect(payload.hint).toBeUndefined();
  });

  it('returns empty with a binding note when branchId conflicts with the session branch', async () => {
    spyCallerSessionBranch('branch-1');
    spyOutboundChannels();

    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_outbound_targets_list.handler({
      branchId: 'branch-2',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.channels).toEqual([]);
    expect(payload.binding).toContain("scoped to the calling session's branch");
  });

  it('keeps unscoped outbound targets for callers without session context', async () => {
    const sessionSpy = spyCallerSessionBranch('branch-1');
    spyOutboundChannels();

    const tools = await captureTools('admin', makeFakeApp({}), null);
    const result = await tools.agor_gateway_outbound_targets_list.handler({});
    const payload = JSON.parse(result.content[0].text);

    expect(
      payload.channels.map((c: { gateway_channel_id: string }) => c.gateway_channel_id)
    ).toEqual(['chan-b1', 'chan-b2']);
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it('hints when no outbound channel targets the session branch', async () => {
    spyCallerSessionBranch('branch-3');
    spyOutboundChannels();

    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_outbound_targets_list.handler({});
    const payload = JSON.parse(result.content[0].text);

    expect(payload.channels).toEqual([]);
    expect(payload.hint).toContain('No outbound-enabled channel targets');
  });

  it('fails closed when the calling session cannot be loaded', async () => {
    spyCallerSessionBranch(null);
    spyOutboundChannels();

    const tools = await captureTools('admin');
    await expect(tools.agor_gateway_outbound_targets_list.handler({})).rejects.toThrow(
      'calling session not found'
    );
  });

  it('denies session-mapped thread history across branches even for admins', async () => {
    spyCallerSessionBranch('branch-1');
    vi.spyOn(ThreadSessionMapRepository.prototype, 'findBySession').mockResolvedValue({
      ...threadMapping,
      branch_id: 'branch-2',
    } as any);
    const sessionsGet = vi.fn(async () => ({ session_id: 'sess-42', branch_id: 'branch-2' }));

    const tools = await captureTools('admin', makeFakeApp({ sessions: { get: sessionsGet } }));
    const error: Error = await tools.agor_gateway_slack_thread_history_get
      .handler({ sessionId: 'sess-42' })
      .then(() => {
        throw new Error('expected thread history read to be denied');
      })
      .catch((err: Error) => err);

    expect(error.message).toContain('Gateway read denied');
    expect(error.message).not.toContain('branch-2');
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('denies session-mapped thread history when the channel was retargeted to another branch', async () => {
    spyCallerSessionBranch('branch-1');
    vi.spyOn(ThreadSessionMapRepository.prototype, 'findBySession').mockResolvedValue({
      ...threadMapping,
      branch_id: 'branch-1',
    } as any);
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue({
      ...slackChannel,
      target_branch_id: 'branch-2',
    } as any);
    const sessionsGet = vi.fn(async () => ({ session_id: 'sess-42', branch_id: 'branch-1' }));

    const tools = await captureTools('admin', makeFakeApp({ sessions: { get: sessionsGet } }));
    const error: Error = await tools.agor_gateway_slack_thread_history_get
      .handler({ sessionId: 'sess-42' })
      .then(() => {
        throw new Error('expected thread history read to be denied');
      })
      .catch((err: Error) => err);

    expect(error.message).toContain('Gateway read denied');
    expect(error.message).not.toContain('branch-2');
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('denies explicit thread history when the channel targets another branch, even for admins', async () => {
    spyCallerSessionBranch('branch-1');
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue({
      ...slackChannel,
      target_branch_id: 'branch-2',
    } as any);
    const findMapping = vi.spyOn(ThreadSessionMapRepository.prototype, 'findByChannelAndThread');

    const tools = await captureTools('admin');
    await expect(
      tools.agor_gateway_slack_thread_history_get.handler({
        gatewayChannelId: 'chan-1',
        threadId: 'C123-171234.000100',
      })
    ).rejects.toThrow('Gateway read denied');

    expect(findMapping).not.toHaveBeenCalled();
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('keeps the no-session admin path for unmapped explicit thread reads', async () => {
    const fetchThreadHistory = vi.fn(async () => ({
      threadId: 'C123-171234.000100',
      channel: 'C123',
      thread_ts: '171234.000100',
      has_more: false,
      messages: [],
    }));
    vi.mocked(getConnector).mockReturnValue({ fetchThreadHistory } as any);
    const sessionSpy = spyCallerSessionBranch('branch-1');
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(slackChannel as any);
    vi.spyOn(ThreadSessionMapRepository.prototype, 'findByChannelAndThread').mockResolvedValue(
      null
    );
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

    const tools = await captureTools('admin', makeFakeApp({}), null);
    const result = await tools.agor_gateway_slack_thread_history_get.handler({
      gatewayChannelId: 'chan-1',
      threadId: 'C123-171234.000100',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(sessionSpy).not.toHaveBeenCalled();
    expect(payload.thread).toMatchObject({
      source: 'explicit',
      thread_id: 'C123-171234.000100',
    });
  });
});

describe('gateway agent-tool capability gating (MCP)', () => {
  const gatewaySource = {
    channel_id: 'chan-1',
    channel_name: 'Eng Slack',
    channel_type: 'slack',
    thread_id: 'C123-171234.000100',
    slack_channel_id: 'C123',
  };

  /** Caller session spawned from a gateway channel, carrying gateway_source. */
  function spyCallerGatewaySession(branchId: string, source: Record<string, unknown>) {
    return vi.spyOn(SessionRepository.prototype, 'findById').mockResolvedValue({
      session_id: 'sess-1',
      branch_id: branchId,
      custom_context: { gateway_source: source },
    } as any);
  }

  const channelHistoryEnabled = {
    ...slackChannel,
    config: { ...slackChannel.config, agent_tools: { channel_history: true } },
  };

  const channelHistoryResult = {
    channel: 'C123',
    has_more: false,
    messages: [
      {
        ts: '171234.000100',
        iso_time: '2026-06-22T00:00:00.000Z',
        user_id: 'U1',
        user_name: 'alice',
        actor_label: 'Alice',
        text: 'shipping update',
        is_bot: false,
        is_trigger: false,
        is_mention: false,
      },
    ],
  };

  it('fetches Slack channel history defaulting to the gateway session own channel', async () => {
    const fetchChannelHistory = vi.fn(async () => channelHistoryResult);
    vi.mocked(getConnector).mockReturnValue({ fetchChannelHistory } as any);
    spyCallerGatewaySession('branch-1', gatewaySource);
    const channelFindById = vi
      .spyOn(GatewayChannelRepository.prototype, 'findById')
      .mockResolvedValue(channelHistoryEnabled as any);
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

    const tools = await captureTools('member');
    const result = await tools.agor_gateway_slack_channel_history_get.handler({
      oldestTs: '171233.000099',
      limit: 999,
      includeBotMessages: true,
    });
    const payload = JSON.parse(result.content[0].text);

    expect(channelFindById).toHaveBeenCalledWith('chan-1');
    expect(fetchChannelHistory).toHaveBeenCalledWith({
      channelId: 'C123',
      oldestTs: '171233.000099',
      limit: 200,
      includeBotMessages: true,
    });
    expect(payload.warning).toContain('untrusted external content');
    expect(payload.gateway_channel).toMatchObject({
      id: 'chan-1',
      channel_type: 'slack',
      target_branch_id: 'branch-1',
      target_branch_name: 'slack-work',
    });
    expect(payload.channel).toEqual({ slack_channel_id: 'C123' });
    expect(payload.messages[0]).toMatchObject({ actor_label: 'Alice', text: 'shipping update' });
    expect(JSON.stringify(payload)).not.toContain('xoxb-secret');
    expect(JSON.stringify(payload)).not.toContain('xapp-secret');
  });

  it('renders channel history markdown on request', async () => {
    vi.mocked(getConnector).mockReturnValue({
      fetchChannelHistory: vi.fn(async () => channelHistoryResult),
    } as any);
    spyCallerGatewaySession('branch-1', gatewaySource);
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
      channelHistoryEnabled as any
    );
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

    const tools = await captureTools('member');
    const result = await tools.agor_gateway_slack_channel_history_get.handler({
      format: 'markdown',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.markdown).toContain('# Slack channel C123 history');
    expect(payload.markdown).toContain('shipping update');
    expect(payload.messages).toBeUndefined();
  });

  it('denies channel history when the capability is disabled, with an actionable error', async () => {
    spyCallerGatewaySession('branch-1', gatewaySource);
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(slackChannel as any);
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

    const tools = await captureTools('admin');
    const error = await tools.agor_gateway_slack_channel_history_get
      .handler({})
      .then(() => null)
      .catch((err: Error) => err);

    expect(error).toBeTruthy();
    expect(error!.message).toContain("capability 'channel_history' is disabled");
    expect(error!.message).toContain('agor_gateway_channels_update');
    expect(error!.message).toContain('config.agent_tools.channel_history');
    expect(error!.message).toContain('scope');
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('denies channel history across branches even for admins', async () => {
    spyCallerSessionBranch('branch-2');
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
      channelHistoryEnabled as any
    );

    const tools = await captureTools('admin');
    await expect(
      tools.agor_gateway_slack_channel_history_get.handler({
        gatewayChannelId: 'chan-1',
        slackChannelId: 'C123',
      })
    ).rejects.toThrow('targets a different branch');

    expect(getConnector).not.toHaveBeenCalled();
  });

  it('requires explicit identifiers for callers without gateway session context', async () => {
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
      channelHistoryEnabled as any
    );
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

    const tools = await captureTools('admin', makeFakeApp({}), null);
    await expect(tools.agor_gateway_slack_channel_history_get.handler({})).rejects.toThrow(
      'gatewayChannelId is required'
    );
    await expect(
      tools.agor_gateway_slack_channel_history_get.handler({ gatewayChannelId: 'chan-1' })
    ).rejects.toThrow('slackChannelId is required');
  });

  it('denies unauthorized no-session callers before leaking channel type/name/capability details', async () => {
    // Capability intentionally OFF and channel name distinctive: with wrong
    // check ordering the caller would get the capability error naming the
    // channel instead of the bare permission error.
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(slackChannel as any);
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);
    vi.spyOn(BranchRepository.prototype, 'isOwner').mockResolvedValue(false);
    vi.spyOn(BranchRepository.prototype, 'resolveUserPermission').mockResolvedValue('view' as any);

    const tools = await captureTools('member', makeFakeApp({}), null);
    const error = await tools.agor_gateway_slack_channel_history_get
      .handler({ gatewayChannelId: 'chan-1', slackChannelId: 'C123' })
      .then(() => null)
      .catch((err: Error) => err);

    expect(error).toBeTruthy();
    expect(error!.message).toContain("admin role or 'all' branch permission");
    expect(error!.message).not.toContain('Eng Slack');
    expect(error!.message).not.toContain('channel_history');
    expect(error!.message).not.toContain('slack');
    expect(error!.message).not.toContain('disabled');
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('caps the channel-history limit at the schema layer without touching the thread tool', async () => {
    const tools = await captureTools('member');

    const channelSchema = tools.agor_gateway_slack_channel_history_get.cfg.inputSchema;
    expect(channelSchema.safeParse({ limit: 200 }).success).toBe(true);
    const overLimit = channelSchema.safeParse({ limit: 500 });
    expect(overLimit.success).toBe(false);
    expect(String(overLimit.error)).toContain('limit must be at most 200');

    // The thread tool keeps its permissive schema + runtime clamp.
    expect(
      tools.agor_gateway_slack_thread_history_get.cfg.inputSchema.safeParse({
        sessionId: 'sess-42',
        limit: 500,
      }).success
    ).toBe(true);
  });

  it("keeps the no-session path gated on admin or branch 'all' permission", async () => {
    vi.mocked(getConnector).mockReturnValue({
      fetchChannelHistory: vi.fn(async () => channelHistoryResult),
    } as any);
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
      channelHistoryEnabled as any
    );
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);
    vi.spyOn(BranchRepository.prototype, 'isOwner').mockResolvedValue(false);
    const permission = vi
      .spyOn(BranchRepository.prototype, 'resolveUserPermission')
      .mockResolvedValue('view' as any);

    const tools = await captureTools('member', makeFakeApp({}), null);
    await expect(
      tools.agor_gateway_slack_channel_history_get.handler({
        gatewayChannelId: 'chan-1',
        slackChannelId: 'C123',
      })
    ).rejects.toThrow("'all' branch permission");

    permission.mockResolvedValue('all' as any);
    const result = await tools.agor_gateway_slack_channel_history_get.handler({
      gatewayChannelId: 'chan-1',
      slackChannelId: 'C123',
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.channel).toEqual({ slack_channel_id: 'C123' });
  });

  it('denies thread history when the thread_history capability is disabled', async () => {
    spyCallerSessionBranch('branch-1');
    vi.spyOn(ThreadSessionMapRepository.prototype, 'findBySession').mockResolvedValue(
      threadMapping as any
    );
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue({
      ...slackChannel,
      config: { ...slackChannel.config, agent_tools: { thread_history: false } },
    } as any);
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

    const sessionsGet = vi.fn(async () => ({ session_id: 'sess-42', branch_id: 'branch-1' }));
    const tools = await captureTools('member', makeFakeApp({ sessions: { get: sessionsGet } }));
    await expect(
      tools.agor_gateway_slack_thread_history_get.handler({ sessionId: 'sess-42' })
    ).rejects.toThrow("capability 'thread_history' is disabled");

    expect(getConnector).not.toHaveBeenCalled();
  });
});

describe('getRequiredSecretFields — Slack app_token required unless explicitly outbound-only', () => {
  it('requires bot_token AND app_token when no config is set (default inbound)', () => {
    expect(getRequiredSecretFields('slack', {})).toEqual(['bot_token', 'app_token']);
  });

  it('requires bot_token AND app_token when connection_mode is socket (inbound)', () => {
    expect(getRequiredSecretFields('slack', { connection_mode: 'socket' })).toEqual([
      'bot_token',
      'app_token',
    ]);
  });

  it('requires only bot_token when explicitly outbound-only (no Socket Mode)', () => {
    expect(getRequiredSecretFields('slack', { outbound_enabled: true })).toEqual(['bot_token']);
  });

  it('still requires app_token when outbound is enabled alongside Socket Mode', () => {
    expect(
      getRequiredSecretFields('slack', { outbound_enabled: true, connection_mode: 'socket' })
    ).toEqual(['bot_token', 'app_token']);
  });
});

describe('agor_gateway_slack_manifest_generate MCP tool', () => {
  const dmOnly = {
    appName: 'Agor',
    publicChannels: false,
    privateChannels: false,
    groupDms: false,
    alignUsers: false,
    outbound: false,
    ingestFiles: false,
    threadHistory: true,
    channelHistory: false,
  };

  /** Tool args → SlackWizardOptions, mirroring the tool's own mapping. */
  function wizardOptionsFor({
    threadHistory,
    channelHistory,
    ...rest
  }: typeof dmOnly & { botDisplayName?: string }) {
    return {
      ...rest,
      agentTools: { thread_history: threadHistory, channel_history: channelHistory },
    };
  }

  it('marks the manifest generator read-only', async () => {
    const tools = await captureTools('admin');
    expect(tools.agor_gateway_slack_manifest_generate.cfg.annotations).toMatchObject({
      readOnlyHint: true,
    });
  });

  it('generates a DM-only manifest matching the core generator', async () => {
    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_slack_manifest_generate.handler(dmOnly);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.manifest).toEqual(buildSlackManifest(wizardOptionsFor(dmOnly)));
    expect(payload.bot_scopes).toEqual(requiredBotScopes(wizardOptionsFor(dmOnly)));
    expect(payload.bot_events).toEqual(requiredBotEvents(wizardOptionsFor(dmOnly)));
    expect(payload.bot_scopes).not.toContain('app_mentions:read');
    expect(payload.bot_scopes).not.toContain('channels:history');
    expect(payload.bot_events).toEqual(['message.im']);
    expect(payload.create_channel_config_hint).toEqual({
      channelType: 'slack',
      config: {
        connection_mode: 'socket',
        enable_channels: false,
        enable_groups: false,
        enable_mpim: false,
        align_slack_users: false,
        outbound_enabled: false,
        ingest_files: false,
        agent_tools: { thread_history: true, channel_history: false },
      },
    });
    expect(Array.isArray(payload.setup_steps)).toBe(true);
    expect(payload.caveats).toEqual(
      expect.arrayContaining([expect.stringContaining('GENERATED ONLY')])
    );

    // Secrets must never flow into the create payload the agent would paste —
    // setup_steps reference the xoxb-/xapp- token names as instructions, so the
    // no-token invariant is scoped to create_channel_config_hint.
    const hintConfig = payload.create_channel_config_hint.config;
    expect(hintConfig).not.toHaveProperty('bot_token');
    expect(hintConfig).not.toHaveProperty('app_token');
    const serializedHint = JSON.stringify(payload.create_channel_config_hint);
    expect(serializedHint).not.toContain('bot_token');
    expect(serializedHint).not.toContain('app_token');
    expect(serializedHint).not.toContain('xoxb');
    expect(serializedHint).not.toContain('xapp');
  });

  it('emits a create-compatible hint (channelType + socket connection_mode) that channels_create accepts', async () => {
    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_slack_manifest_generate.handler({
      ...dmOnly,
      alignUsers: true,
    });
    const payload = JSON.parse(result.content[0].text);
    const hint = payload.create_channel_config_hint;

    // The hint must speak the camelCase param name agor_gateway_channels_create
    // expects, and pin Socket Mode so the app_token requirement is unambiguous.
    expect(hint.channelType).toBe('slack');
    expect(hint).not.toHaveProperty('channel_type');
    expect(hint.config.connection_mode).toBe('socket');

    // Feed the hint straight into the create input schema (adding only the
    // caller-supplied non-secret fields) — it must validate.
    const parsed = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Eng Slack',
      targetBranchId: 'branch-1',
      channelType: hint.channelType,
      enabled: false,
      config: hint.config,
    });
    expect(parsed.success).toBe(true);
  });

  it('derives BOTH bot_token and app_token as required secrets from the generated hint', async () => {
    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_slack_manifest_generate.handler({
      ...dmOnly,
      alignUsers: true,
    });
    const payload = JSON.parse(result.content[0].text);
    const hintConfig = payload.create_channel_config_hint.config;

    // Regression: a manifest-generated draft must drive the token widget to ask
    // for BOTH Slack tokens — the listener requires app_token unconditionally.
    expect(getRequiredSecretFields('slack', hintConfig)).toEqual(['bot_token', 'app_token']);
  });

  it('adds outbound scopes and config when outbound is enabled', async () => {
    const opts = { ...dmOnly, outbound: true };
    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_slack_manifest_generate.handler(opts);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.manifest).toEqual(buildSlackManifest(wizardOptionsFor(opts)));
    expect(payload.bot_scopes).toEqual(requiredBotScopes(wizardOptionsFor(opts)));
    expect(payload.bot_scopes).toEqual(expect.arrayContaining(['chat:write.public', 'im:write']));
    expect(payload.create_channel_config_hint.config.outbound_enabled).toBe(true);
  });

  it('adds history scopes and agent_tools config when channelHistory is enabled', async () => {
    const opts = { ...dmOnly, channelHistory: true };
    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_slack_manifest_generate.handler(opts);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.bot_scopes).toEqual(requiredBotScopes(wizardOptionsFor(opts)));
    expect(payload.bot_scopes).toEqual(
      expect.arrayContaining(['channels:history', 'groups:history', 'mpim:history'])
    );
    expect(payload.create_channel_config_hint.config.agent_tools).toEqual({
      thread_history: true,
      channel_history: true,
    });
  });

  it('generates an all-on manifest and maps restrictToChannelIds to allowed_channel_ids', async () => {
    const opts = {
      appName: 'Agor',
      botDisplayName: 'Agor Bot',
      publicChannels: true,
      privateChannels: true,
      groupDms: true,
      alignUsers: true,
      outbound: true,
      ingestFiles: true,
      threadHistory: true,
      channelHistory: true,
    };
    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_slack_manifest_generate.handler({
      ...opts,
      restrictToChannelIds: ['C123', 'C456'],
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.manifest).toEqual(buildSlackManifest(wizardOptionsFor(opts)));
    expect(payload.manifest.features.bot_user.display_name).toBe('Agor Bot');
    expect(payload.bot_scopes).toEqual(requiredBotScopes(wizardOptionsFor(opts)));
    expect(payload.bot_events).toEqual(requiredBotEvents(wizardOptionsFor(opts)));
    expect(payload.bot_events).toEqual(expect.arrayContaining(['app_mention', 'message.im']));
    expect(payload.create_channel_config_hint.config).toMatchObject({
      enable_channels: true,
      enable_groups: true,
      enable_mpim: true,
      align_slack_users: true,
      outbound_enabled: true,
      ingest_files: true,
      agent_tools: { thread_history: true, channel_history: true },
      allowed_channel_ids: ['C123', 'C456'],
    });
    expect(payload.bot_scopes).toEqual(expect.arrayContaining(['files:read']));
    expect(payload.caveats).toEqual(
      expect.arrayContaining([
        expect.stringContaining('restrictToChannelIds maps to config.allowed_channel_ids'),
      ])
    );
    expect(payload.caveats).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/restrictToChannelIds.*does NOT change the manifest scopes/),
      ])
    );
  });

  it('defaults to aligning Slack users so omitted toggles need no run-as user', async () => {
    // The manifest tool defaults alignUsers:true so agent-driven setup produces a
    // valid channel with no empty run-as user. The generated hint therefore aligns
    // by email and the manifest carries the users:read.email scope.
    const dmAligned = { ...dmOnly, alignUsers: true };
    const tools = await captureTools('admin');
    const parsed = tools.agor_gateway_slack_manifest_generate.cfg.inputSchema.parse({
      appName: 'Agor',
    });
    expect(parsed.alignUsers).toBe(true);
    // Schema defaults mirror the capability defaults: thread history stays on,
    // channel history requires explicit opt-in.
    expect(parsed.threadHistory).toBe(true);
    expect(parsed.channelHistory).toBe(false);

    const result = await tools.agor_gateway_slack_manifest_generate.handler(parsed);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.manifest).toEqual(buildSlackManifest(wizardOptionsFor(dmAligned)));
    expect(payload.create_channel_config_hint.config.align_slack_users).toBe(true);
    expect(payload.bot_scopes).toEqual(expect.arrayContaining(['users:read.email']));
    expect(payload.create_channel_config_hint.config).not.toHaveProperty('allowed_channel_ids');
  });

  it('denies the manifest generator for non-admin users', async () => {
    const tools = await captureTools('member');
    await expect(tools.agor_gateway_slack_manifest_generate.handler(dmOnly)).rejects.toThrow(
      'admin role required'
    );
  });
});
