import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  BranchRepository,
  GatewayChannelRepository,
  SessionRepository,
  ThreadSessionMapRepository,
  UsersRepository,
} from '@agor/core/db';
import {
  buildSlackManifest,
  getConnector,
  requiredBotEvents,
  requiredBotScopes,
} from '@agor/core/gateway';
import { AGENTIC_TOOL_NAMES, getRequiredSecretFields } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestExecutor } from '../../utils/spawn-executor.js';
import { getUploadDirectory, MAX_UPLOAD_FILE_SIZE } from '../../utils/upload.js';

const uploadStoreMock = vi.hoisted(() => ({
  stage: vi.fn(
    async (input: { body: AsyncIterable<Uint8Array>; name: string; mimeType: string }) => {
      let size = 0;
      for await (const chunk of input.body) size += chunk.byteLength;
      return {
        ref: 'upl_00000000-0000-4000-8000-000000000099',
        name: input.name,
        mimeType: input.mimeType,
        size,
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
        provenance: 'mcp-slack',
      };
    }
  ),
  inspect: vi.fn(),
  read: vi.fn(),
  consume: vi.fn(async () => undefined),
}));

vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return {
    ...actual,
    getConnector: vi.fn(),
  };
});

vi.mock('../../utils/upload.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/upload.js')>();
  return {
    ...actual,
    getUploadDirectory: vi.fn(actual.getUploadDirectory),
  };
});
vi.mock('../../utils/executor-delegated-home.js', () => ({
  resolveDelegatedExecutionHomeKey: vi.fn(async () => undefined),
}));
vi.mock('../../utils/spawn-executor.js', () => ({
  getDaemonUrl: vi.fn(() => 'http://daemon.test'),
  requestExecutor: vi.fn(),
}));
vi.mock('../../services/session-token-service.js', () => ({
  issueExecutorCommandToken: vi.fn(async () => 'delegated-user-token'),
}));
vi.mock('../../utils/upload-staging.js', () => ({
  getUploadStagingStore: () => uploadStoreMock,
}));

type ServiceStub = Record<string, (...args: unknown[]) => unknown>;
function makeFakeApp(services: Record<string, ServiceStub>, config: Record<string, unknown> = {}) {
  return {
    get: (name: string) => (name === 'config' ? config : {}),
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

describe('gateway channel MCP agentic-tool schemas', () => {
  it('accepts every active tool and rejects historical tools', async () => {
    const tools = await captureTools();
    const createSchema = tools.agor_gateway_channels_create.cfg.inputSchema;
    const updateSchema = tools.agor_gateway_channels_update.cfg.inputSchema;

    for (const agent of AGENTIC_TOOL_NAMES) {
      expect(
        createSchema.safeParse({
          name: 'Draft',
          targetBranchId: 'branch-1',
          enabled: false,
          config: { align_slack_users: true },
          agenticConfig: { agent },
        }).success
      ).toBe(true);
      expect(
        updateSchema.safeParse({
          gatewayChannelId: 'gateway-1',
          agenticConfig: { agent },
        }).success
      ).toBe(true);
    }

    expect(
      createSchema.safeParse({
        name: 'Draft',
        targetBranchId: 'branch-1',
        enabled: false,
        config: { align_slack_users: true },
        agenticConfig: { agent: 'claude-code-cli' },
      }).success
    ).toBe(false);
    expect(
      updateSchema.safeParse({
        gatewayChannelId: 'gateway-1',
        agenticConfig: { agent: 'claude-code-cli' },
      }).success
    ).toBe(false);
  });
});

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
    db: {
      transaction: async (callback: (tx: unknown) => unknown) =>
        callback({ execute: async () => undefined }),
    } as any,
    userId: 'user-1' as any,
    ...(sessionId ? { sessionId: sessionId as any } : {}),
    authenticatedUser: { user_id: 'user-1', role } as any,
    baseServiceParams: {
      authenticated: true,
      user: { user_id: 'user-1', role },
      tenant: { tenant_id: 'tenant-test' },
    } as any,
  });
  return tools;
}

/**
 * The caller session used for session-branch binding: ctx.sessionId ('sess-1')
 * resolves to a session on the given branch. null simulates a stale/missing
 * session, which the binding must treat as fail-closed.
 */
