import { BranchRepository, GatewayChannelRepository, SessionRepository } from '@agor/core/db';
import {
  type Branch,
  type BranchID,
  GATEWAY_REDACTED_SENTINEL,
  GATEWAY_SENSITIVE_CONFIG_FIELDS,
  type GatewayChannel,
  hasMinimumRole,
  ROLES,
  type ScheduleID,
  type UserID,
  type UUID,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GatewayService } from '../../services/gateway.js';
import { hasBranchPermission } from '../../utils/branch-authorization.js';
import {
  mcpLimit,
  mcpOptionalId,
  mcpOptionalNonEmptyString,
  mcpOptionalNonNegativeInt,
  mcpRequiredId,
  mcpRequiredString,
} from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

function requireAdmin(ctx: McpContext, action: string): void {
  if (!hasMinimumRole(ctx.authenticatedUser?.role, ROLES.ADMIN)) {
    throw new Error(`Access denied: admin role required to ${action}`);
  }
}

async function canUseGatewayOutbound(
  ctx: McpContext,
  branchRepo: BranchRepository,
  branch: Branch
): Promise<boolean> {
  if (hasMinimumRole(ctx.authenticatedUser?.role, ROLES.ADMIN)) return true;
  const userId = ctx.userId as UUID;
  const isOwner = await branchRepo.isOwner(branch.branch_id as BranchID, userId);
  const effective = await branchRepo.resolveUserPermission(branch, userId);
  return hasBranchPermission(
    branch,
    userId,
    isOwner,
    'all',
    ctx.authenticatedUser?.role,
    true,
    effective
  );
}

function getOutboundConfig(channel: GatewayChannel): {
  outbound_enabled: boolean;
  default_outbound_target?: string;
} {
  const config = channel.config ?? {};
  return {
    outbound_enabled: config.outbound_enabled === true,
    ...(typeof config.default_outbound_target === 'string' && config.default_outbound_target.trim()
      ? { default_outbound_target: config.default_outbound_target }
      : {}),
  };
}

const configSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'Platform-specific gateway configuration. Secrets are stored encrypted and returned redacted. Prefer env/template references for shared credentials where the connector supports them.'
  );