function spyCallerSessionBranch(
  branchId: string | null,
  session: { created_by?: string; sdk_home_scope?: 'execution_home' | 'branch' } = {}
) {
  return vi.spyOn(SessionRepository.prototype, 'findById').mockResolvedValue(
    (branchId
      ? {
          session_id: 'sess-1',
          branch_id: branchId,
          created_by: 'user-1',
          sdk_home_scope: 'execution_home',
          ...session,
        }
      : null) as any
  );
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
  path: '/tenant-test/branch-1',
  primary_owner_user_id: 'branch-owner',
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

beforeEach(() => {
  vi.spyOn(BranchRepository.prototype, 'resolveUserAccess').mockResolvedValue({
    can: 'session',
    fs_access: 'write',
    is_owner: false,
    source: 'others',
  });
  vi.spyOn(BranchRepository.prototype, 'resolveSessionPromptAuthority').mockResolvedValue({
    allowed: true,
    execution_user_id: 'user-1' as any,
    source: 'own_session',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(getConnector).mockReset();
  vi.mocked(getUploadDirectory).mockReset();
  vi.mocked(requestExecutor).mockReset();
  uploadStoreMock.inspect.mockReset();
  uploadStoreMock.read.mockReset();
  uploadStoreMock.consume.mockClear();
});

describe('agor_gateway_channels MCP tools', () => {
  it('rejects daemon-owned and unrecognized Discord configuration', async () => {
    const tools = await captureTools();
    const createSchema = tools.agor_gateway_channels_create.cfg.inputSchema;
    const updateSchema = tools.agor_gateway_channels_update.cfg.inputSchema;

    for (const key of [
      'provider_installation_id',
      'provider_config_generation',
      'listener_checkpoint',
      'discord_last_admitted_message_id',
      'delivery_status',
      'repair',
      'redrive',
      'history',
      'provider_actions',
    ]) {
      const input = {
        name: 'Discord',
        targetBranchId: 'branch-1',
        channelType: 'discord',
        enabled: false,
        config: { [key]: 'not-operator-config' },
      };
      expect(createSchema.safeParse(input).success, key).toBe(false);
      expect(
        updateSchema.safeParse({
          gatewayChannelId: 'gateway-1',
          channelType: 'discord',
          config: { [key]: 'not-operator-config' },
        }).success,
        key
      ).toBe(false);
    }

    expect(
      createSchema.safeParse({
        name: 'Discord',
        targetBranchId: 'branch-1',
        channelType: 'discord',
        enabled: false,
        config: { unsupported_provider_option: true },
      }).success
    ).toBe(false);
  });

  it('projects runtime provider identity out of list responses', async () => {
    const app = makeFakeApp({
      'gateway-channels': {
        find: async () => ({
          total: 1,
          data: [
            {
              ...slackChannel,
              provider_installation_id: 'application-snowflake',
              provider_config_generation: 7,
              config: {
                bot_token: 'xoxb-secret',
                listener_checkpoint: 'transport-sequence',
              },
            },
          ],
        }),
      },
    });
    const tools = await captureTools('admin', app);
    const result = await tools.agor_gateway_channels_list.handler({});
    const payload = JSON.parse(result.content[0].text);
    const channel = payload.gateway_channels[0];

    expect(channel).not.toHaveProperty('provider_installation_id');
    expect(channel).not.toHaveProperty('provider_config_generation');
    expect(channel.config).not.toHaveProperty('listener_checkpoint');
    expect(channel.config.bot_token).toBe('••••••••');
  });

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

    const discordDraftIncomplete = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Draft Discord',
      targetBranchId: 'branch-1',
      channelType: 'discord',
      enabled: false,
      agorUserId: 'user-runner',
      config: { application_id: '111111111111111111' },
    });
    expect(discordDraftIncomplete.success).toBe(false);

    const discordDraftComplete = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Draft Discord',
      targetBranchId: 'branch-1',
      channelType: 'discord',
      enabled: false,
      agorUserId: 'user-runner',
      config: {
        application_id: '111111111111111111',
        guild_id: '222222222222222222',
        allowed_channel_ids: ['333333333333333333'],
        allowed_user_ids: ['444444444444444444'],
        allowed_role_ids: [],
        message_content_enabled: true,
        thread_mode: 'public_thread_per_summon',
        align_discord_users: false,
      },
    });
    expect(discordDraftComplete.success).toBe(true);

    const discordDraftWithToken = tools.agor_gateway_channels_create.cfg.inputSchema.safeParse({
      name: 'Draft Discord',
      targetBranchId: 'branch-1',
      channelType: 'discord',
      enabled: false,
      agorUserId: 'user-runner',
      config: {
        application_id: '111111111111111111',
        guild_id: '222222222222222222',
        allowed_channel_ids: ['333333333333333333'],
        allowed_user_ids: ['444444444444444444'],
        allowed_role_ids: [],
        message_content_enabled: true,
        thread_mode: 'public_thread_per_summon',
        align_discord_users: false,
        bot_token: 'discord-secret',
      },
    });
    expect(discordDraftWithToken.success).toBe(false);
    expect(String(discordDraftWithToken.error)).toContain('secure gateway token widget');
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

  it('normalizes a fresh disabled Discord draft before service persistence', async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const app = makeFakeApp({
      'gateway-channels': {
        create: async (data: Record<string, unknown>) => {
          createCalls.push(data);
          return {
            id: 'discord-draft',
            created_by: 'admin-1',
            name: data.name,
            channel_type: 'discord',
            target_branch_id: data.target_branch_id,
            agor_user_id: data.agor_user_id,
            channel_key: 'raw-key',
            config: data.config,
            agentic_config: null,
            enabled: false,
            created_at: '2026-06-22T00:00:00.000Z',
            updated_at: '2026-06-22T00:00:00.000Z',
            last_message_at: null,
          };
        },
      },
    });
    const tools = await captureTools('admin', app);

    await tools.agor_gateway_channels_create.handler({
      name: 'Draft Discord',
      targetBranchId: 'branch-1',
      channelType: 'discord',
      enabled: false,
      agorUserId: 'user-runner',
      config: {
        application_id: '111111111111111111',
        guild_id: '222222222222222222',
        allowed_channel_ids: ['333333333333333333'],
        allowed_user_ids: ['444444444444444444'],
        allowed_role_ids: [],
        message_content_enabled: true,
        thread_mode: 'public_thread_per_summon',
        align_discord_users: false,
      },
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.config).toMatchObject({
      catch_up: expect.objectContaining({
        max_pages: 5,
        max_messages: 200,
        max_prompt_bytes: 32768,
      }),
      files: false,
      agent_tools: [],
    });
    expect(createCalls[0]?.config).not.toHaveProperty('bot_token');
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

  it('validates the stored Discord provider when channelType is omitted', async () => {
    const patch = vi.fn(async (id: string, data: Record<string, unknown>) => ({
      id,
      created_by: 'admin-1',
      name: 'Discord',
      channel_type: 'discord',
      target_branch_id: 'branch-1',
      agor_user_id: 'user-1',
      channel_key: 'raw-key',
      config: {
        application_id: '111111111111111111',
        guild_id: '222222222222222222',
        allowed_channel_ids: ['333333333333333333'],
        allowed_user_ids: ['444444444444444444'],
        allowed_role_ids: [],
        message_content_enabled: true,
        thread_mode: 'public_thread_per_summon',
        thread_auto_archive_minutes: 1440,
        align_discord_users: false,
        catch_up: {
          max_pages: 5,
          max_messages: 200,
          max_prompt_bytes: 32768,
          request_timeout_ms: 30000,
          rate_limit_max_retries: 2,
          rate_limit_max_total_delay_ms: 10000,
        },
        files: false,
        agent_tools: [],
        ...(data.config as Record<string, unknown>),
      },
      agentic_config: null,
      enabled: false,
      created_at: '2026-06-22T00:00:00.000Z',
      updated_at: '2026-06-22T00:00:00.000Z',
      last_message_at: null,
    }));
    const app = makeFakeApp({
      'gateway-channels': {
        get: async () => ({
          id: 'chan-1',
          name: 'Discord',
          channel_type: 'discord',
          target_branch_id: 'branch-1',
          agor_user_id: 'user-1',
          config: {
            application_id: '111111111111111111',
            guild_id: '222222222222222222',
            allowed_channel_ids: ['333333333333333333'],
            allowed_user_ids: ['444444444444444444'],
            allowed_role_ids: [],
            message_content_enabled: true,
            thread_mode: 'public_thread_per_summon',
            thread_auto_archive_minutes: 1440,
            align_discord_users: false,
            catch_up: {
              max_pages: 5,
              max_messages: 200,
              max_prompt_bytes: 32768,
              request_timeout_ms: 30000,
              rate_limit_max_retries: 2,
              rate_limit_max_total_delay_ms: 10000,
            },
            files: false,
            agent_tools: [],
          },
        }),
        patch,
      },
    });
    const tools = await captureTools('admin', app);
    await tools.agor_gateway_channels_update.handler({
      gatewayChannelId: 'chan-1',
      config: { bot_token: '••••••••' },
    });
    expect(patch).toHaveBeenCalledWith(
      'chan-1',
      { config: { bot_token: '••••••••' } },
      expect.anything()
    );
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
      tenant: { tenant_id: 'tenant-test' },
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

  it('plumbs threadTs through to the gateway service for thread replies', async () => {
    const emitMessage = vi.fn(async () => ({
      success: true,
      gateway_outbound_message_id: 'out-2',
      gateway_channel_id: 'chan-1',
      channel_type: 'slack',
      platform_channel_id: 'C123',
      platform_message_id: '171235.000200',
      platform_thread_id: 'C123-171234.000100',
    }));
    const tools = await captureTools('member', makeFakeApp({ gateway: { emitMessage } }));

    await tools.agor_gateway_emit_message.handler({
      gatewayChannelId: 'chan-1',
      message: 'Reply in thread',
      target: 'channel:C123',
      threadTs: '171234.000100',
    });

    expect(emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadTs: '171234.000100' })
    );
  });

  it('omits threadTs from the gateway service call when not provided', async () => {
    const emitMessage = vi.fn(async () => ({
      success: true,
      gateway_outbound_message_id: 'out-3',
      gateway_channel_id: 'chan-1',
      channel_type: 'slack',
      platform_channel_id: 'C123',
      platform_message_id: '171236.000300',
      platform_thread_id: 'C123-171236.000300',
    }));
    const tools = await captureTools('member', makeFakeApp({ gateway: { emitMessage } }));

    await tools.agor_gateway_emit_message.handler({
      gatewayChannelId: 'chan-1',
      message: 'New thread',
      target: 'channel:C123',
    });

    expect(emitMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ threadTs: expect.anything() })
    );
  });

  it('rejects a malformed threadTs before any gateway service call', async () => {
    const tools = await captureTools('member', makeFakeApp({ gateway: { emitMessage: vi.fn() } }));
    const schema = tools.agor_gateway_emit_message.cfg.inputSchema;

    expect(
      schema.safeParse({
        gatewayChannelId: 'chan-1',
        message: 'hi',
        target: 'channel:C123',
        threadTs: 'not-a-timestamp',
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({
        gatewayChannelId: 'chan-1',
        message: 'hi',
        target: 'channel:C123',
        threadTs: '171234.000100',
      }).success
    ).toBe(true);
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
        files: [{ id: 'F123', name: 'error.log', mimetype: 'text/plain', size: 512 }],
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
    expect(payload.messages[0].files).toEqual([
      { id: 'F123', name: 'error.log', mimetype: 'text/plain', size: 512 },
    ]);
    expect(JSON.stringify(payload)).not.toContain('url_private_download');
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
    expect(payload.markdown).toContain('Attached file F123: error.log (text/plain, 512 bytes)');
    expect(payload.markdown).not.toContain('url_private_download');
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

  const reactionsEnabled = {
    ...slackChannel,
    config: { ...slackChannel.config, agent_tools: { reactions: true } },
  };

  const fileUploadEnabled = {
    ...slackChannel,
    config: { ...slackChannel.config, agent_tools: { file_upload: true } },
  };

  it('adds a reaction defaulting to the gateway session own channel', async () => {
    const addReaction = vi.fn(async () => undefined);
    const removeReaction = vi.fn(async () => undefined);
    vi.mocked(getConnector).mockReturnValue({ addReaction, removeReaction } as any);
    spyCallerGatewaySession('branch-1', gatewaySource);
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
      reactionsEnabled as any
    );
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

    const tools = await captureTools('member');
    const result = await tools.agor_gateway_slack_reaction_add.handler({
      ts: '171234.000100',
      emoji: 'thumbsup',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(addReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '171234.000100',
      name: 'thumbsup',
    });
    expect(payload).toMatchObject({ added: true, slack_channel_id: 'C123', emoji: 'thumbsup' });
  });

  it('removes a reaction defaulting to the gateway session own channel', async () => {
    const addReaction = vi.fn(async () => undefined);
    const removeReaction = vi.fn(async () => undefined);
    vi.mocked(getConnector).mockReturnValue({ addReaction, removeReaction } as any);
    spyCallerGatewaySession('branch-1', gatewaySource);
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
      reactionsEnabled as any
    );
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

    const tools = await captureTools('member');
    const result = await tools.agor_gateway_slack_reaction_remove.handler({
      ts: '171234.000100',
      emoji: 'thumbsup',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(removeReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '171234.000100',
      name: 'thumbsup',
    });
    expect(payload).toMatchObject({ removed: true, slack_channel_id: 'C123', emoji: 'thumbsup' });
  });

  it('denies reaction add/remove when the reactions capability is disabled, with an actionable error', async () => {
    spyCallerGatewaySession('branch-1', gatewaySource);
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(slackChannel as any);
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

    const tools = await captureTools('member');
    await expect(
      tools.agor_gateway_slack_reaction_add.handler({ ts: '171234.000100', emoji: 'thumbsup' })
    ).rejects.toThrow("capability 'reactions' is disabled");
    await expect(
      tools.agor_gateway_slack_reaction_remove.handler({ ts: '171234.000100', emoji: 'thumbsup' })
    ).rejects.toThrow("capability 'reactions' is disabled");
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('denies reactions across branches even for admins', async () => {
    spyCallerSessionBranch('branch-2');
    vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
      reactionsEnabled as any
    );

    const tools = await captureTools('admin');
    await expect(
      tools.agor_gateway_slack_reaction_add.handler({
        gatewayChannelId: 'chan-1',
        slackChannelId: 'C123',
        ts: '171234.000100',
        emoji: 'thumbsup',
      })
    ).rejects.toThrow('targets a different branch');
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('rejects malformed slackChannelId/ts/emoji before any Slack call', async () => {
    const tools = await captureTools('member');
    const schema = tools.agor_gateway_slack_reaction_add.cfg.inputSchema;

    expect(
      schema.safeParse({ slackChannelId: 'not-a-channel', ts: '171234.000100', emoji: 'eyes' })
        .success
    ).toBe(false);
    expect(
      schema.safeParse({ slackChannelId: 'C123', ts: 'not-a-timestamp', emoji: 'eyes' }).success
    ).toBe(false);
    expect(
      schema.safeParse({ slackChannelId: 'C123', ts: '171234.000100', emoji: ':eyes:' }).success
    ).toBe(false);
    expect(
      schema.safeParse({ slackChannelId: 'C123', ts: '171234.000100', emoji: 'eyes' }).success
    ).toBe(true);
    expect(getConnector).not.toHaveBeenCalled();
  });

  describe('allowed_channel_ids whitelist on reaction writes', () => {
    const restrictedReactionsEnabled = {
      ...slackChannel,
      config: {
        ...slackChannel.config,
        agent_tools: { reactions: true },
        allowed_channel_ids: ['C123'],
      },
    };

    it('denies reacting to a channel-like slackChannelId outside the allowlist', async () => {
      spyCallerGatewaySession('branch-1', gatewaySource);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        restrictedReactionsEnabled as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      await expect(
        tools.agor_gateway_slack_reaction_add.handler({
          slackChannelId: 'C999',
          ts: '171234.000100',
          emoji: 'thumbsup',
        })
      ).rejects.toThrow("not in this gateway channel's allowed_channel_ids whitelist");
      expect(getConnector).not.toHaveBeenCalled();
    });

    it('allows reacting to a DM slackChannelId even with an allowlist configured', async () => {
      const addReaction = vi.fn(async () => undefined);
      const removeReaction = vi.fn(async () => undefined);
      vi.mocked(getConnector).mockReturnValue({ addReaction, removeReaction } as any);
      spyCallerGatewaySession('branch-1', {
        ...gatewaySource,
        slack_channel_id: 'D123',
      });
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        restrictedReactionsEnabled as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      const result = await tools.agor_gateway_slack_reaction_add.handler({
        ts: '171234.000100',
        emoji: 'thumbsup',
      });
      const payload = JSON.parse(result.content[0].text);

      expect(addReaction).toHaveBeenCalledWith({
        channel: 'D123',
        timestamp: '171234.000100',
        name: 'thumbsup',
      });
      expect(payload).toMatchObject({ added: true, slack_channel_id: 'D123' });
    });

    it('allows any channel-like slackChannelId when no allowlist is configured', async () => {
      const addReaction = vi.fn(async () => undefined);
      const removeReaction = vi.fn(async () => undefined);
      vi.mocked(getConnector).mockReturnValue({ addReaction, removeReaction } as any);
      spyCallerGatewaySession('branch-1', gatewaySource);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        reactionsEnabled as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      const result = await tools.agor_gateway_slack_reaction_add.handler({
        slackChannelId: 'C999',
        ts: '171234.000100',
        emoji: 'thumbsup',
      });
      const payload = JSON.parse(result.content[0].text);

      expect(addReaction).toHaveBeenCalledWith({
        channel: 'C999',
        timestamp: '171234.000100',
        name: 'thumbsup',
      });
      expect(payload).toMatchObject({ added: true, slack_channel_id: 'C999' });
    });
  });

  describe('allowed_channel_ids whitelist on file_upload', () => {
    const restrictedFileUploadEnabled = {
      ...slackChannel,
      config: {
        ...slackChannel.config,
        agent_tools: { file_upload: true },
        allowed_channel_ids: ['C123'],
      },
    };

    it('denies uploading to a channel-like slackChannelId outside the allowlist', async () => {
      const uploadDir = fs.mkdtempSync(path.join(tmpdir(), 'agor-gateway-upload-allowlist-'));
      const filePath = path.join(uploadDir, 'screenshot.png');
      fs.writeFileSync(filePath, Buffer.from('bytes'));
      vi.mocked(getUploadDirectory).mockReturnValue(uploadDir);
      try {
        spyCallerGatewaySession('branch-1', gatewaySource);
        vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
          restrictedFileUploadEnabled as any
        );
        vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

        const tools = await captureTools('member');
        await expect(
          tools.agor_gateway_slack_file_upload.handler({
            slackChannelId: 'C999',
            source: { kind: 'branch', branchPath: 'screenshot.png' },
          })
        ).rejects.toThrow("not in this gateway channel's allowed_channel_ids whitelist");
        expect(getConnector).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      }
    });

    it('allows uploading to a DM slackChannelId even with an allowlist configured', async () => {
      const uploadDir = fs.mkdtempSync(path.join(tmpdir(), 'agor-gateway-upload-allowlist-dm-'));
      const filePath = path.join(uploadDir, 'screenshot.png');
      fs.writeFileSync(filePath, Buffer.from('bytes'));
      vi.mocked(getUploadDirectory).mockReturnValue(uploadDir);
      try {
        const uploadFile = vi.fn(async () => ({
          id: 'F999',
          permalink: null,
          name: 'screenshot.png',
        }));
        vi.mocked(getConnector).mockReturnValue({ uploadFile } as any);
        spyCallerGatewaySession('branch-1', gatewaySource);
        vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
          restrictedFileUploadEnabled as any
        );
        vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

        const tools = await captureTools('member');
        vi.mocked(requestExecutor).mockResolvedValue({
          success: true,
          data: { uploaded: { id: 'F999', name: 'screenshot.png' } },
        });
        const result = await tools.agor_gateway_slack_file_upload.handler({
          slackChannelId: 'D123',
          source: { kind: 'branch', branchPath: 'screenshot.png' },
        });
        const payload = JSON.parse(result.content[0].text);

        expect(requestExecutor).toHaveBeenCalledWith(
          expect.objectContaining({
            params: expect.objectContaining({ channel: 'D123', filePath: 'screenshot.png' }),
          }),
          expect.any(Object)
        );
        expect(payload).toMatchObject({ uploaded: true, slack_channel_id: 'D123' });
      } finally {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      }
    });
  });

  describe('agor_upload_materialize', () => {
    const uploadRef = 'upl_00000000-0000-4000-8000-000000000001';
    const stagedUpload = {
      ref: uploadRef,
      name: 'brief.txt',
      mimeType: 'text/plain',
      size: 16,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      provenance: 'browser',
    } as const;
    const perUserSandboxConfig = {
      paths: { data_home: '/srv/agor-data' },
      execution: {
        unix_user_mode: 'sandbox',
        sandbox: { enabled: true, home_mode: 'per_user' },
      },
    };

    it('projects normalized branch write access into the executor command', async () => {
      uploadStoreMock.inspect.mockResolvedValue(stagedUpload);
      vi.mocked(requestExecutor).mockResolvedValue({
        success: true,
        data: { path: '.agor/session-staging/brief.txt' },
      });
      spyCallerSessionBranch('branch-1');
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      await tools.agor_upload_materialize.handler({ uploadRef });

      expect(requestExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'branch.upload.materialize',
          params: expect.objectContaining({
            branchId: 'branch-1',
            cwd: '/tenant-test/branch-1',
            principalBranchAccess: 'write',
          }),
        }),
        expect.objectContaining({
          templateVariables: {
            branch_id: 'branch-1',
            user_id: 'user-1',
            branch_fs_access: 'write',
          },
        })
      );
    });

    it('resolves the owner-scoped sandbox home for a private RBAC branch', async () => {
      uploadStoreMock.inspect.mockResolvedValue(stagedUpload);
      vi.spyOn(UsersRepository.prototype, 'findById').mockResolvedValue({
        user_id: 'user-1',
        filesystem_home: null,
      } as any);
      vi.mocked(requestExecutor).mockImplementation(async (payload: any) =>
        payload.params?.sandboxHomeStore
          ? { success: true, data: { path: '.agor/session-staging/brief.txt' } }
          : {
              success: false,
              error: {
                code: 'EXECUTOR_SPAWN_ERROR',
                message:
                  'Executor sandbox setup failed: sandbox home_mode=per_user requires an owner home store, but none was resolved. Refusing to fall back to a shared home (fail closed).',
              },
            }
      );
      spyCallerSessionBranch('branch-1');
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member', makeFakeApp({}, perUserSandboxConfig));
      await expect(tools.agor_upload_materialize.handler({ uploadRef })).resolves.toBeDefined();

      expect(requestExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({
            sandboxHomeStore: '/srv/agor-data/tenants/tenant-test/homes/user-1',
          }),
        }),
        expect.objectContaining({
          templateVariables: expect.objectContaining({ user_id: 'user-1' }),
        })
      );
    });

    it('uses prompt authority for a shared branch-home session, not its foreign owner home', async () => {
      uploadStoreMock.inspect.mockResolvedValue(stagedUpload);
      vi.spyOn(BranchRepository.prototype, 'resolveSessionPromptAuthority').mockResolvedValue({
        allowed: true,
        execution_user_id: 'user-1' as any,
        source: 'branch_session',
      });
      const findUser = vi
        .spyOn(UsersRepository.prototype, 'findById')
        .mockResolvedValue({ user_id: 'user-1', filesystem_home: null } as any);
      vi.mocked(requestExecutor).mockResolvedValue({
        success: true,
        data: { path: '.agor/session-staging/brief.txt' },
      });
      spyCallerSessionBranch('branch-1', {
        created_by: 'foreign-session-owner',
        sdk_home_scope: 'branch',
      });
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member', makeFakeApp({}, perUserSandboxConfig));
      await tools.agor_upload_materialize.handler({ uploadRef });

      expect(findUser).toHaveBeenCalledWith('user-1');
      expect(requestExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({
            sandboxHomeStore: '/srv/agor-data/tenants/tenant-test/homes/user-1',
          }),
        }),
        expect.objectContaining({
          templateVariables: expect.objectContaining({ user_id: 'user-1' }),
        })
      );
      expect(JSON.stringify(vi.mocked(requestExecutor).mock.calls[0])).not.toContain(
        'foreign-session-owner'
      );
    });

    it('rejects unresolved or denied execution-home authority without spawning', async () => {
      spyCallerSessionBranch('branch-1', {
        created_by: 'foreign-session-owner',
        sdk_home_scope: 'execution_home',
      });
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);
      vi.spyOn(BranchRepository.prototype, 'resolveSessionPromptAuthority').mockResolvedValue({
        allowed: false,
        source: 'denied',
        denial_reason: 'execution_home_sharing_disabled',
      });

      const tools = await captureTools('member', makeFakeApp({}, perUserSandboxConfig));
      await expect(tools.agor_upload_materialize.handler({ uploadRef })).rejects.toThrow(
        "uses its owner's execution home and cannot be shared"
      );
      expect(uploadStoreMock.inspect).not.toHaveBeenCalled();
      expect(requestExecutor).not.toHaveBeenCalled();
    });

    it('fails closed when prompt authority omits the execution-home owner', async () => {
      spyCallerSessionBranch('branch-1');
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);
      vi.spyOn(BranchRepository.prototype, 'resolveSessionPromptAuthority').mockResolvedValue({
        allowed: true,
        source: 'own_session',
      });

      const tools = await captureTools('member');
      await expect(tools.agor_upload_materialize.handler({ uploadRef })).rejects.toThrow(
        'refusing to use a shared home (fail closed)'
      );
      expect(uploadStoreMock.inspect).not.toHaveBeenCalled();
      expect(requestExecutor).not.toHaveBeenCalled();
    });

    it('rejects materialization when the caller has only branch filesystem read access', async () => {
      vi.spyOn(BranchRepository.prototype, 'resolveUserAccess').mockResolvedValue({
        can: 'session',
        fs_access: 'read',
        is_owner: false,
        source: 'others',
      });
      spyCallerSessionBranch('branch-1');
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      await expect(tools.agor_upload_materialize.handler({ uploadRef })).rejects.toThrow(
        'branch filesystem write access required'
      );
      expect(uploadStoreMock.inspect).not.toHaveBeenCalled();
      expect(requestExecutor).not.toHaveBeenCalled();
    });
  });

  describe('agor_gateway_slack_file_upload', () => {
    let uploadDir: string;

    function withUploadDir(): string {
      uploadDir = fs.mkdtempSync(path.join(tmpdir(), 'agor-gateway-upload-'));
      vi.mocked(getUploadDirectory).mockReturnValue(uploadDir);
      return uploadDir;
    }

    afterEach(() => {
      if (uploadDir) fs.rmSync(uploadDir, { recursive: true, force: true });
    });

    it('streams a session-owned staged handle without exposing its daemon path', async () => {
      uploadStoreMock.inspect.mockResolvedValue({
        ref: 'upl_00000000-0000-4000-8000-000000000001',
        name: 'screenshot.png',
        mimeType: 'image/png',
        size: 16,
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
        provenance: 'browser',
      });
      const stream = Readable.from('fake-image-bytes');
      uploadStoreMock.read.mockResolvedValue(stream);
      const uploadFile = vi.fn(async () => ({
        id: 'F123',
        permalink: 'https://slack.example/files/F123',
        name: 'screenshot.png',
      }));
      vi.mocked(getConnector).mockReturnValue({ uploadFile } as any);
      spyCallerGatewaySession('branch-1', gatewaySource);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        fileUploadEnabled as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      const result = await tools.agor_gateway_slack_file_upload.handler({
        source: {
          kind: 'upload',
          uploadRef: 'upl_00000000-0000-4000-8000-000000000001',
        },
      });
      const payload = JSON.parse(result.content[0].text);

      expect(uploadFile).toHaveBeenCalledWith({
        channel: 'C123',
        file: stream,
        filename: 'screenshot.png',
      });
      expect(uploadStoreMock.consume).toHaveBeenCalled();
      expect(JSON.stringify(payload)).not.toContain('agor-gateway-upload');
      expect(payload).toMatchObject({
        uploaded: true,
        slack_channel_id: 'C123',
        file: { id: 'F123', name: 'screenshot.png' },
      });
    });

    it('uploads a file from a path relative to the branch workspace', async () => {
      vi.mocked(requestExecutor).mockResolvedValue({
        success: true,
        data: { uploaded: { id: 'F456', name: 'chart.png' } },
      });
      spyCallerGatewaySession('branch-1', gatewaySource);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        fileUploadEnabled as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      const result = await tools.agor_gateway_slack_file_upload.handler({
        source: { kind: 'branch', branchPath: 'chart.png' },
        threadTs: '171234.000100',
      });
      const payload = JSON.parse(result.content[0].text);

      expect(requestExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'branch.gateway.slack-file-upload',
          params: expect.objectContaining({
            branchId: 'branch-1',
            filePath: 'chart.png',
            gatewayChannelId: fileUploadEnabled.id,
            threadTs: '171234.000100',
            cwd: '/tenant-test/branch-1',
            principalBranchAccess: 'write',
          }),
        }),
        expect.objectContaining({
          templateVariables: {
            branch_id: 'branch-1',
            user_id: 'user-1',
            branch_fs_access: 'write',
          },
        })
      );
      const executorPayload = vi.mocked(requestExecutor).mock.calls[0]?.[0];
      expect(JSON.stringify(executorPayload)).not.toContain('xoxb');
      expect(executorPayload?.params).not.toHaveProperty('connectorConfig');
      expect(payload).toMatchObject({ uploaded: true });
    });

    it('rejects branch file uploads without filesystem read access', async () => {
      vi.spyOn(BranchRepository.prototype, 'resolveUserAccess').mockResolvedValue({
        can: 'session',
        fs_access: 'none',
        is_owner: false,
        source: 'others',
      });
      spyCallerGatewaySession('branch-1', gatewaySource);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        fileUploadEnabled as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      await expect(
        tools.agor_gateway_slack_file_upload.handler({
          source: { kind: 'branch', branchPath: 'chart.png' },
        })
      ).rejects.toThrow('branch filesystem read access required');
      expect(requestExecutor).not.toHaveBeenCalled();
    });

    it('rejects an absolute path outside the daemon upload directory', async () => {
      withUploadDir();
      const outsideDir = fs.mkdtempSync(path.join(tmpdir(), 'agor-gateway-outside-'));
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'nope');
      try {
        vi.mocked(requestExecutor).mockResolvedValue({
          success: false,
          error: { code: 'BRANCH_SLACK_FILE_UPLOAD_FAILED', message: 'Path must be relative' },
        });
        spyCallerGatewaySession('branch-1', gatewaySource);
        vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
          fileUploadEnabled as any
        );
        vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

        const tools = await captureTools('member');
        await expect(
          tools.agor_gateway_slack_file_upload.handler({
            source: { kind: 'branch', branchPath: outsideFile },
          })
        ).rejects.toThrow('Path must be relative');
        expect(getConnector).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('surfaces executor rejection for relative path traversal', async () => {
      vi.mocked(requestExecutor).mockResolvedValue({
        success: false,
        error: { code: 'BRANCH_SLACK_FILE_UPLOAD_FAILED', message: 'Path escapes branch root' },
      });
      spyCallerGatewaySession('branch-1', gatewaySource);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        fileUploadEnabled as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      await expect(
        tools.agor_gateway_slack_file_upload.handler({
          source: { kind: 'branch', branchPath: '../secret.txt' },
        })
      ).rejects.toThrow('Path escapes branch root');
      expect(getConnector).not.toHaveBeenCalled();
    });

    it('rejects an absolute path that is a symlink escaping the upload directory', async () => {
      const dir = withUploadDir();
      const outsideDir = fs.mkdtempSync(path.join(tmpdir(), 'agor-gateway-symlink-outside-'));
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'nope');
      const symlinkPath = path.join(dir, 'innocuous.png');
      fs.symlinkSync(outsideFile, symlinkPath);
      try {
        vi.mocked(requestExecutor).mockResolvedValue({
          success: false,
          error: { code: 'BRANCH_SLACK_FILE_UPLOAD_FAILED', message: 'Path must be relative' },
        });
        spyCallerGatewaySession('branch-1', gatewaySource);
        vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
          fileUploadEnabled as any
        );
        vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

        const tools = await captureTools('member');
        await expect(
          tools.agor_gateway_slack_file_upload.handler({
            source: { kind: 'branch', branchPath: symlinkPath },
          })
        ).rejects.toThrow('Path must be relative');
        expect(getConnector).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('rejects an absolute path containing a null byte', async () => {
      const dir = withUploadDir();
      spyCallerGatewaySession('branch-1', gatewaySource);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        fileUploadEnabled as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      await expect(
        tools.agor_gateway_slack_file_upload.handler({
          source: { kind: 'branch', branchPath: path.join(dir, 'evil\0.png') },
        })
      ).rejects.toThrow();
      expect(getConnector).not.toHaveBeenCalled();
    });

    it('rejects a file exceeding the upload size limit', async () => {
      const dir = withUploadDir();
      const filePath = path.join(dir, 'huge.bin');
      fs.writeFileSync(filePath, Buffer.alloc(0));
      fs.truncateSync(filePath, MAX_UPLOAD_FILE_SIZE + 1);

      spyCallerGatewaySession('branch-1', gatewaySource);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        fileUploadEnabled as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);
      vi.mocked(requestExecutor).mockResolvedValue({
        success: false,
        error: { code: 'BRANCH_SLACK_FILE_UPLOAD_FAILED', message: 'File exceeds the limit' },
      });

      const tools = await captureTools('member');
      await expect(
        tools.agor_gateway_slack_file_upload.handler({
          source: { kind: 'branch', branchPath: filePath },
        })
      ).rejects.toThrow('exceeds the');
      expect(getConnector).not.toHaveBeenCalled();
    });

    it('denies file upload when the file_upload capability is disabled, with an actionable error', async () => {
      const dir = withUploadDir();
      const filePath = path.join(dir, 'screenshot.png');
      fs.writeFileSync(filePath, Buffer.from('x'));

      spyCallerGatewaySession('branch-1', gatewaySource);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        slackChannel as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      await expect(
        tools.agor_gateway_slack_file_upload.handler({
          source: { kind: 'branch', branchPath: 'screenshot.png' },
        })
      ).rejects.toThrow("capability 'file_upload' is disabled");
      expect(getConnector).not.toHaveBeenCalled();
    });

    it('denies file upload across branches even for admins', async () => {
      spyCallerSessionBranch('branch-2');
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        fileUploadEnabled as any
      );

      const tools = await captureTools('admin');
      await expect(
        tools.agor_gateway_slack_file_upload.handler({
          gatewayChannelId: 'chan-1',
          slackChannelId: 'C123',
          source: { kind: 'branch', branchPath: 'whatever.png' },
        })
      ).rejects.toThrow('targets a different branch');
      expect(getConnector).not.toHaveBeenCalled();
    });

    it('rejects malformed slackChannelId/threadTs before any Slack call', async () => {
      const tools = await captureTools('member');
      const schema = tools.agor_gateway_slack_file_upload.cfg.inputSchema;

      expect(
        schema.safeParse({
          slackChannelId: 'not-a-channel',
          source: { kind: 'branch', branchPath: 'x.png' },
        }).success
      ).toBe(false);
      expect(
        schema.safeParse({
          slackChannelId: 'C123',
          threadTs: 'not-a-timestamp',
          source: { kind: 'branch', branchPath: 'x.png' },
        }).success
      ).toBe(false);
      expect(
        schema.safeParse({
          slackChannelId: 'C123',
          threadTs: '171234.000100',
          source: { kind: 'branch', branchPath: 'x.png' },
        }).success
      ).toBe(true);
      expect(getConnector).not.toHaveBeenCalled();
    });
  });

  describe('agor_gateway_slack_file_download', () => {
    const fileDownloadEnabled = {
      ...slackChannel,
      config: { ...slackChannel.config, agent_tools: { file_download: true } },
    };

    const slackFileInfo = {
      id: 'F123',
      name: 'error.log',
      mimetype: 'text/plain',
      size: 512,
      url_private_download: 'https://files.slack.com/files-pri/T1-F123/download/error.log',
    };

    const slackFileResult = { file: slackFileInfo, sourceConversationIds: ['C123'] };

    let uploadDir: string;

    function withUploadDir(): string {
      uploadDir = fs.mkdtempSync(path.join(tmpdir(), 'agor-gateway-download-'));
      vi.mocked(getUploadDirectory).mockReturnValue(uploadDir);
      return uploadDir;
    }

    afterEach(() => {
      if (uploadDir) fs.rmSync(uploadDir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    });

    it('downloads a file via files.info through the hardened ingestion path into the upload dir', async () => {
      void withUploadDir();
      const fetchMock = vi.fn(
        async () =>
          new Response('log line one', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          })
      );
      vi.stubGlobal('fetch', fetchMock);

      const getFileInfo = vi.fn(async () => slackFileResult);
      vi.mocked(getConnector).mockReturnValue({ getFileInfo } as any);
      spyCallerGatewaySession('branch-1', gatewaySource);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        fileDownloadEnabled as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      const result = await tools.agor_gateway_slack_file_download.handler({ fileId: 'F123' });
      const payload = JSON.parse(result.content[0].text);

      expect(getFileInfo).toHaveBeenCalledWith('F123');
      // The download reuses the hardened inbound-ingestion path: bot-token
      // Authorization against the allowlisted Slack host, manual redirects.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(slackFileInfo.url_private_download, {
        headers: { Authorization: 'Bearer xoxb-secret' },
        redirect: 'manual',
      });
      expect(payload).toMatchObject({
        downloaded: true,
        gateway_channel: { id: 'chan-1', target_branch_id: 'branch-1' },
        file: { id: 'F123', name: 'error.log', mimetype: 'text/plain', size: 512 },
      });
      expect(payload.file.upload_ref).toMatch(/^upl_/);
      expect(payload.file).not.toHaveProperty('path');
      expect(JSON.stringify(payload)).not.toContain('url_private_download');
      expect(JSON.stringify(payload)).not.toContain('files.slack.com');
      expect(JSON.stringify(payload)).not.toContain('xoxb-secret');
    });

    it('denies file download when the capability is disabled, with an actionable error', async () => {
      spyCallerGatewaySession('branch-1', gatewaySource);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        slackChannel as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('admin');
      const error = await tools.agor_gateway_slack_file_download
        .handler({ fileId: 'F123' })
        .then(() => null)
        .catch((err: Error) => err);

      expect(error).toBeTruthy();
      expect(error!.message).toContain("capability 'file_download' is disabled");
      expect(error!.message).toContain('agor_gateway_channels_update');
      expect(error!.message).toContain('config.agent_tools.file_download');
      expect(getConnector).not.toHaveBeenCalled();
    });

    it('denies file download across branches even for admins', async () => {
      spyCallerSessionBranch('branch-2');
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        fileDownloadEnabled as any
      );

      const tools = await captureTools('admin');
      await expect(
        tools.agor_gateway_slack_file_download.handler({
          gatewayChannelId: 'chan-1',
          fileId: 'F123',
        })
      ).rejects.toThrow('targets a different branch');
      expect(getConnector).not.toHaveBeenCalled();
    });

    it('rejects a disallowed mimetype without downloading', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      vi.mocked(getConnector).mockReturnValue({
        getFileInfo: vi.fn(async () => ({
          ...slackFileResult,
          file: { ...slackFileInfo, mimetype: 'application/pdf' },
        })),
      } as any);
      spyCallerGatewaySession('branch-1', gatewaySource);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        fileDownloadEnabled as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      await expect(
        tools.agor_gateway_slack_file_download.handler({ fileId: 'F123' })
      ).rejects.toThrow('which the gateway does not download');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('inherits the slack.com host allowlist from the hardened download path', async () => {
      withUploadDir();
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      vi.mocked(getConnector).mockReturnValue({
        getFileInfo: vi.fn(async () => ({
          ...slackFileResult,
          file: {
            ...slackFileInfo,
            url_private_download: 'https://evil.example/files-pri/T1-F123/download/error.log',
          },
        })),
      } as any);
      spyCallerGatewaySession('branch-1', gatewaySource);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        fileDownloadEnabled as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);

      const tools = await captureTools('member');
      await expect(
        tools.agor_gateway_slack_file_download.handler({ fileId: 'F123' })
      ).rejects.toThrow('Failed to download Slack file');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps the no-session path gated on admin or branch 'all' permission", async () => {
      withUploadDir();
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('log line one', {
              status: 200,
              headers: { 'content-type': 'text/plain' },
            })
        )
      );
      vi.mocked(getConnector).mockReturnValue({
        getFileInfo: vi.fn(async () => slackFileResult),
      } as any);
      vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
        fileDownloadEnabled as any
      );
      vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);
      vi.spyOn(BranchRepository.prototype, 'isOwner').mockResolvedValue(false);
      const permission = vi
        .spyOn(BranchRepository.prototype, 'resolveUserPermission')
        .mockResolvedValue('view' as any);

      const tools = await captureTools('member', makeFakeApp({}), null);
      await expect(
        tools.agor_gateway_slack_file_download.handler({
          gatewayChannelId: 'chan-1',
          fileId: 'F123',
        })
      ).rejects.toThrow("'all' branch permission");

      permission.mockResolvedValue('all' as any);
      await expect(
        tools.agor_gateway_slack_file_download.handler({
          gatewayChannelId: 'chan-1',
          fileId: 'F123',
        })
      ).rejects.toThrow('session-bound staging');
    });

    it('rejects a malformed fileId at the schema layer', async () => {
      const tools = await captureTools('member');
      const schema = tools.agor_gateway_slack_file_download.cfg.inputSchema;

      expect(schema.safeParse({ fileId: 'not-a-file-id' }).success).toBe(false);
      expect(schema.safeParse({ fileId: 'f0123abc456' }).success).toBe(false);
      expect(schema.safeParse({ fileId: 'C0123ABC456' }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ fileId: 'F0123ABC456' }).success).toBe(true);
      expect(getConnector).not.toHaveBeenCalled();
    });

    it('is not marked read-only — it writes into the daemon upload directory', async () => {
      const tools = await captureTools('member');
      expect(tools.agor_gateway_slack_file_download.cfg.annotations).toEqual({
        destructiveHint: false,
        idempotentHint: true,
      });
    });

    describe('allowed_channel_ids whitelist on file provenance', () => {
      const restrictedDownloadEnabled = {
        ...slackChannel,
        config: {
          ...slackChannel.config,
          agent_tools: { file_download: true },
          allowed_channel_ids: ['C123'],
        },
      };

      function setupRestrictedDownload(sourceConversationIds: string[]) {
        vi.mocked(getConnector).mockReturnValue({
          getFileInfo: vi.fn(async () => ({ file: slackFileInfo, sourceConversationIds })),
        } as any);
        spyCallerGatewaySession('branch-1', gatewaySource);
        vi.spyOn(GatewayChannelRepository.prototype, 'findById').mockResolvedValue(
          restrictedDownloadEnabled as any
        );
        vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue(branch as any);
      }

      it('denies a file whose only sources are non-whitelisted channels, without leaking them', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        setupRestrictedDownload(['C777', 'G888']);

        const tools = await captureTools('member');
        const error = await tools.agor_gateway_slack_file_download
          .handler({ fileId: 'F123' })
          .then(() => null)
          .catch((err: Error) => err);

        expect(error).toBeTruthy();
        expect(error!.message).toContain('allowed_channel_ids');
        expect(error!.message).not.toContain('C777');
        expect(error!.message).not.toContain('G888');
        expect(error!.message).not.toContain('error.log');
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('denies a file with no visible source conversations when a whitelist is configured', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        setupRestrictedDownload([]);

        const tools = await captureTools('member');
        await expect(
          tools.agor_gateway_slack_file_download.handler({ fileId: 'F123' })
        ).rejects.toThrow('allowed_channel_ids');
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('allows a file shared into a whitelisted channel', async () => {
        withUploadDir();
        vi.stubGlobal(
          'fetch',
          vi.fn(
            async () =>
              new Response('log line one', {
                status: 200,
                headers: { 'content-type': 'text/plain' },
              })
          )
        );
        setupRestrictedDownload(['C777', 'C123']);

        const tools = await captureTools('member');
        const result = await tools.agor_gateway_slack_file_download.handler({ fileId: 'F123' });
        const payload = JSON.parse(result.content[0].text);
        expect(payload.downloaded).toBe(true);
      });

      it('allows a file shared in a DM even with a whitelist configured', async () => {
        withUploadDir();
        vi.stubGlobal(
          'fetch',
          vi.fn(
            async () =>
              new Response('log line one', {
                status: 200,
                headers: { 'content-type': 'text/plain' },
              })
          )
        );
        setupRestrictedDownload(['D999']);

        const tools = await captureTools('member');
        const result = await tools.agor_gateway_slack_file_download.handler({ fileId: 'F123' });
        const payload = JSON.parse(result.content[0].text);
        expect(payload.downloaded).toBe(true);
      });
    });
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
    reactions,
    fileUpload,
    fileDownload,
    ...rest
  }: typeof dmOnly & {
    botDisplayName?: string;
    reactions?: boolean;
    fileUpload?: boolean;
    fileDownload?: boolean;
  }) {
    return {
      ...rest,
      agentTools: {
        thread_history: threadHistory,
        channel_history: channelHistory,
        reactions,
        file_upload: fileUpload,
        file_download: fileDownload,
      },
    };
  }

  it('marks the manifest generator read-only', async () => {
    const tools = await captureTools('admin');
    expect(tools.agor_gateway_slack_manifest_generate.cfg.annotations).toMatchObject({
      readOnlyHint: true,
    });
  });

  it('exposes a secret-free Discord setup guide', async () => {
    const tools = await captureTools('admin');
    expect(tools.agor_gateway_discord_setup.cfg.annotations).toMatchObject({
      readOnlyHint: true,
    });
    const result = await tools.agor_gateway_discord_setup.handler({
      applicationId: '111111111111111111',
      guildId: '222222222222222222',
      messageContentAcknowledged: true,
      allowedChannelIds: ['333333333333333333'],
      allowedUserIds: ['444444444444444444'],
      allowedRoleIds: [],
      agorUserId: '00000000-0000-4000-8000-000000000001',
      outbound: true,
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.config_hint).toEqual({
      application_id: '111111111111111111',
      guild_id: '222222222222222222',
      allowed_channel_ids: ['333333333333333333'],
      allowed_user_ids: ['444444444444444444'],
      allowed_role_ids: [],
      message_content_enabled: true,
      thread_mode: 'public_thread_per_summon',
      thread_auto_archive_minutes: 1440,
      align_discord_users: false,
      catch_up: {
        max_pages: 5,
        max_messages: 200,
        max_prompt_bytes: 32768,
        request_timeout_ms: 30000,
        rate_limit_max_retries: 2,
        rate_limit_max_total_delay_ms: 10000,
      },
      files: false,
      agent_tools: [],
      outbound_enabled: true,
      default_outbound_target: 'channel:333333333333333333',
    });
    expect(payload.validation).toEqual({ ok: true, errors: [] });
    expect(payload.setup_artifact.permissions.bitmask).toBe('309237713920');
    expect(payload.setup_artifact.botInviteUrl).toContain('permissions=309237713920');
    expect(payload.setup_artifact.draft.enabled).toBe(false);
    expect(payload.setup_artifact.draft.config.bot_token).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('bot_token');
  });

  it('keeps Discord setup and channel creation admin-only', async () => {
    const memberTools = await captureTools('member');
    await expect(
      memberTools.agor_gateway_discord_setup.handler({
        applicationId: '111111111111111111',
        guildId: '222222222222222222',
        messageContentAcknowledged: true,
        allowedChannelIds: ['333333333333333333'],
      })
    ).rejects.toThrow(/admin role required/);

    const createSchema = memberTools.agor_gateway_channels_create.cfg.inputSchema;
    expect(
      createSchema.safeParse({
        name: 'Discord beta',
        channelType: 'discord',
        targetBranchId: 'branch-1',
        agorUserId: 'user-1',
        enabled: false,
        config: {
          application_id: '111111111111111111',
          guild_id: '222222222222222222',
          allowed_channel_ids: ['333333333333333333'],
          allowed_user_ids: ['444444444444444444'],
          allowed_role_ids: [],
          message_content_enabled: true,
          thread_mode: 'public_thread_per_summon',
          align_discord_users: false,
        },
      }).success
    ).toBe(true);
    const setupSchema = memberTools.agor_gateway_discord_setup.cfg.inputSchema;
    expect(
      setupSchema.safeParse({
        applicationId: '111111111111111111',
        guildId: '222222222222222222',
        messageContentAcknowledged: true,
        allowedChannelIds: ['333333333333333333'],
        allowedUserIds: ['444444444444444444'],
      }).success
    ).toBe(false);
  });

  it('exposes bounded Discord catch-up settings without internal state', async () => {
    const tools = await captureTools('admin');
    const setupSchema = tools.agor_gateway_discord_setup.cfg.inputSchema;
    const base = {
      applicationId: '111111111111111111',
      guildId: '222222222222222222',
      messageContentAcknowledged: true,
      allowedChannelIds: ['333333333333333333'],
    };
    expect(setupSchema.safeParse({ ...base, catchUp: { maxPages: 11 } }).success).toBe(false);

    const result = await tools.agor_gateway_discord_setup.handler({
      ...base,
      catchUp: {
        maxPages: 10,
        maxMessages: 500,
        maxPromptBytes: 131072,
        requestTimeoutMs: 60000,
        rateLimitMaxRetries: 5,
        rateLimitMaxTotalDelayMs: 30000,
      },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.config_hint.catch_up).toEqual({
      max_pages: 10,
      max_messages: 500,
      max_prompt_bytes: 131072,
      request_timeout_ms: 60000,
      rate_limit_max_retries: 5,
      rate_limit_max_total_delay_ms: 30000,
    });
    expect(payload.config_hint).not.toHaveProperty('provider_installation_id');
    expect(payload.config_hint).not.toHaveProperty('listener_checkpoint');
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

  it('adds reactions:write scope and agent_tools config when reactions is enabled', async () => {
    const opts = { ...dmOnly, reactions: true };
    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_slack_manifest_generate.handler(opts);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.bot_scopes).toEqual(requiredBotScopes(wizardOptionsFor(opts)));
    expect(payload.bot_scopes).toEqual(expect.arrayContaining(['reactions:write']));
    expect(payload.create_channel_config_hint.config.agent_tools).toEqual({
      thread_history: true,
      channel_history: false,
      reactions: true,
    });
  });

  it('adds files:write scope and agent_tools config when fileUpload is enabled', async () => {
    const opts = { ...dmOnly, fileUpload: true };
    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_slack_manifest_generate.handler(opts);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.bot_scopes).toEqual(requiredBotScopes(wizardOptionsFor(opts)));
    expect(payload.bot_scopes).toEqual(expect.arrayContaining(['files:write']));
    expect(payload.create_channel_config_hint.config.agent_tools).toEqual({
      thread_history: true,
      channel_history: false,
      file_upload: true,
    });
  });

  it('adds files:read scope and agent_tools config when fileDownload is enabled', async () => {
    const opts = { ...dmOnly, fileDownload: true };
    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_slack_manifest_generate.handler(opts);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.bot_scopes).toEqual(requiredBotScopes(wizardOptionsFor(opts)));
    expect(payload.bot_scopes).toEqual(expect.arrayContaining(['files:read']));
    expect(payload.create_channel_config_hint.config.agent_tools).toEqual({
      thread_history: true,
      channel_history: false,
      file_download: true,
    });
  });

  it('omits files:read when fileDownload is off and no other capability forces it', async () => {
    const tools = await captureTools('admin');
    const result = await tools.agor_gateway_slack_manifest_generate.handler({
      ...dmOnly,
      fileDownload: false,
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.bot_scopes).not.toContain('files:read');
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
    // channel history/reactions/fileUpload/fileDownload require explicit opt-in.
    expect(parsed.threadHistory).toBe(true);
    expect(parsed.channelHistory).toBe(false);
    expect(parsed.reactions).toBe(false);
    expect(parsed.fileUpload).toBe(false);
    expect(parsed.fileDownload).toBe(false);

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