const outboundTargetSchema = z
  .string()
  .trim()
  .regex(
    /^(channel:[^:\s]+|channel_name:[^\s]+|#[^\s]+|(?:email:|user_email:)?[^@\s]+@[^@\s]+\.[^@\s]+)$/
  )
  .describe(
    'Slack outbound target for v0: channel:C123, #project-updates, channel_name:project-updates, or user@example.com. Thread targets are intentionally not supported.'
  );

const envVarSchema = z.strictObject({
  key: mcpRequiredString('agenticConfig.envVars[].key', 'Environment variable name'),
  value: mcpRequiredString(
    'agenticConfig.envVars[].value',
    `Environment variable value. Prefer references/templates over raw secrets. Existing redacted values may be passed as '${GATEWAY_REDACTED_SENTINEL}' on update to preserve them.`
  ),
  forceOverride: z
    .boolean()
    .optional()
    .describe('When true, channel value wins over user env vars. Defaults to false.'),
});

const agenticConfigSchema = z
  .strictObject({
    agent: z
      .enum(['claude-code', 'claude-code-cli', 'codex', 'gemini', 'opencode', 'copilot', 'cursor'])
      .describe('Agent used for sessions created from this gateway channel.'),
    permissionMode: z
      .enum([
        'default',
        'acceptEdits',
        'bypassPermissions',
        'plan',
        'dontAsk',
        'autoEdit',
        'yolo',
        'ask',
        'auto',
        'on-failure',
        'allow-all',
      ])
      .optional()
      .describe('Permission mode for spawned sessions.'),
    modelConfig: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Agent model configuration.'),
    mcpServerIds: z
      .array(z.string().min(1))
      .optional()
      .describe('MCP server IDs to attach to gateway-created sessions.'),
    codexSandboxMode: z
      .enum(['read-only', 'workspace-write', 'danger-full-access'])
      .optional()
      .describe('Codex sandbox mode for Codex gateway sessions.'),
    codexApprovalPolicy: z
      .enum(['untrusted', 'on-failure', 'on-request', 'never'])
      .optional()
      .describe('Codex approval policy for Codex gateway sessions.'),
    codexNetworkAccess: z.boolean().optional().describe('Allow Codex network access.'),
    envVars: z
      .array(envVarSchema)
      .optional()
      .describe('Gateway-level env vars. Values are redacted in responses.'),
  })
  .describe('Agent/session defaults for conversations created through this gateway channel.');

const gatewayChannelCreateSchema = z
  .strictObject({
    name: mcpRequiredString('name', 'Human-readable channel name, e.g. "Engineering Slack".'),
    channelType: z
      .enum(['slack', 'github', 'teams', 'discord', 'whatsapp', 'telegram'])
      .default('slack')
      .describe('Gateway platform type. Current active connectors are slack, github, and teams.'),
    targetBranchId: mcpRequiredId(
      'targetBranchId',
      'Branch',
      'Branch/worktree ID that this gateway channel prompts.'
    ),
    agorUserId: mcpOptionalId(
      'agorUserId',
      'User',
      'Agor user ID whose identity is used when platform-user alignment is disabled.'
    ),
    enabled: z.boolean().optional().describe('Whether the channel is active. Defaults to true.'),
    config: configSchema,
    agenticConfig: agenticConfigSchema.optional(),
  })
  .superRefine((value, issue) => {
    const config = value.config ?? {};
    if (value.channelType === 'slack') {
      if (!config.bot_token) {
        issue.addIssue({
          code: 'custom',
          path: ['config', 'bot_token'],
          message:
            'config.bot_token is required for Slack. Prefer a bot token stored outside the transcript when possible.',
        });
      }
      if (config.connection_mode === 'socket' && !config.app_token) {
        issue.addIssue({
          code: 'custom',
          path: ['config', 'app_token'],
          message: 'config.app_token is required for Slack Socket Mode.',
        });
      }
    }
    if (value.channelType === 'github') {
      for (const field of ['app_id', 'private_key', 'installation_id', 'watch_repos'] as const) {
        if (!config[field]) {
          issue.addIssue({
            code: 'custom',
            path: ['config', field],
            message: `config.${field} is required for GitHub gateway channels.`,
          });
        }
      }
    }
    if (value.channelType === 'teams') {
      for (const field of ['app_id', 'app_password'] as const) {
        if (!config[field]) {
          issue.addIssue({
            code: 'custom',
            path: ['config', field],
            message: `config.${field} is required for Teams gateway channels.`,
          });
        }
      }
    }
  });

const gatewayChannelUpdateSchema = z.strictObject({
  gatewayChannelId: mcpRequiredId(
    'gatewayChannelId',
    'Gateway channel',
    'Gateway channel ID (UUIDv7 or short ID)'
  ),
  name: mcpOptionalNonEmptyString('name', 'New human-readable channel name.'),
  channelType: z
    .enum(['slack', 'github', 'teams', 'discord', 'whatsapp', 'telegram'])
    .optional()
    .describe('Gateway platform type. Changing this should include compatible config.'),
  targetBranchId: mcpOptionalId('targetBranchId', 'Branch', 'New target branch/worktree ID.'),
  agorUserId: mcpOptionalId('agorUserId', 'User', 'New run-as Agor user ID.'),
  enabled: z.boolean().optional().describe('Enable/disable the channel.'),
  config: configSchema
    .optional()
    .describe(
      `Partial platform config to merge. Send '${GATEWAY_REDACTED_SENTINEL}' or omit sensitive fields to preserve existing secrets; send a new value to rotate.`
    ),
  agenticConfig: agenticConfigSchema
    .nullable()
    .optional()
    .describe('Replace agent/session defaults. null clears the gateway agentic config.'),
});

type GatewayChannelSummary = Omit<
  GatewayChannel,
  'channel_type' | 'target_branch_id' | 'agor_user_id' | 'agentic_config'
> & {
  channel_type: GatewayChannel['channel_type'];
  target_branch_id: string;
  agor_user_id: string;
  channel_key: typeof GATEWAY_REDACTED_SENTINEL;
  config: Record<string, unknown>;
  agentic_config: GatewayChannel['agentic_config'];
};

function redactGatewayChannel(channel: GatewayChannel): GatewayChannelSummary {
  const config = { ...(channel.config ?? {}) };
  for (const field of GATEWAY_SENSITIVE_CONFIG_FIELDS) {
    if (config[field]) config[field] = GATEWAY_REDACTED_SENTINEL;
  }

  let agentic_config = channel.agentic_config;
  if (agentic_config?.envVars) {
    agentic_config = {
      ...agentic_config,
      envVars: agentic_config.envVars.map((envVar) => ({
        ...envVar,
        value: GATEWAY_REDACTED_SENTINEL,
      })),
    };
  }

  return {
    ...channel,
    target_branch_id: channel.target_branch_id,
    agor_user_id: channel.agor_user_id,
    channel_key: GATEWAY_REDACTED_SENTINEL,
    config,
    agentic_config,
  };
}

function toServiceCreateData(args: z.infer<typeof gatewayChannelCreateSchema>) {
  return {
    name: args.name,
    channel_type: args.channelType,
    target_branch_id: args.targetBranchId,
    agor_user_id: args.agorUserId ?? '',
    enabled: args.enabled ?? true,
    config: args.config,
    agentic_config: args.agenticConfig
      ? {
          ...args.agenticConfig,
          envVars: args.agenticConfig.envVars?.map((envVar) => ({
            ...envVar,
            forceOverride: envVar.forceOverride ?? false,
          })),
        }
      : undefined,
  };
}

function toServiceUpdateData(args: z.infer<typeof gatewayChannelUpdateSchema>) {
  const updates: Partial<GatewayChannel> = {};
  if (args.name !== undefined) updates.name = args.name;
  if (args.channelType !== undefined) updates.channel_type = args.channelType;
  if (args.targetBranchId !== undefined) updates.target_branch_id = args.targetBranchId as never;
  if (args.agorUserId !== undefined) updates.agor_user_id = args.agorUserId as never;
  if (args.enabled !== undefined) updates.enabled = args.enabled;
  if (args.config !== undefined) updates.config = args.config;
  if (args.agenticConfig !== undefined) {
    updates.agentic_config = args.agenticConfig
      ? ({
          ...args.agenticConfig,
          envVars: args.agenticConfig.envVars?.map((envVar) => ({
            ...envVar,
            forceOverride: envVar.forceOverride ?? false,
          })),
        } as never)
      : null;
  }
  return updates;
}

export function registerGatewayChannelTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_gateway_channels_list',
    {
      description:
        'List gateway channel definitions (admin-only). Returns Slack/GitHub/Teams channel metadata with tokens, app passwords, private keys, webhook secrets, env var values, and inbound channel keys redacted. Use this to discover gatewayChannelId values for agor_gateway_channels_update.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        includeDisabled: z
          .boolean()
          .optional()
          .describe('Include disabled channels (default: true).'),
        channelType: z
          .enum(['slack', 'github', 'teams', 'discord', 'whatsapp', 'telegram'])
          .optional()
          .describe('Optional platform filter.'),
        limit: mcpLimit(100),
        skip: mcpOptionalNonNegativeInt('skip', 'Number of gateway channels to skip (default: 0)'),
      }),
    },
    async (args) => {
      requireAdmin(ctx, 'list gateway channels');
      const result = await ctx.app.service('gateway-channels').find({
        ...ctx.baseServiceParams,
        query: {
          ...(args.includeDisabled === false ? { enabled: true } : {}),
          ...(args.channelType ? { channel_type: args.channelType } : {}),
          $limit: args.limit ?? 100,
          $skip: args.skip ?? 0,
        },
      });
      const channels = (Array.isArray(result) ? result : result.data) as GatewayChannel[];
      const totalAvailable = Array.isArray(result) ? channels.length : result.total;

      return textResult({
        gateway_channels: channels.map(redactGatewayChannel),
        pagination: {
          total: totalAvailable,
          returned: channels.length,
          limit: args.limit ?? 100,
          skip: args.skip ?? 0,
        },
        summary: {
          returned: channels.length,
          enabled: channels.filter((channel) => channel.enabled).length,
          disabled: channels.filter((channel) => !channel.enabled).length,
        },
      });
    }
  );

  server.registerTool(
    'agor_gateway_channels_create',
    {
      description:
        'Create a gateway channel definition (admin-only) through the same gateway-channels service used by the UI. Current connectors: Slack, GitHub, Teams. Slack example config: { bot_token, app_token, connection_mode:"socket", enable_channels:true, require_mention:true, allowed_channel_ids:["C123"] }. Secrets are encrypted by the service and returned redacted; prefer environment/template references where possible because raw secrets in tool arguments may appear in the MCP transcript.',
      annotations: { destructiveHint: false, idempotentHint: false },
      inputSchema: gatewayChannelCreateSchema,
    },
    async (args) => {
      requireAdmin(ctx, 'create gateway channels');
      const created = (await ctx.app
        .service('gateway-channels')
        .create(toServiceCreateData(args), ctx.baseServiceParams)) as GatewayChannel;

      return textResult({
        gateway_channel: redactGatewayChannel(created),
        next_steps: [
          'Verify the channel in Settings > Gateway Channels or with agor_gateway_channels_list.',
          'Channel credentials, env vars, and inbound channel keys are intentionally redacted from MCP responses.',
        ],
      });
    }
  );

  server.registerTool(
    'agor_gateway_channels_update',
    {
      description: `Update a gateway channel definition (admin-only) through the gateway-channels service. Provide only fields to change. To preserve an existing secret in config or agenticConfig.envVars, omit it or pass '${GATEWAY_REDACTED_SENTINEL}'; to rotate it, pass a new value. Responses always redact secrets and channel_key.`,
      annotations: { destructiveHint: false, idempotentHint: false },
      inputSchema: gatewayChannelUpdateSchema,
    },
    async (args) => {
      requireAdmin(ctx, 'update gateway channels');
      const updated = (await ctx.app
        .service('gateway-channels')
        .patch(
          args.gatewayChannelId,
          toServiceUpdateData(args),
          ctx.baseServiceParams
        )) as GatewayChannel;

      return textResult({
        gateway_channel: redactGatewayChannel(updated),
        next_steps: ['Verify with agor_gateway_channels_list.'],
      });
    }
  );

  server.registerTool(
    'agor_gateway_outbound_targets_list',
    {
      description:
        'List Slack gateway outbound targets the caller can use. Returns only outbound-enabled channels where the caller has branch all permission or admin access. Secrets and inbound channel keys are never returned.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        branchId: mcpOptionalId('branchId', 'Branch', 'Filter by target branch ID.'),
        gatewayChannelId: mcpOptionalId(
          'gatewayChannelId',
          'Gateway channel',
          'Filter by gateway channel ID.'
        ),
        channelType: z.enum(['slack']).optional().describe('Only Slack is supported for v0.'),
      }),
    },
    async (args) => {
      const channelRepo = new GatewayChannelRepository(ctx.db);
      const branchRepo = new BranchRepository(ctx.db);
      const branchFilter = args.branchId ? await branchRepo.findById(args.branchId) : null;
      const branchFilterId = branchFilter?.branch_id;
      const allChannels = args.gatewayChannelId
        ? [await channelRepo.findById(args.gatewayChannelId)]
        : await channelRepo.findAll();

      const channels = [];
      for (const channel of allChannels) {
        if (!channel) continue;
        if (args.channelType && channel.channel_type !== args.channelType) continue;
        if (channel.channel_type !== 'slack') continue;
        if (args.branchId && channel.target_branch_id !== branchFilterId) continue;
        if (!channel.enabled) continue;
        const outbound = getOutboundConfig(channel);
        if (!outbound.outbound_enabled) continue;

        const branch = await branchRepo.findById(channel.target_branch_id);
        if (!branch) continue;
        if (!(await canUseGatewayOutbound(ctx, branchRepo, branch))) continue;

        channels.push({
          gateway_channel_id: channel.id,
          name: channel.name,
          channel_type: 'slack' as const,
          target_branch_id: channel.target_branch_id,
          target_branch_name: branch.name,
          outbound_enabled: outbound.outbound_enabled,
          ...(outbound.default_outbound_target
            ? { default_outbound_target: outbound.default_outbound_target }
            : {}),
          accepted_target_formats: [
            'channel:C123',
            '#project-updates',
            'channel_name:project-updates',
            'user@example.com',
          ],
        });
      }

      return textResult({ channels });
    }
  );

  server.registerTool(
    'agor_gateway_emit_message',
    {
      description:
        'Send a proactive Slack message through an outbound-enabled gateway channel and persist a seed/audit record. Targets may be Slack channel IDs, channel names, or user emails; v0 intentionally starts a fresh Slack thread/DM message for each emit and does not create a thread-session mapping until a human replies.',
      annotations: { destructiveHint: false, idempotentHint: false },
      inputSchema: z.strictObject({
        gatewayChannelId: mcpRequiredId(
          'gatewayChannelId',
          'Gateway channel',
          'Gateway channel ID (UUIDv7 or short ID).'
        ),
        message: mcpRequiredString('message', 'Message to send to Slack.'),
        target: outboundTargetSchema.optional().describe('Omit to use default_outbound_target.'),
        purpose: mcpOptionalNonEmptyString('purpose', 'Optional audit purpose.'),
      }),
    },
    async (args) => {
      const gatewayService = ctx.app.service('gateway') as unknown as GatewayService;
      let emittedByScheduleId: ScheduleID | undefined;
      if (ctx.sessionId) {
        try {
          const session = await new SessionRepository(ctx.db).findById(ctx.sessionId);
          emittedByScheduleId = session?.schedule_id;
        } catch {
          // Best-effort audit enrichment. A missing/stale session context should
          // not block an otherwise authorized outbound emit.
        }
      }
      const result = await gatewayService.emitMessage({
        gatewayChannelId: args.gatewayChannelId,
        message: args.message,
        ...(args.target ? { target: args.target } : {}),
        ...(args.purpose ? { purpose: args.purpose } : {}),
        emittedByUserId: ctx.userId as UserID,
        ...(ctx.sessionId ? { emittedBySessionId: ctx.sessionId } : {}),
        ...(emittedByScheduleId ? { emittedByScheduleId } : {}),
        userRole: ctx.authenticatedUser?.role,
      });
      return textResult(result);
    }
  );
}
