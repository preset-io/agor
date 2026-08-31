import { materializeAgenticToolConfiguration } from '@agor/agentic-tools/config';
import { getBaseUrl } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import {
  attachHiddenTenant,
  createTenantScopedDatabaseProxy,
  GatewayListenerDiscoveryRepository,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  shortId,
} from '@agor/core/db';
import { GatewayListenerError, getConnector } from '@agor/core/gateway';
import type {
  GatewayChannel,
  GatewayOutboundMessage,
  SessionID,
  SessionPromptAuthority,
  SessionSdkHomeScope,
  TeamsUserMap,
  ThreadSessionMap,
  User,
  UserID,
} from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestInboundAttachments } from '../utils/gateway-attachments.js';
import { GatewayService, tenantIdFromGatewayChannel } from './gateway.js';
import { withVerifiedHttpGatewayAuthority } from './gateway-authority.js';
import { SessionsService } from './sessions.js';

vi.mock('@agor/agentic-tools/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/agentic-tools/config')>();
  return {
    ...actual,
    materializeAgenticToolConfiguration: vi.fn(async () => ({
      agentic_tool_preset_id: null,
      permission_config: { mode: 'default' },
      model_config: null,
    })),
  };
});

vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return {
    ...actual,
    gatewayFailureCode: vi.fn(() => 'provider_request_failed'),
    getConnector: vi.fn(),
  };
});

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    assertInlineAgenticConfigurationAllowed: vi.fn(async () => undefined),
    getBaseUrl: vi.fn(async () => 'https://agor.example.com'),
    resolveExecutionSecurityMode: vi.fn(() => ({
      appRbacEnabled: true,
      unixUserMode: 'simple',
      requiresExecutionHomeKey: false,
    })),
  };
});

vi.mock('../utils/gateway-attachments.js', () => ({
  ingestInboundAttachments: vi.fn(),
  buildPromptWithAttachments: vi.fn(
    (text: string, attachments: Array<{ ref: string }>) =>
      `${text}\n\n${attachments.map((attachment) => attachment.ref).join('\n')}`
  ),
}));

const user: User = {
  user_id: 'user-1',
  email: 'user@example.com',
  name: 'Test User',
  role: 'admin',
  is_active: true,
  created_at: '2026-06-22T00:00:00.000Z',
  updated_at: '2026-06-22T00:00:00.000Z',
  last_login_at: null,
  avatar_url: null,
  default_agentic_config: {},
  unix_username: null,
} as unknown as User;

const slackChannel: GatewayChannel = {
  id: 'chan-slack',
  name: 'Slack Bot',
  channel_type: 'slack',
  channel_key: 'slack-key',
  enabled: true,
  target_branch_id: 'branch-1',
  agor_user_id: 'user-1',
  config: { bot_token: 'xoxb-test' },
  agentic_config: null,
  created_by: 'user-1',
  created_at: '2026-06-22T00:00:00.000Z',
  updated_at: '2026-06-22T00:00:00.000Z',
  last_message_at: null,
} as unknown as GatewayChannel;

function makeGuardedPostgresDatabase() {
  const transactions: Array<{
    execute: ReturnType<typeof vi.fn>;
    marker: ReturnType<typeof vi.fn>;
  }> = [];
  const base = {
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        // Tenant/system GUC setup and the tenant write-gate read both use
        // execute(). Empty rows mean no active write gate.
        execute: vi.fn(async () => []),
        marker: vi.fn(() => undefined),
      };
      transactions.push(tx);
      return work(tx);
    }),
    marker: vi.fn(() => undefined),
  };
  const db = createTenantScopedDatabaseProxy(base as never, {
    requireScope: true,
    label: 'guarded gateway test database',
  });
  const observations: Array<{ label: string; kind: string; tenantId?: string }> = [];
  const touch = (label: string) => {
    (db as unknown as { marker(): void }).marker();
    const scope = getCurrentTenantDatabaseScope();
    if (!scope) throw new Error(`Missing database scope while observing ${label}`);
    observations.push({
      label,
      kind: scope.kind,
      ...(scope.tenantId ? { tenantId: String(scope.tenantId) } : {}),
    });
  };
  return { db, observations, touch, transactions };
}

function makeMapping(overrides: Partial<ThreadSessionMap> = {}): ThreadSessionMap {
  return {
    id: 'map-1',
    channel_id: slackChannel.id,
    thread_id: 'C123-100.000000',
    session_id: 'sess-1',
    branch_id: slackChannel.target_branch_id,
    status: 'active',
    metadata: {
      slack_last_delivered_ts: '101.000000',
      slack_active_thread_id: 'C123-100.000000',
    },
    created_at: '2026-06-22T00:00:00.000Z',
    last_message_at: '2026-06-22T00:00:00.000Z',
    ...overrides,
  } as unknown as ThreadSessionMap;
}

function makeGatewayHarness(args: {
  channel?: GatewayChannel;
  existingMapping?: ThreadSessionMap | null;
  connector?: Record<string, unknown>;
  db?: TenantScopeAwareDatabase;
  user?: User;
  alignedUser?: User | null;
  branchPermission?: 'none' | 'view' | 'session' | 'prompt' | 'all';
  promptAuthority?: {
    allowed: boolean;
    execution_user_id?: UserID;
    source: SessionPromptAuthority['source'];
    denial_reason?: SessionPromptAuthority['denial_reason'];
  };
  sessionSdkHomeScope?: SessionSdkHomeScope;
  sessionOwnerUserId?: UserID;
  outboundSeed?: GatewayOutboundMessage | null;
  setMCPServers?: (sessionId: SessionID, serverIds: string[], label: string) => Promise<void>;
}) {
  const channel = args.channel ?? slackChannel;
  const executionUser = args.user ?? user;
  let mapping = args.existingMapping ?? null;
  const promptCreate = vi.fn(async () => ({
    task_id: 'task-1',
    session_id: mapping?.session_id ?? 'sess-new',
    status: 'running',
  }));
  const sessionsCreate = vi.fn(async () => ({
    session_id: 'sess-new',
    branch_id: channel.target_branch_id,
    status: SessionStatus.IDLE,
  }));
  const sessionsGet = vi.fn(async (sessionId: string) => ({
    session_id: sessionId,
    branch_id: channel.target_branch_id,
    created_by: executionUser.user_id,
    status: SessionStatus.IDLE,
    custom_context: { gateway_source: { channel_id: channel.id } },
  }));
  const setMCPServers = args.setMCPServers ?? vi.fn(async () => undefined);
  const app = {
    service: (name: string) => {
      if (name === 'users') return { get: vi.fn(async () => executionUser) };
      if (name === 'sessions') {
        return { create: sessionsCreate, get: sessionsGet, setMCPServers };
      }
      if (name === '/sessions/:id/prompt') return { create: promptCreate };
      throw new Error(`Unexpected service: ${name}`);
    },
  };
  const db = args.db ?? ({ run: vi.fn() } as unknown as TenantScopeAwareDatabase);
  const service = new GatewayService(db, app as never);
  // The shared harness models the standalone listener path. Tests exercising
  // PostgreSQL ownership opt in explicitly so connector selection never
  // depends on how a minimal database double happens to be detected.
  (service as unknown as { durableListenerOwnership: boolean }).durableListenerOwnership = false;
  const create = service.create.bind(service);
  service.create = (data) => {
    if (getCurrentTenantDatabaseScope()) return create(data);
    return runWithTenantDatabaseScope(db, 'tenant-channel', () => create(data));
  };
  const routeMessage = service.routeMessage.bind(service);
  service.routeMessage = (data) => {
    if (getCurrentTenantId()) return routeMessage(data);
    return runWithTenantContext('tenant-channel', () => routeMessage(data));
  };
  const handleMessageStreamingEvent = service.handleMessageStreamingEvent.bind(service);
  service.handleMessageStreamingEvent = (event, data) => {
    if (getCurrentTenantId()) return handleMessageStreamingEvent(event, data);
    return runWithTenantContext('tenant-channel', () => handleMessageStreamingEvent(event, data));
  };
  const channelRepo = {
    findByKey: vi.fn(async () => channel),
    findById: vi.fn(async () => channel),
    listenerClaimIsCurrent: vi.fn(async () => true),
    updateLastMessage: vi.fn(async () => undefined),
  };
  const resolveUserAccess = vi.fn(async () => ({
    can: args.branchPermission ?? 'all',
    fs_access: 'write',
    is_owner: (args.sessionOwnerUserId ?? executionUser.user_id) === executionUser.user_id,
    source: 'owner',
  }));
  const resolveSessionPromptAuthority = vi.fn(
    async () =>
      args.promptAuthority ?? {
        allowed: true,
        execution_user_id: args.sessionOwnerUserId ?? executionUser.user_id,
        source:
          args.sessionOwnerUserId && args.sessionOwnerUserId !== executionUser.user_id
            ? 'branch_session'
            : 'own_session',
      }
  );
  const branchRepo = {
    findById: vi.fn(async () => ({ branch_id: channel.target_branch_id })),
    resolveUserAccess,
    resolveSessionPromptAuthority,
  };
  const sessionRepo = {
    findById: vi.fn(async (sessionId: SessionID) => ({
      session_id: sessionId,
      branch_id: channel.target_branch_id,
      created_by: args.sessionOwnerUserId ?? executionUser.user_id,
      status: SessionStatus.IDLE,
      sdk_home_scope: args.sessionSdkHomeScope ?? 'execution_home',
    })),
  };
  const threadMapRepo = {
    findByChannelAndThread: vi.fn(async () => mapping),
    findByChannel: vi.fn(async () => []),
    findByThread: vi.fn(async () => null),
    findBySession: vi.fn(async () => mapping),
    updateLastMessage: vi.fn(async () => undefined),
    updateMetadata: vi.fn(async (_id: string, metadata: Record<string, unknown>) => {
      if (mapping) mapping = { ...mapping, metadata } as ThreadSessionMap;
    }),
    completeSeedInitialPrompt: vi.fn(
      async (_id: string, eventId: string | undefined, taskId: string) => {
        if (!mapping) return false;
        const metadata = (mapping.metadata as Record<string, unknown> | null) ?? {};
        const storedEventId = metadata.outbound_seed_initial_event_id;
        const matches =
          metadata.outbound_seed_initial_prompt_pending === true &&
          ((storedEventId === undefined && eventId === undefined) ||
            (typeof storedEventId === 'string' &&
              storedEventId.length > 0 &&
              typeof eventId === 'string' &&
              eventId.length > 0 &&
              storedEventId === eventId));
        if (!matches) return false;
        mapping = {
          ...mapping,
          metadata: {
            ...metadata,
            outbound_seed_initial_prompt_pending: false,
            outbound_seed_initial_task_id: taskId,
          },
        } as ThreadSessionMap;
        return true;
      }
    ),
    mergeGatewayReplyAliases: vi.fn(async (_id: string, aliases: string[]) => {
      if (mapping) {
        const current = (mapping.metadata as Record<string, unknown>) ?? {};
        const previous = Array.isArray(current.gateway_reply_aliases)
          ? current.gateway_reply_aliases.filter(
              (alias): alias is string => typeof alias === 'string'
            )
          : [];
        mapping = {
          ...mapping,
          metadata: {
            ...current,
            gateway_reply_aliases: [...new Set([...previous, ...aliases])],
          },
        } as ThreadSessionMap;
      }
      return mapping;
    }),
    mergeMetadata: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      if (mapping) {
        mapping = {
          ...mapping,
          metadata: { ...((mapping.metadata as Record<string, unknown>) ?? {}), ...patch },
        } as ThreadSessionMap;
      }
      return mapping;
    }),
    findById: vi.fn(async () => mapping),
    advanceDiscordLastAdmittedMessageId: vi.fn(async (_id: string, cursor: string) => {
      if (mapping)
        mapping = { ...mapping, discord_last_admitted_message_id: cursor } as ThreadSessionMap;
      return true;
    }),
    create: vi.fn(async (data: Partial<ThreadSessionMap>) => {
      mapping = makeMapping({
        ...data,
        id: 'map-new',
        session_id: data.session_id ?? 'sess-new',
        metadata: data.metadata ?? null,
      });
      return mapping;
    }),
  };
  const findByEmailForAlignment = vi.fn(async () => args.alignedUser ?? null);
  const findById = vi.fn(async () => args.alignedUser ?? null);
  const admitReplySession = vi.fn(async () =>
    args.outboundSeed
      ? {
          admitted: true,
          message: args.outboundSeed,
          sessionId: 'sess-new',
        }
      : null
  );
  const completeReplyAdmission = vi.fn(async () => args.outboundSeed ?? undefined);
  (service as unknown as { channelRepo: typeof channelRepo }).channelRepo = channelRepo;
  (service as unknown as { branchRepo: typeof branchRepo }).branchRepo = branchRepo;
  (service as unknown as { sessionRepo: typeof sessionRepo }).sessionRepo = sessionRepo;
  (service as unknown as { threadMapRepo: typeof threadMapRepo }).threadMapRepo = threadMapRepo;
  (
    service as unknown as {
      usersRepo: {
        findByEmailForAlignment: typeof findByEmailForAlignment;
        findById: typeof findById;
      };
    }
  ).usersRepo = { findByEmailForAlignment, findById };
  const outboundRepo = {
    admitReplySession,
    completeReplyAdmission,
  };
  (service as unknown as { outboundRepo: unknown }).outboundRepo = outboundRepo;
  (
    service as unknown as { activeListeners: Map<string, Record<string, unknown>> }
  ).activeListeners.set(`tenant-channel\0${channel.id}`, args.connector ?? {});
  (service as unknown as { activeChannelTenants: Set<string> }).activeChannelTenants.add(
    'tenant-channel'
  );

  return {
    service,
    createUnscoped: create,
    promptCreate,
    sessionsCreate,
    sessionsGet,
    setMCPServers,
    channelRepo,
    branchRepo,
    sessionRepo,
    resolveUserAccess,
    resolveSessionPromptAuthority,
    threadMapRepo,
    outboundRepo,
    findByEmailForAlignment,
    findById,
    admitReplySession,
    completeReplyAdmission,
  };
}

beforeEach(() => {
  // PostgreSQL-shaped database doubles exercise the same encrypted OAuth
  // repository construction as production and therefore need the deployment
  // master-secret invariant to be explicit.
  vi.stubEnv('AGOR_MASTER_SECRET', 'gateway-test-master-secret');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(materializeAgenticToolConfiguration).mockClear();
  vi.mocked(getBaseUrl).mockReset();
  vi.mocked(getBaseUrl).mockResolvedValue('https://agor.example.com');
  vi.mocked(getConnector).mockReset();
  vi.mocked(ingestInboundAttachments).mockReset();
});

describe('GatewayService session links', () => {
  it('builds browser-facing links from the configured UI origin', async () => {
    vi.mocked(getBaseUrl).mockResolvedValueOnce('http://localhost:5173');
    const { service } = makeGatewayHarness({});
    const sessionId = '01927f9d-0000-7000-8000-000000000001' as SessionID;

    const sessionUrl = await (
      service as unknown as {
        fetchExistingSessionUrlForGatewayUser: (
          sessionId: SessionID,
          user: User
        ) => Promise<string | null>;
      }
    ).fetchExistingSessionUrlForGatewayUser(sessionId, user);

    expect(sessionUrl).toBe(`http://localhost:5173/ui/s/${shortId(sessionId)}/`);
  });

  it('does not expose a 0.0.0.0 gateway link', async () => {
    vi.mocked(getBaseUrl).mockResolvedValueOnce('http://0.0.0.0:5173');
    const { service } = makeGatewayHarness({});

    const sessionUrl = await (
      service as unknown as {
        fetchExistingSessionUrlForGatewayUser: (
          sessionId: SessionID,
          user: User
        ) => Promise<string | null>;
      }
    ).fetchExistingSessionUrlForGatewayUser(
      '01927f9d-0000-7000-8000-000000000001' as SessionID,
      user
    );

    expect(sessionUrl).toBeNull();
  });
});

describe('gateway tenant metadata helpers', () => {
  it('extracts non-enumerable tenant metadata from gateway channel DTOs', () => {
    const channel = attachHiddenTenant({ ...slackChannel }, { tenant_id: 'tenant-channel' });

    expect(tenantIdFromGatewayChannel(channel)).toBe('tenant-channel');
    expect(Object.keys(channel)).not.toContain('tenant_id');
  });
});

describe('GatewayService inbound permission admission', () => {
  it('does not create a gateway session after the execution user loses Collaborator access', async () => {
    const { service, sessionsCreate, promptCreate, resolveUserAccess } = makeGatewayHarness({
      existingMapping: null,
      branchPermission: 'view',
    });

    await expect(
      service.create({
        channel_key: 'slack-key',
        thread_id: 'C123-100.000000',
        text: 'start a session',
        metadata: {
          channel: 'C123',
          channel_type: 'channel',
          slack_has_mention: true,
          slack_message_ts: '100.000000',
        },
      })
    ).rejects.toThrow(/Collaborator access is required to create a session/);

    expect(resolveUserAccess).toHaveBeenCalledOnce();
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(promptCreate).not.toHaveBeenCalled();
  });

  it('surfaces a mapped execution-home denial without retrying the gateway event', async () => {
    const sessionOwnerUserId = 'session-owner' as UserID;
    const sendMessage = vi.fn(async () => undefined);
    const { service, promptCreate, resolveSessionPromptAuthority } = makeGatewayHarness({
      existingMapping: makeMapping(),
      sessionOwnerUserId,
      connector: { sendMessage },
      promptAuthority: {
        allowed: false,
        source: 'denied',
        denial_reason: 'execution_home_sharing_disabled',
      },
    });

    await expect(
      service.create({
        channel_key: 'slack-key',
        thread_id: 'C123-100.000000',
        text: 'continue',
        metadata: {
          channel: 'C123',
          channel_type: 'channel',
          slack_has_mention: true,
          slack_message_ts: '103.000000',
        },
      })
    ).resolves.toEqual({ success: false, sessionId: '', created: false });

    expect(resolveSessionPromptAuthority).toHaveBeenCalledWith(
      slackChannel.target_branch_id,
      user.user_id,
      sessionOwnerUserId,
      'execution_home'
    );
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringMatching(/uses its owner's execution home/i),
        })
      )
    );
    expect(promptCreate).not.toHaveBeenCalled();
  });

  it('allows a foreign collaborator to prompt a branch-scoped mapped session', async () => {
    const sessionOwnerUserId = 'session-owner' as UserID;
    const { service, promptCreate, resolveSessionPromptAuthority } = makeGatewayHarness({
      existingMapping: makeMapping(),
      sessionOwnerUserId,
      sessionSdkHomeScope: 'branch',
      promptAuthority: {
        allowed: true,
        execution_user_id: user.user_id,
        source: 'branch_session',
      },
    });

    await expect(
      service.create({
        channel_key: 'slack-key',
        thread_id: 'C123-100.000000',
        text: 'continue',
        metadata: {
          channel: 'C123',
          channel_type: 'channel',
          slack_has_mention: true,
          slack_message_ts: '103.000000',
        },
      })
    ).resolves.toMatchObject({ success: true, sessionId: 'sess-1', created: false });

    expect(resolveSessionPromptAuthority).toHaveBeenCalledWith(
      slackChannel.target_branch_id,
      user.user_id,
      sessionOwnerUserId,
      'branch'
    );
    expect(promptCreate).toHaveBeenCalledOnce();
  });

  it('edits a GitHub processing acknowledgement with the execution-home denial', async () => {
    const githubChannel = {
      ...slackChannel,
      id: 'chan-github-denial',
      channel_type: 'github',
      channel_key: 'github-denial-key',
      config: {},
    } as GatewayChannel;
    const sendMessage = vi.fn(async () => undefined);
    const { service, promptCreate } = makeGatewayHarness({
      channel: githubChannel,
      existingMapping: makeMapping(),
      sessionOwnerUserId: 'session-owner' as UserID,
      connector: { sendMessage },
      promptAuthority: {
        allowed: false,
        source: 'denied',
        denial_reason: 'execution_home_sharing_disabled',
      },
    });

    await expect(
      service.create({
        channel_key: githubChannel.channel_key,
        thread_id: 'preset-io/agor#2587',
        text: '@agor continue',
        metadata: { processing_comment_id: 42 },
      })
    ).resolves.toEqual({ success: false, sessionId: '', created: false });

    expect(sendMessage).toHaveBeenCalledWith({
      threadId: 'preset-io/agor#2587',
      text: expect.stringMatching(/uses its owner's execution home/i),
      metadata: { edit_comment_id: 42 },
    });
    expect(promptCreate).not.toHaveBeenCalled();
  });
});

describe('GatewayService user alignment operational logs', () => {
  const sensitive = {
    email: 'hostile-email-sentinel@example.test',
    mappedEmail: 'hostile-mapped-email-sentinel@example.test',
    externalId: 'hostile-external-id-sentinel',
    name: 'hostile-name-sentinel',
    slackUsername: 'hostile-slack-username-sentinel',
    threadId: 'hostile-thread-id-sentinel',
  };
  const alignedUser = {
    ...user,
    user_id: '019fd900-0000-7000-8000-000000000001' as UserID,
    email: sensitive.email,
    name: sensitive.name,
  } as User;

  function resolveAlignedUser(service: GatewayService) {
    return service as unknown as {
      resolveAlignedUser(opts: {
        platform: string;
        externalId: string | undefined;
        email: unknown;
        userMap: Record<string, string> | undefined;
      }): Promise<User | null>;
    };
  }

  async function createAlignedMessage(
    platform: 'Slack' | 'GitHub' | 'Shortcut',
    matchedUser: User | null = null,
    includeEmail = true
  ) {
    const channelType = platform.toLowerCase() as 'slack' | 'github' | 'shortcut';
    const channel = {
      ...slackChannel,
      channel_type: channelType,
      agor_user_id: null,
      config: { [`align_${channelType}_users`]: true },
    } as unknown as GatewayChannel;
    const sendMessage = vi.fn(async () => 'sent');
    if (channelType !== 'slack') {
      vi.mocked(getConnector).mockReturnValue({ sendMessage } as never);
    }
    const { service } = makeGatewayHarness({
      channel,
      alignedUser: matchedUser,
      connector: { sendMessage },
    });
    const metadata: Record<string, unknown> = {
      ...(channelType === 'slack' ? { channel_type: 'im' } : { processing_comment_id: 42 }),
      ...(channelType === 'slack' ? {} : { [`${channelType}_user`]: sensitive.externalId }),
      ...(includeEmail ? { [`${channelType}_user_email`]: sensitive.email } : {}),
    };
    const result = await service.create({
      channel_key: channel.channel_key,
      thread_id: sensitive.threadId,
      text: 'hello',
      user_name: sensitive.slackUsername,
      metadata,
    });

    return { result, sendMessage };
  }

  function expectNoSensitiveValues(...spies: Array<{ mock: { calls: unknown[][] } }>): void {
    const output = spies
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .join(' ');
    for (const value of Object.values(sensitive)) {
      expect(output).not.toContain(value);
    }
  }

  it('resolves Teams AAD mappings by tenant-scoped immutable User ID, never email', async () => {
    const { service, findById, findByEmailForAlignment } = makeGatewayHarness({ alignedUser });
    const resolveTeamsUser = service as unknown as {
      resolveTeamsUser(opts: {
        aadObjectId: string | undefined;
        userMap: TeamsUserMap | undefined;
      }): Promise<User | null>;
    };

    await expect(
      resolveTeamsUser.resolveTeamsUser({
        aadObjectId: 'aad-object-1',
        userMap: { 'aad-object-1': alignedUser.user_id },
      })
    ).resolves.toBe(alignedUser);
    expect(findById).toHaveBeenCalledWith(alignedUser.user_id);
    expect(findByEmailForAlignment).not.toHaveBeenCalled();

    for (const invalidUserId of [
      'user@example.com',
      'not-a-uuid',
      '01933e4a',
      '01933e4a-7b89-4c35-a8f3-9d2e1c4b5a6f',
      '01933E4A-7B89-7C35-A8F3-9D2E1C4B5A6F',
    ]) {
      findById.mockClear();
      await expect(
        resolveTeamsUser.resolveTeamsUser({
          aadObjectId: 'aad-object-1',
          userMap: { 'aad-object-1': invalidUserId } as unknown as TeamsUserMap,
        })
      ).resolves.toBeNull();
      expect(findById).not.toHaveBeenCalled();
    }
  });

  it('logs exact user_map and email-fallback outcomes without external identities', async () => {
    const { service, findByEmailForAlignment } = makeGatewayHarness({ alignedUser });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const userMapMatched = await resolveAlignedUser(service).resolveAlignedUser({
      platform: 'GitHub',
      externalId: sensitive.externalId,
      email: undefined,
      userMap: { [sensitive.externalId]: sensitive.mappedEmail },
    });
    findByEmailForAlignment.mockResolvedValueOnce(null).mockResolvedValueOnce(alignedUser);
    const emailMatched = await resolveAlignedUser(service).resolveAlignedUser({
      platform: 'Shortcut',
      externalId: sensitive.externalId,
      email: sensitive.email,
      userMap: { [sensitive.externalId]: sensitive.mappedEmail },
    });

    expect([userMapMatched, emailMatched]).toEqual([alignedUser, alignedUser]);
    expect(log.mock.calls).toEqual([
      [
        `[gateway] GitHub user alignment succeeded: source=user_map agor_user=${shortId(alignedUser.user_id)}`,
      ],
      [
        `[gateway] Shortcut user alignment succeeded: source=email agor_user=${shortId(alignedUser.user_id)}`,
      ],
    ]);
    expect(warn.mock.calls).toEqual([
      ['[gateway] Shortcut user alignment failed: source=user_map result=agor_user_not_found'],
    ]);
    expectNoSensitiveValues(log, warn);
  });

  it('logs a Slack alignment success without email, name, username, or thread identity', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { result } = await createAlignedMessage('Slack', alignedUser);

    expect(result).toMatchObject({ success: true, created: true });
    expect(log).toHaveBeenCalledWith(
      `[gateway] Slack user alignment succeeded: agor_user=${shortId(alignedUser.user_id)}`
    );
    expectNoSensitiveValues(log);
  });

  it.each([
    ['Slack', true, sensitive.email],
    ['Slack', false, null],
    ['GitHub', true, `@${sensitive.externalId}`],
    ['Shortcut', true, null],
  ] as const)(
    '$0 rejection (identity email available: $1)',
    async (platform, includeEmail, expectedContent) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const { result, sendMessage } = await createAlignedMessage(platform, null, includeEmail);

      expect(result).toEqual({ success: false, sessionId: '', created: false });
      expect(log.mock.calls).toEqual([
        [
          `[gateway] ${platform} user alignment failed: result=${includeEmail ? 'agor_user_not_found' : 'identity_email_unavailable'}`,
        ],
      ]);
      expectNoSensitiveValues(log);
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: sensitive.threadId,
          ...(expectedContent ? { text: expect.stringContaining(expectedContent) } : {}),
        })
      );
    }
  );
});

describe('GatewayService multi-tenant process state', () => {
  it.each([
    ['anonymous', { provider: 'rest' }, null],
    [
      'same-tenant unauthorized',
      { provider: 'rest', user: { ...user, role: 'member' } },
      {
        session_id: 'sess-1',
        branch_id: 'branch-1',
        created_by: 'other-user',
      },
    ],
    [
      'superadmin with bypass disabled',
      { provider: 'rest', user: { ...user, role: 'superadmin' } },
      {
        session_id: 'sess-1',
        branch_id: 'branch-1',
        created_by: 'other-user',
      },
    ],
    ['cross-tenant', { provider: 'rest', user: { ...user, role: 'member' } }, null],
  ])(
    'denies transported routeMessage for %s with zero provider activity',
    async (_name, params, session) => {
      const sendMessage = vi.fn();
      const service = new GatewayService(
        { run: vi.fn() } as never,
        {
          service: vi.fn(),
          get: vi.fn(() => ({ execution: { allow_superadmin: false } })),
        } as never
      );
      Object.assign(service as unknown as Record<string, unknown>, {
        sessionRepo: { findById: vi.fn(async () => session) },
        branchRepo: {
          findById: vi.fn(async () => ({
            branch_id: 'branch-1',
            created_by: 'other-user',
            others_can: 'view',
          })),
          isOwner: vi.fn(async () => false),
          resolveUserPermission: vi.fn(async () => 'view'),
        },
        threadMapRepo: { findBySession: vi.fn() },
        channelRepo: { findById: vi.fn() },
      });
      vi.mocked(getConnector).mockReturnValue({ sendMessage, channelType: 'slack' });

      await expect(
        service.routeMessage(
          { session_id: 'sess-1', message: 'CANARY_OUTBOUND_MUST_NOT_SEND' },
          params as never
        )
      ).rejects.toThrow();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(
        (service as unknown as { threadMapRepo: { findBySession: ReturnType<typeof vi.fn> } })
          .threadMapRepo.findBySession
      ).not.toHaveBeenCalled();
    }
  );

  it('does not use the local listener cache as PostgreSQL outbound authority', async () => {
    const sendMessage = vi.fn(async () => 'sent-1');
    const service = new GatewayService({ run: vi.fn() } as never, { service: vi.fn() } as never);
    const channel = attachHiddenTenant({ ...slackChannel }, { tenant_id: 'tenant-a' });
    const mapping = makeMapping({ channel_id: channel.id });
    Object.assign(service as unknown as Record<string, unknown>, {
      durableListenerOwnership: true,
      channelRepo: {
        findById: vi.fn(async () => channel),
        updateLastMessage: vi.fn(async () => undefined),
      },
      threadMapRepo: {
        findBySession: vi.fn(async () => mapping),
        updateLastMessage: vi.fn(async () => undefined),
        findById: vi.fn(async () => mapping),
        updateMetadata: vi.fn(async () => undefined),
      },
    });
    vi.mocked(getConnector).mockReturnValue({ sendMessage, channelType: 'slack' });

    const result = await runWithTenantContext('tenant-a', () =>
      service.routeMessage({ session_id: mapping.session_id, message: 'from another daemon' })
    );

    expect(result).toEqual({ routed: true, channelType: 'slack' });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("does not let one tenant's empty channel set suppress another tenant's delivery", async () => {
    const sendMessage = vi.fn(async () => 'sent-1');
    const service = new GatewayService({ run: vi.fn() } as never, { service: vi.fn() } as never);
    const tenantAChannel = attachHiddenTenant(
      { ...slackChannel, id: 'shared-looking-channel' as never },
      { tenant_id: 'tenant-a' }
    );
    const mapping = makeMapping({ channel_id: tenantAChannel.id });
    const channelRepo = {
      findAll: vi.fn(async () => (getCurrentTenantId() === 'tenant-a' ? [tenantAChannel] : [])),
      findById: vi.fn(async () => tenantAChannel),
      updateLastMessage: vi.fn(async () => undefined),
    };
    const threadMapRepo = {
      findBySession: vi.fn(async () => mapping),
      updateLastMessage: vi.fn(async () => undefined),
      findById: vi.fn(async () => mapping),
      updateMetadata: vi.fn(async () => undefined),
    };
    (service as unknown as { channelRepo: typeof channelRepo }).channelRepo = channelRepo;
    (service as unknown as { threadMapRepo: typeof threadMapRepo }).threadMapRepo = threadMapRepo;
    (
      service as unknown as { activeListeners: Map<string, Record<string, unknown>> }
    ).activeListeners.set('tenant-a\0shared-looking-channel', { sendMessage });

    await runWithTenantContext('tenant-a', () => service.refreshChannelState());
    await runWithTenantContext('tenant-b', () => service.refreshChannelState());

    const crossTenant = await runWithTenantContext('tenant-b', () =>
      service.routeMessage({ session_id: 'sess-1', message: 'wrong tenant' })
    );
    expect(crossTenant).toEqual({ routed: false });
    expect(sendMessage).not.toHaveBeenCalled();

    const result = await runWithTenantContext('tenant-a', () =>
      service.routeMessage({ session_id: 'sess-1', message: 'hello tenant A' })
    );

    expect(result).toEqual({ routed: true, channelType: 'slack' });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(
      (service as unknown as { activeChannelTenants: Set<string> }).activeChannelTenants
    ).toEqual(new Set(['tenant-a']));
  });

  it('discovers and starts same-looking channel IDs independently in two tenant contexts', async () => {
    const db = { run: vi.fn() } as never;
    const service = new GatewayService(db, { service: vi.fn() } as never);
    const callbacks: Array<(message: { threadId: string; text: string; userId: string }) => void> =
      [];
    const startedInTenants: Array<string | undefined> = [];
    const handledInTenants: Array<string | undefined> = [];
    const findEnabledTenantRefs = vi
      .spyOn(GatewayListenerDiscoveryRepository.prototype, 'findEnabledTenantRefs')
      .mockResolvedValue([
        { channel_id: 'same-channel' as never, tenant_id: 'tenant-a' },
        { channel_id: 'same-channel' as never, tenant_id: 'tenant-b' },
      ]);
    const channelRepo = {
      findById: vi.fn(async () =>
        attachHiddenTenant(
          {
            ...slackChannel,
            id: 'same-channel' as never,
            channel_key: `${getCurrentTenantId()}-key`,
            config: { bot_token: 'xoxb-test', app_token: 'xapp-test' },
          },
          { tenant_id: getCurrentTenantId() }
        )
      ),
    };
    (service as unknown as { channelRepo: typeof channelRepo }).channelRepo = channelRepo;
    vi.spyOn(service, 'create').mockImplementation(async () => {
      handledInTenants.push(getCurrentTenantId());
      return { success: true, sessionId: 'sess-1', created: false };
    });
    vi.mocked(getConnector).mockImplementation(() => ({
      startListening: vi.fn(async (callback) => {
        startedInTenants.push(getCurrentTenantId());
        callbacks.push(callback);
      }),
      sendMessage: vi.fn(async () => 'sent'),
    }));

    try {
      await service.startListenersAcrossTenants();

      expect(startedInTenants).toEqual(['tenant-a', 'tenant-b']);
      expect(channelRepo.findById.mock.calls).toHaveLength(2);
      expect([
        ...(service as unknown as { activeListeners: Map<string, unknown> }).activeListeners.keys(),
      ]).toEqual(['tenant-a\0same-channel', 'tenant-b\0same-channel']);

      callbacks[0]({ threadId: 'thread-a', text: 'a', userId: 'user-a' });
      callbacks[1]({ threadId: 'thread-b', text: 'b', userId: 'user-b' });
      await vi.waitFor(() => expect(handledInTenants).toEqual(['tenant-a', 'tenant-b']));
    } finally {
      findEnabledTenantRefs.mockRestore();
    }
  });

  it('starts static-tenant listeners and refreshes the fast path with one channel scan', async () => {
    const service = new GatewayService({ run: vi.fn() } as never, { service: vi.fn() } as never);
    const channel = attachHiddenTenant(
      {
        ...slackChannel,
        id: 'static-channel' as never,
        config: { bot_token: 'xoxb-test', app_token: 'xapp-test' },
      },
      { tenant_id: 'static-tenant' }
    );
    const channelRepo = { findAll: vi.fn(async () => [channel]) };
    (service as unknown as { channelRepo: typeof channelRepo }).channelRepo = channelRepo;
    const startListening = vi.fn(async () => undefined);
    vi.mocked(getConnector).mockReturnValue({
      startListening,
      sendMessage: vi.fn(async () => 'sent'),
    });

    await runWithTenantContext('static-tenant', () => service.startListeners());

    expect(channelRepo.findAll).toHaveBeenCalledOnce();
    expect(startListening).toHaveBeenCalledOnce();
    expect(
      (service as unknown as { activeChannelTenants: Set<string> }).activeChannelTenants
    ).toEqual(new Set(['static-tenant']));
    expect([
      ...(service as unknown as { activeListeners: Map<string, unknown> }).activeListeners.keys(),
    ]).toEqual(['static-tenant\0static-channel']);
  });

  it('fails closed on a discovered tenant mismatch while continuing other tenants', async () => {
    const service = new GatewayService({ run: vi.fn() } as never, { service: vi.fn() } as never);
    const findEnabledTenantRefs = vi
      .spyOn(GatewayListenerDiscoveryRepository.prototype, 'findEnabledTenantRefs')
      .mockResolvedValue([
        { channel_id: 'forged-channel' as never, tenant_id: 'tenant-a' },
        { channel_id: 'valid-channel' as never, tenant_id: 'tenant-b' },
      ]);
    const channelRepo = {
      findById: vi.fn(async (channelId: string) =>
        attachHiddenTenant(
          {
            ...slackChannel,
            id: channelId as never,
            config: { bot_token: 'xoxb-test', app_token: 'xapp-test' },
          },
          { tenant_id: channelId === 'forged-channel' ? 'tenant-x' : 'tenant-b' }
        )
      ),
    };
    (service as unknown as { channelRepo: typeof channelRepo }).channelRepo = channelRepo;
    const startListening = vi.fn(async () => undefined);
    vi.mocked(getConnector).mockReturnValue({
      startListening,
      sendMessage: vi.fn(async () => 'sent'),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await service.startListenersAcrossTenants();

      expect(startListening).toHaveBeenCalledOnce();
      expect([
        ...(service as unknown as { activeListeners: Map<string, unknown> }).activeListeners.keys(),
      ]).toEqual(['tenant-b\0valid-channel']);
      expect(error.mock.calls.flat().join(' ')).toMatch(/tenant mismatch/i);
    } finally {
      error.mockRestore();
      findEnabledTenantRefs.mockRestore();
    }
  });
});

describe('GatewayService Slack thread catch-up', () => {
  it('runs listener inbound callbacks inside a fresh channel tenant DB scope', async () => {
    const seenTenants: Array<string | undefined> = [];
    const app = {
      service: vi.fn(),
    };
    const service = new GatewayService({ run: vi.fn() } as never, app as never);
    vi.spyOn(service, 'create').mockImplementation(async () => {
      seenTenants.push(getCurrentTenantId() as string | undefined);
      return { success: true, sessionId: 'sess-1', created: false };
    });

    const channel = {
      ...slackChannel,
      tenant_id: 'tenant-channel',
    } as GatewayChannel & { tenant_id: string };

    await (
      service as unknown as {
        handleListenerInboundMessage(
          channel: GatewayChannel,
          tenantId: string | undefined,
          msg: {
            threadId: string;
            text: string;
            userId: string;
            metadata?: Record<string, unknown>;
          }
        ): Promise<void>;
      }
    ).handleListenerInboundMessage(channel, channel.tenant_id, {
      threadId: 'C123-100.000000',
      text: 'hello',
      userId: 'U123',
    });

    expect(seenTenants).toEqual(['tenant-channel']);
  });

  it('passes ambient tenant context into the internal prompt call', async () => {
    const mapping = makeMapping();
    const { service, promptCreate } = makeGatewayHarness({
      existingMapping: mapping,
      connector: {},
    });

    await runWithTenantDatabaseScope({ run: vi.fn() } as never, 'tenant-channel', () =>
      service.create({
        channel_key: 'slack-key',
        thread_id: 'C123-100.000000',
        text: 'please answer',
        metadata: {
          channel: 'C123',
          channel_type: 'channel',
          slack_has_mention: true,
          slack_message_ts: '103.000000',
        },
      })
    );

    expect(promptCreate.mock.calls[0][1]).toMatchObject({
      route: { id: 'sess-1' },
      tenant: { tenant_id: 'tenant-channel', source: 'explicit' },
    });
  });

  it('fetches missed Slack messages after the last delivered cursor and advances the cursor', async () => {
    const sendMessage = vi.fn(async () => '104.000000');
    const fetchThreadHistory = vi.fn(async () => ({
      threadId: 'C123-100.000000',
      channel: 'C123',
      thread_ts: '100.000000',
      has_more: false,
      messages: [
        {
          ts: '101.000000',
          iso_time: '2026-06-22T00:00:01.000Z',
          actor_label: 'Alice',
          text: 'already seen',
          is_bot: false,
          is_trigger: false,
        },
        {
          ts: '102.000000',
          iso_time: '2026-06-22T00:00:02.000Z',
          actor_label: 'Bob',
          text: 'missed context',
          is_bot: false,
          is_trigger: false,
        },
        {
          ts: '103.000000',
          iso_time: '2026-06-22T00:00:03.000Z',
          actor_label: 'Alice',
          text: '<@U_BOT> please answer',
          is_bot: false,
          is_trigger: true,
        },
      ],
    }));
    const mapping = makeMapping({
      thread_id: 'C123-100.000000',
      metadata: {
        slack_last_delivered_ts: '101.000000',
        slack_active_thread_id: 'C123-200.000000',
      },
    });
    const { service, promptCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { fetchThreadHistory, sendMessage },
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-200.000000',
      text: 'please answer',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '103.000000',
        slack_thread_ts: '100.000000',
        slack_user_name: 'Alice',
        slack_channel_name: 'eng',
      },
    });

    expect(result).toMatchObject({ success: true, sessionId: 'sess-1', created: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(fetchThreadHistory).toHaveBeenCalledWith({
      threadId: 'C123-100.000000',
      oldestTs: '101.000000',
      latestTs: '103.000000',
      inclusive: true,
      limit: 200,
      includeBotMessages: false,
      triggerTs: '103.000000',
    });
    const prompt = promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain(
      'Any assistant message you send in this current Agor session is streamed back directly to the Slack conversation'
    );
    expect(prompt).toContain('**Slack context**');
    expect(prompt).toContain('### Previous thread messages');
    expect(prompt).toContain('missed context');
    expect(prompt).toContain('please answer');
    expect(prompt).toContain('2026-06-22 00:00:02 UTC');
    expect(prompt).not.toContain('already seen');
    expect(prompt).not.toContain('## Slack thread context');
    expect(threadMapRepo.updateMetadata).toHaveBeenLastCalledWith(
      'map-1',
      expect.objectContaining({
        slack_last_delivered_ts: '103.000000',
        slack_last_summon_ts: '103.000000',
      })
    );
  });

  it('does not advance the Slack delivered cursor when catch-up history fetch fails', async () => {
    const fetchThreadHistory = vi.fn(async () => {
      throw new Error('slack unavailable');
    });
    const mapping = makeMapping({
      thread_id: 'C123-100.000000',
      metadata: {
        slack_last_delivered_ts: '101.000000',
        slack_active_thread_id: 'C123-200.000000',
      },
    });
    const { service, promptCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { fetchThreadHistory },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-200.000000',
      text: 'please answer',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '103.000000',
        slack_thread_ts: '100.000000',
      },
    });

    expect(result).toMatchObject({ success: true, sessionId: 'sess-1', created: false });
    expect(promptCreate.mock.calls[0][0].prompt).toContain(
      'Any assistant message you send in this current Agor session is streamed back directly to the Slack conversation'
    );
    expect(promptCreate.mock.calls[0][0].prompt).toContain('please answer');
    expect(threadMapRepo.updateMetadata).not.toHaveBeenCalledWith(
      'map-1',
      expect.objectContaining({
        slack_last_delivered_ts: '103.000000',
      })
    );
    expect(warn).toHaveBeenCalledWith('[gateway] Failed to fetch Slack thread catch-up context');
    warn.mockRestore();
  });

  it('does not reserve a Slack thread globally across gateway channels', async () => {
    const sendMessage = vi.fn(async () => '100.000001');
    const fetchThreadHistory = vi.fn(async () => ({
      threadId: 'C123-100.000000',
      channel: 'C123',
      thread_ts: '100.000000',
      messages: [
        {
          ts: '100.000000',
          iso_time: '2026-06-22T00:00:00.000Z',
          actor_label: 'Alice',
          text: '<@U_BOT> start',
          is_bot: false,
          is_trigger: true,
        },
      ],
    }));
    const { service, sessionsCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: null,
      connector: { fetchThreadHistory, sendMessage },
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-100.000000',
      text: 'start',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '100.000000',
      },
    });

    expect(result).toMatchObject({ success: true, sessionId: 'sess-new', created: true });
    expect(threadMapRepo.findByThread).not.toHaveBeenCalled();
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        custom_context: expect.objectContaining({ gateway_source: expect.any(Object) }),
      }),
      { _agenticConfigResolved: true }
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'C123-100.000000',
        text: expect.stringContaining('Mention me again to follow up.'),
        blocks: expect.any(Array),
      })
    );
    expect(threadMapRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: slackChannel.id,
        thread_id: 'C123-100.000000',
        session_id: 'sess-new',
      })
    );
  });

  it('rejects Slack channel-like messages that reach the gateway without an explicit mention', async () => {
    const fetchThreadHistory = vi.fn();
    const { service, promptCreate, sessionsCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: makeMapping(),
      connector: { fetchThreadHistory },
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-100.000000',
      text: 'this should not prompt',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: false,
        slack_message_ts: '104.000000',
      },
    });

    expect(result).toEqual({ success: false, sessionId: '', created: false });
    expect(fetchThreadHistory).not.toHaveBeenCalled();
    expect(promptCreate).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(threadMapRepo.updateLastMessage).not.toHaveBeenCalled();
  });
});

describe('GatewayService startup/bootstrap hint (#1982)', () => {
  const STARTUP_BOOTSTRAP_HINT =
    'Startup/bootstrap note: Follow any startup/bootstrap instructions defined by the working directory before answering the gateway message above.';

  function expectFinalStartupBootstrapHint(prompt: string): void {
    expect(prompt.endsWith(STARTUP_BOOTSTRAP_HINT)).toBe(true);
    expect(prompt.split(STARTUP_BOOTSTRAP_HINT)).toHaveLength(2);
  }

  function makeChannel(
    channelType: GatewayChannel['channel_type'],
    channelKey: string
  ): GatewayChannel {
    const config =
      channelType === 'slack'
        ? slackChannel.config
        : channelType === 'discord'
          ? {
              bot_token: 'discord-token',
              application_id: '123456789012345678',
              guild_id: '223456789012345678',
              allowed_channel_ids: ['323456789012345678'],
              allowed_user_ids: ['423456789012345678'],
              allowed_role_ids: [],
            }
          : {};
    return {
      ...slackChannel,
      id: `chan-${channelType}`,
      channel_type: channelType,
      channel_key: channelKey,
      config,
    } as GatewayChannel;
  }

  it('appends the hint after preserved Slack initial-thread context and instruction', async () => {
    const sendMessage = vi.fn(async () => '100.000001');
    const fetchThreadHistory = vi.fn(async () => ({
      threadId: 'C123-100.000000',
      channel: 'C123',
      thread_ts: '100.000000',
      has_more: false,
      messages: [
        {
          ts: '99.000000',
          iso_time: '2026-06-21T23:59:59.000Z',
          actor_label: 'Bob',
          text: 'Earlier thread context',
          is_bot: false,
          is_trigger: false,
        },
        {
          ts: '100.000000',
          iso_time: '2026-06-22T00:00:00.000Z',
          actor_label: 'Alice',
          text: '<@U_BOT> start',
          is_bot: false,
          is_trigger: true,
        },
      ],
    }));
    const { service, promptCreate } = makeGatewayHarness({
      existingMapping: null,
      connector: { fetchThreadHistory, sendMessage },
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-100.000000',
      text: 'start',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '100.000000',
        slack_user_name: 'Alice',
      },
    });

    expect(result).toMatchObject({ success: true, created: true });
    const prompt = promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('**Slack context**');
    expect(prompt).toContain('Earlier thread context');
    expect(prompt).toContain(
      '**Instruction:** Answer the current summon using the context above. Do not repeat the transcript unless asked.'
    );
    expect(prompt.indexOf('**Instruction:**')).toBeLessThan(prompt.indexOf(STARTUP_BOOTSTRAP_HINT));
    expectFinalStartupBootstrapHint(prompt);
  });

  it('appends the hint when fresh Slack thread history falls back to the raw message', async () => {
    const sendMessage = vi.fn(async () => '100.000001');
    const fetchThreadHistory = vi.fn(async () => {
      throw new Error('slack unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service, promptCreate } = makeGatewayHarness({
      existingMapping: null,
      connector: { fetchThreadHistory, sendMessage },
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-100.000000',
      text: 'fallback request',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '100.000000',
      },
    });

    expect(result).toMatchObject({ success: true, created: true });
    const prompt = promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('fallback request');
    expect(prompt).not.toContain('**Slack context**');
    expectFinalStartupBootstrapHint(prompt);
    expect(warn).toHaveBeenCalledWith('[gateway] Failed to fetch Slack thread catch-up context');
  });

  it('appends the hint after preserved outbound-seed provenance and consumes the seed', async () => {
    const outboundSeed = {
      id: 'seed-1',
      gateway_channel_id: slackChannel.id,
      channel_type: 'slack',
      platform_channel_id: 'C999',
      platform_message_id: '500.000000',
      platform_thread_id: 'C999-500.000000',
      platform_permalink: null,
      target_branch_id: slackChannel.target_branch_id,
      emitted_by_user_id: 'user-1',
      emitted_by_session_id: 'sess-origin',
      emitted_by_task_id: 'task-origin',
      emitted_by_schedule_id: null,
      message_text: 'Heads up, deploy starting soon.',
      message_preview: 'Heads up, deploy starting soon.',
      metadata: null,
      consumed_by_session_id: null,
      consumed_at: null,
      created_at: '2026-06-22T00:00:00.000Z',
      updated_at: '2026-06-22T00:00:00.000Z',
    } as unknown as GatewayOutboundMessage;
    const sendMessage = vi.fn(async () => '500.000001');
    const { service, promptCreate, completeReplyAdmission } = makeGatewayHarness({
      existingMapping: null,
      connector: { sendMessage },
      outboundSeed,
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: outboundSeed.platform_thread_id,
      text: 'Thanks, looks good.',
      metadata: {
        channel: 'C999',
        channel_type: 'im',
        slack_user_name: 'Alice',
      },
    });

    expect(result).toMatchObject({ success: true, created: true });
    const prompt = promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('This Slack thread began from a proactive Agor gateway message');
    expect(prompt).toContain('Original proactive Agor message:');
    expect(prompt).toContain('Heads up, deploy starting soon.');
    expect(prompt).toContain('Human Slack reply:');
    expect(prompt).toContain('Thanks, looks good.');
    expect(completeReplyAdmission).toHaveBeenCalledWith(outboundSeed.id, 'sess-new');
    expectFinalStartupBootstrapHint(prompt);
  });

  it('appends the hint after preserved GitHub initial-session content', async () => {
    const githubChannel = makeChannel('github', 'github-key');
    const { service, promptCreate } = makeGatewayHarness({
      channel: githubChannel,
      existingMapping: null,
      connector: {},
    });

    const result = await service.create({
      channel_key: 'github-key',
      thread_id: 'preset-io/agor#1982',
      text: '@agor please take a look',
      metadata: { github_user: 'octocat' },
    });

    expect(result).toMatchObject({ success: true, created: true });
    const prompt = promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('[GitHub] @octocat mentioned you on preset-io/agor#1982');
    expect(prompt).toContain('@agor please take a look');
    expect(prompt).toContain('## GitHub Channel Behavior');
    expectFinalStartupBootstrapHint(prompt);
  });

  it.each([
    {
      channelType: 'shortcut' as const,
      channelKey: 'shortcut-key',
      threadId: '42|7',
      text: '@agor investigate the story',
      userName: undefined,
      metadata: {
        shortcut_story_id: 42,
        shortcut_story_name: 'Gateway bootstrap',
        shortcut_user_name: 'Alice',
      },
      expected: ['[Shortcut] Alice mentioned you', '## Shortcut Channel Behavior'],
    },
    {
      channelType: 'discord' as const,
      channelKey: 'discord-key',
      threadId: '723456789012345678',
      text: 'generic connector request',
      userName: '423456789012345678',
      metadata: {
        discord_guild_id: '223456789012345678',
        discord_channel_id: '723456789012345678',
        discord_message_id: '523456789012345678',
        discord_author_id: '423456789012345678',
        discord_role_ids: [],
        discord_bot_user_id: '123456789012345678',
        discord_is_thread: true,
        discord_parent_channel_id: '323456789012345678',
        discord_has_mention: true,
        discord_thread_id: '723456789012345678',
        discord_thread: {
          guild_id: '223456789012345678',
          parent_channel_id: '323456789012345678',
          thread_channel_id: '723456789012345678',
          starter_message_id: '723456789012345678',
        },
        discord_thread_type: 11,
        discord_thread_accessible: true,
        discord_starter_message_accessible: true,
      },
      expected: ['> 📡 **Message via Discord**', '> From: 423456789012345678'],
    },
  ])('appends the hint for a fresh $channelType prompt', async (testCase) => {
    const channel = makeChannel(testCase.channelType, testCase.channelKey);
    const { service, promptCreate } = makeGatewayHarness({
      channel,
      existingMapping: null,
      connector: {},
    });

    const result = await service.create({
      channel_key: testCase.channelKey,
      thread_id: testCase.threadId,
      text: testCase.text,
      user_name: testCase.userName,
      metadata: testCase.metadata,
    });

    expect(result).toMatchObject({ success: true, created: true });
    const prompt = promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain(testCase.text);
    for (const expected of testCase.expected) expect(prompt).toContain(expected);
    expectFinalStartupBootstrapHint(prompt);
  });

  it('keeps a concurrent mapping loser created=false and omits the hint', async () => {
    const winner = makeMapping({ session_id: 'sess-winner' });
    const { service, promptCreate, sessionsCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: null,
      connector: { sendMessage: vi.fn(async () => '100.000001') },
    });
    threadMapRepo.findByChannelAndThread.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    threadMapRepo.create.mockRejectedValueOnce(new Error('mapping unique conflict'));

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: winner.thread_id,
      text: 'concurrent initial delivery',
      metadata: { channel_type: 'im' },
    });

    expect(sessionsCreate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      sessionId: winner.session_id,
      created: false,
    });
    expect(promptCreate.mock.calls[0][1]).toMatchObject({
      route: { id: winner.session_id },
    });
    expect(promptCreate.mock.calls[0][0].prompt).not.toContain(STARTUP_BOOTSTRAP_HINT);
  });

  it('appends the generic hint when recovering initial delivery before Task admission', async () => {
    const eventId = '01927f9d-0000-7000-8000-000000000099';
    const taskId = '01927f9d-0000-7000-8000-000000000098';
    const mapping = makeMapping();
    const { service, promptCreate, sessionsCreate } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { sendMessage: vi.fn(async () => '100.000001') },
    });
    Object.assign(service as unknown as Record<string, unknown>, {
      durableListenerOwnership: true,
      taskRepo: { findById: vi.fn(async () => null) },
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: mapping.thread_id,
      text: 'recover initial delivery',
      gateway_inbound_event_id: eventId as never,
      idempotency_task_id: taskId as never,
      idempotency_session_id: mapping.session_id,
      listener_claim_token: 'opaque-owner',
      listener_channel_id: slackChannel.id,
      metadata: { channel_type: 'im' },
    });

    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      sessionId: mapping.session_id,
      created: true,
    });
    expect(promptCreate.mock.calls[0][0]).toMatchObject({ idempotencyTaskId: taskId });
    expect(promptCreate.mock.calls[0][1]).toMatchObject({
      route: { id: mapping.session_id },
    });
    expectFinalStartupBootstrapHint(promptCreate.mock.calls[0][0].prompt as string);
  });

  it.each([
    {
      channelType: 'slack' as const,
      channelKey: 'slack-key',
      threadId: 'C123-100.000000',
      metadata: { channel_type: 'im' },
    },
    {
      channelType: 'github' as const,
      channelKey: 'github-key',
      threadId: 'preset-io/agor#1982',
      metadata: { github_user: 'octocat' },
    },
  ])('does not add the hint to a continuing $channelType session', async (testCase) => {
    const channel = makeChannel(testCase.channelType, testCase.channelKey);
    const mapping = makeMapping({
      channel_id: channel.id,
      thread_id: testCase.threadId,
      session_id: 'sess-existing',
    });
    const { service, promptCreate } = makeGatewayHarness({
      channel,
      existingMapping: mapping,
      connector: {},
    });

    const result = await service.create({
      channel_key: testCase.channelKey,
      thread_id: testCase.threadId,
      text: 'continuing request',
      metadata: testCase.metadata,
    });

    expect(result).toMatchObject({ success: true, created: false });
    const prompt = promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('continuing request');
    expect(prompt).not.toContain(STARTUP_BOOTSTRAP_HINT);
  });
});

describe('GatewayService durable listener delivery fences', () => {
  it('requires exact structured mentions in Teams group chats despite require_mention false', async () => {
    const channel = {
      ...slackChannel,
      id: 'teams-group-mention-channel' as never,
      channel_type: 'teams',
      channel_key: 'teams-group-mention-key',
      config: {
        app_id: 'teams-app',
        app_password: 'secret',
        microsoft_tenant_id: 'tenant-a',
        require_mention: false,
      },
    } as GatewayChannel;
    const { service, promptCreate } = makeGatewayHarness({
      channel,
      existingMapping: makeMapping({ channel_id: channel.id, thread_id: '19:group@thread.v2' }),
    });

    await expect(
      service.create({
        channel_key: channel.channel_key,
        thread_id: '19:group@thread.v2',
        text: 'display name only',
        metadata: {
          teams_conversation_type: 'groupChat',
          teams_has_mention: false,
        },
      })
    ).resolves.toMatchObject({ success: false, created: false });
    expect(promptCreate).not.toHaveBeenCalled();
  });

  it('rejects forged inbound event IDs and accepts the verified Teams HTTP path', async () => {
    const channel: GatewayChannel = {
      ...slackChannel,
      id: 'teams-authority-channel' as never,
      channel_type: 'teams',
      channel_key: 'teams-authority-key',
      config: {
        app_id: 'teams-app',
        app_password: 'secret',
        microsoft_tenant_id: 'tenant-a',
        require_mention: true,
      },
      provider_installation_id: 'teams-app',
      provider_config_generation: 3,
    } as GatewayChannel;
    const mapping = makeMapping({
      channel_id: channel.id,
      thread_id: '19:channel|root-1',
      session_id: 'sess-teams' as never,
    });
    const { service } = makeGatewayHarness({ channel, existingMapping: mapping });
    Object.assign(service as unknown as Record<string, unknown>, {
      durableListenerOwnership: true,
      taskRepo: { findById: vi.fn(async () => null) },
    });
    const data = {
      channel_key: channel.channel_key,
      thread_id: mapping.thread_id,
      text: 'hello',
      user_name: 'Ada',
      metadata: {
        teams_conversation_type: 'channel',
        teams_has_mention: true,
      },
      gateway_inbound_event_id: '01927f9d-0000-7000-8000-000000000099' as never,
      idempotency_task_id: '01927f9d-0000-7000-8000-000000000098' as never,
      idempotency_session_id: mapping.session_id,
    };

    await expect(service.create(data)).rejects.toThrow(/authority must be verified/i);
    await expect(service.create(withVerifiedHttpGatewayAuthority(data))).resolves.toMatchObject({
      success: true,
      taskId: 'task-1',
    });
  });

  it('uses short guarded tenant DB scopes while keeping provider startup outside transactions', async () => {
    const { db, observations, touch, transactions } = makeGuardedPostgresDatabase();
    expect(() => (db as unknown as { marker(): void }).marker()).toThrow(
      /Missing tenant database scope/
    );

    const service = new GatewayService(db, { service: vi.fn(), get: vi.fn() } as never);
    const channel = attachHiddenTenant(
      {
        ...slackChannel,
        id: 'guarded-channel' as never,
        config: { bot_token: 'xoxb-test', app_token: 'xapp-test' },
      },
      { tenant_id: 'tenant-a' }
    );
    const candidateLease = {
      channel_id: channel.id,
      claim_token: 'candidate-owner',
      generation: 2,
      claimed_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: '2026-01-01T00:00:30.000Z',
      instance_id: 'daemon-a',
      boot_id: 'boot-a',
      checkpoint: null,
    };
    const renewedLease = {
      ...candidateLease,
      channel_id: 'renewed-channel' as never,
      claim_token: 'renewed-owner',
      generation: 4,
    };
    Object.assign(service as unknown as Record<string, unknown>, {
      durableListenerOwnership: true,
      listenerDiscoveryTenantId: undefined,
    });

    const channelRepo = (
      service as unknown as { channelRepo: Record<string, (...args: never[]) => unknown> }
    ).channelRepo;
    channelRepo.renewListener = vi.fn(async () => {
      touch('renew');
      return renewedLease;
    });
    channelRepo.findById = vi.fn(async () => {
      touch('channel-find');
      return channel;
    });
    channelRepo.claimListener = vi.fn(async () => {
      touch('claim');
      return { outcome: 'claimed', lease: candidateLease };
    });
    channelRepo.saveListenerCheckpoint = vi.fn(async () => {
      touch('checkpoint');
      return true;
    });
    channelRepo.listenerClaimIsCurrent = vi.fn(async () => {
      touch('claim-current');
      return true;
    });
    channelRepo.releaseListener = vi.fn(async () => {
      touch('release');
      return true;
    });
    (
      service as unknown as { activeListenerLeases: Map<string, Record<string, unknown>> }
    ).activeListenerLeases.set('tenant-b\0renewed-channel', {
      ...renewedLease,
      tenant_id: 'tenant-b',
    });

    const discovery = vi
      .spyOn(GatewayListenerDiscoveryRepository.prototype, 'findEnabledTenantRefs')
      .mockImplementation(async () => {
        touch('system-discovery');
        return [{ channel_id: channel.id, tenant_id: 'tenant-a' as never }];
      });
    const stopListening = vi.fn(async () => {
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      expect(getCurrentTenantId()).toBe('tenant-a');
    });
    const startListening = vi.fn(async (_callback, options) => {
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      expect(getCurrentTenantId()).toBe('tenant-a');
      await options.saveCheckpoint?.({ cursor: 'next' });
    });
    vi.mocked(getConnector).mockReturnValue({
      startListening,
      stopListening,
      sendMessage: vi.fn(async () => 'sent'),
    });

    try {
      const found = await (
        service as unknown as { reconcileListenersOnce(): Promise<number> }
      ).reconcileListenersOnce();
      expect(found).toBe(1);
      await vi.waitFor(() => expect(startListening).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(
          (service as unknown as { activeListeners: Map<string, unknown> }).activeListeners.has(
            `tenant-a\0${channel.id}`
          )
        ).toBe(true)
      );

      expect(observations).toEqual(
        expect.arrayContaining([
          { label: 'renew', kind: 'tenant', tenantId: 'tenant-b' },
          { label: 'system-discovery', kind: 'system' },
          { label: 'channel-find', kind: 'tenant', tenantId: 'tenant-a' },
          { label: 'claim', kind: 'tenant', tenantId: 'tenant-a' },
          { label: 'checkpoint', kind: 'tenant', tenantId: 'tenant-a' },
          { label: 'claim-current', kind: 'tenant', tenantId: 'tenant-a' },
        ])
      );
      expect(transactions.length).toBeGreaterThanOrEqual(6);
    } finally {
      discovery.mockRestore();
      await service.stopListeners();
    }
    expect(stopListening).toHaveBeenCalledOnce();
    expect(observations).toContainEqual({
      label: 'release',
      kind: 'tenant',
      tenantId: 'tenant-a',
    });
  });

  it('uses guarded tenant DB units for durable inbound admission and completion', async () => {
    const { db, observations, touch } = makeGuardedPostgresDatabase();
    const service = new GatewayService(db, { service: vi.fn(), get: vi.fn() } as never);
    Object.assign(service as unknown as Record<string, unknown>, {
      durableListenerOwnership: true,
    });
    const eventId = '01927f9d-0000-7000-8000-000000000099';
    const channel = attachHiddenTenant(
      { ...slackChannel, id: 'guarded-inbound-channel' as never },
      { tenant_id: 'tenant-a' }
    );
    const inboundEventRepo = (
      service as unknown as { inboundEventRepo: Record<string, (...args: never[]) => unknown> }
    ).inboundEventRepo;
    inboundEventRepo.claim = vi.fn(async () => {
      touch('event-claim');
      return { outcome: 'claimed', event: { id: eventId, delivery_metadata: null } };
    });
    inboundEventRepo.recordDeliveryMetadata = vi.fn(async () => {
      touch('event-metadata');
      return true;
    });
    inboundEventRepo.complete = vi.fn(async () => {
      touch('event-complete');
      return true;
    });
    const channelRepo = (
      service as unknown as { channelRepo: Record<string, (...args: never[]) => unknown> }
    ).channelRepo;
    channelRepo.listenerClaimIsCurrent = vi.fn(async () => {
      touch('inbound-claim-current');
      return true;
    });
    const create = vi.spyOn(service, 'create').mockImplementation(async () => {
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      expect(getCurrentTenantId()).toBe('tenant-a');
      return {
        success: true,
        sessionId: '01927f9d-0000-7000-8000-000000000001',
        created: true,
        taskId: '01927f9d-0000-7000-8000-000000000002' as never,
      };
    });
    const prepareDelivery = vi.fn(async () => {
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      expect(getCurrentTenantId()).toBe('tenant-a');
      return { processing_comment_id: 42 };
    });

    await (
      service as unknown as {
        handleListenerInboundMessage: (...args: unknown[]) => Promise<void>;
      }
    ).handleListenerInboundMessage(
      channel,
      'tenant-a',
      {
        providerEventId: 'slack:event:guarded',
        threadId: 'C1-1.0',
        text: 'hello',
        userId: 'U1',
        prepareDelivery,
      },
      { claim_token: 'opaque-owner' }
    );

    expect(create).toHaveBeenCalledOnce();
    expect(prepareDelivery).toHaveBeenCalledOnce();
    expect(observations).toEqual(
      expect.arrayContaining([
        { label: 'event-claim', kind: 'tenant', tenantId: 'tenant-a' },
        { label: 'event-metadata', kind: 'tenant', tenantId: 'tenant-a' },
        { label: 'event-complete', kind: 'tenant', tenantId: 'tenant-a' },
        { label: 'inbound-claim-current', kind: 'tenant', tenantId: 'tenant-a' },
      ])
    );
    expect(observations.filter(({ label }) => label === 'inbound-claim-current')).toHaveLength(2);
  });

  it('reconciles an already-admitted stable Task before rebuilding a different retry prompt', async () => {
    const eventId = '01927f9d-0000-7000-8000-000000000099';
    const taskId = '01927f9d-0000-7000-8000-000000000098';
    const mapping = makeMapping({
      metadata: {
        ...makeMapping().metadata,
        outbound_seed_initial_prompt_pending: true,
        outbound_seed_initial_event_id: eventId,
      },
    });
    const { service, promptCreate, sessionsCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: mapping,
    });
    Object.assign(service as unknown as Record<string, unknown>, {
      durableListenerOwnership: true,
      taskRepo: {
        findById: vi.fn(async () => ({
          task_id: taskId,
          session_id: mapping.session_id,
          metadata: { gateway_inbound_event_id: eventId },
        })),
      },
      sessionRepo: {
        findById: vi.fn(async () => ({
          session_id: mapping.session_id,
          branch_id: slackChannel.target_branch_id,
          custom_context: { gateway_source: { channel_id: slackChannel.id } },
        })),
      },
    });

    const result = await service.create({
      channel_key: slackChannel.channel_key,
      thread_id: mapping.thread_id,
      text: 'retry text whose formatting may differ',
      gateway_inbound_event_id: eventId as never,
      idempotency_task_id: taskId as never,
      idempotency_session_id: mapping.session_id,
      listener_claim_token: 'opaque-owner',
      listener_channel_id: slackChannel.id,
      metadata: {
        channel_type: 'channel',
        slack_has_mention: true,
      },
    });

    expect(result).toEqual({
      success: true,
      sessionId: mapping.session_id,
      created: false,
      taskId,
    });
    expect(threadMapRepo.completeSeedInitialPrompt).toHaveBeenCalledWith(
      mapping.id,
      eventId,
      taskId
    );
    expect(promptCreate).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('passes the current event to seed completion after prompt admission', async () => {
    const eventId = '01927f9d-0000-7000-8000-000000000099';
    const mapping = makeMapping({
      metadata: {
        ...makeMapping().metadata,
        outbound_seed_initial_prompt_pending: true,
        outbound_seed_initial_event_id: eventId,
      },
    });
    const { service, threadMapRepo } = makeGatewayHarness({ existingMapping: mapping });

    await expect(
      service.create({
        channel_key: slackChannel.channel_key,
        thread_id: mapping.thread_id,
        text: 'follow-up',
        gateway_inbound_event_id: eventId as never,
        metadata: { channel_type: 'channel', slack_has_mention: true },
      })
    ).resolves.toMatchObject({ success: true, sessionId: mapping.session_id });
    expect(threadMapRepo.completeSeedInitialPrompt).toHaveBeenCalledWith(
      mapping.id,
      eventId,
      'task-1'
    );
  });

  it('reconciles a Discord Task crash by advancing only the cursor, not by refetching or duplicating', async () => {
    const eventId = '01927f9d-0000-7000-8000-000000000199';
    const taskId = '01927f9d-0000-7000-8000-000000000198';
    const channel = {
      ...slackChannel,
      id: 'chan-discord-crash',
      channel_type: 'discord',
      channel_key: 'discord-crash-key',
      config: {
        bot_token: 'discord-token',
        application_id: '123456789012345678',
        guild_id: '223456789012345678',
        allowed_channel_ids: ['323456789012345678'],
        allowed_user_ids: ['423456789012345678'],
        allowed_role_ids: [],
      },
    } as unknown as GatewayChannel;
    const mapping = makeMapping({
      channel_id: channel.id,
      thread_id: '723456789012345678',
      metadata: {
        discord_thread: {
          guild_id: '223456789012345678',
          parent_channel_id: '323456789012345678',
          thread_channel_id: '723456789012345678',
          starter_message_id: '723456789012345678',
        },
      },
    });
    const history = vi.fn();
    const harness = makeGatewayHarness({
      channel,
      existingMapping: mapping,
      connector: { history },
    });
    Object.assign(harness.service as unknown as Record<string, unknown>, {
      durableListenerOwnership: true,
      taskRepo: {
        findById: vi.fn(async () => ({
          task_id: taskId,
          session_id: mapping.session_id,
          metadata: { gateway_inbound_event_id: eventId },
        })),
      },
      sessionRepo: {
        findById: vi.fn(async () => ({
          session_id: mapping.session_id,
          branch_id: channel.target_branch_id,
          custom_context: { gateway_source: { channel_id: channel.id } },
        })),
      },
    });

    await expect(
      harness.service.create({
        channel_key: channel.channel_key,
        thread_id: mapping.thread_id,
        text: 'retry',
        user_name: '423456789012345678',
        gateway_inbound_event_id: eventId as never,
        idempotency_task_id: taskId as never,
        idempotency_session_id: mapping.session_id,
        listener_claim_token: 'opaque-owner',
        listener_channel_id: channel.id,
        metadata: {
          discord_guild_id: '223456789012345678',
          discord_channel_id: '723456789012345678',
          discord_message_id: '923456789012345678',
          discord_author_id: '423456789012345678',
          discord_role_ids: [],
          discord_bot_user_id: '123456789012345678',
          discord_is_thread: true,
          discord_parent_channel_id: '323456789012345678',
          discord_has_mention: true,
          discord_thread_id: '723456789012345678',
          discord_thread: mapping.metadata?.discord_thread,
          discord_thread_type: 11,
          discord_thread_accessible: true,
          discord_starter_message_accessible: true,
        },
      })
    ).resolves.toMatchObject({ success: true, taskId });
    expect(history).not.toHaveBeenCalled();
    expect(harness.promptCreate).not.toHaveBeenCalled();
    expect(harness.threadMapRepo.advanceDiscordLastAdmittedMessageId).toHaveBeenCalledWith(
      mapping.id,
      '923456789012345678'
    );
  });

  it('prepares and routes one duplicate provider occurrence only once', async () => {
    const service = new GatewayService(
      { run: vi.fn() } as never,
      { service: vi.fn(), get: vi.fn() } as never
    );
    const eventId = '01927f9d-0000-7000-8000-000000000099';
    const claim = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'claimed',
        event: { id: eventId },
      })
      .mockResolvedValueOnce({
        outcome: 'completed_duplicate',
        event: { id: eventId },
      });
    const complete = vi.fn(async () => true);
    const recordDeliveryMetadata = vi.fn(async () => true);
    const listenerClaimIsCurrent = vi.fn(async () => true);
    Object.assign(service as unknown as Record<string, unknown>, {
      durableListenerOwnership: true,
      inboundEventRepo: { claim, complete, recordDeliveryMetadata },
      channelRepo: { listenerClaimIsCurrent },
    });
    const create = vi.spyOn(service, 'create').mockResolvedValue({
      success: true,
      sessionId: '01927f9d-0000-7000-8000-000000000001',
      created: true,
      taskId: '01927f9d-0000-7000-8000-000000000002' as never,
    });
    const prepareDelivery = vi.fn(async () => ({ processing_comment_id: 42 }));
    const channel = attachHiddenTenant(
      { ...slackChannel, id: 'durable-channel' as never },
      { tenant_id: 'tenant-durable' }
    );
    const lease = {
      channel_id: channel.id,
      claim_token: 'opaque-owner',
      generation: 1,
      claimed_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: '2026-01-01T00:00:30.000Z',
      instance_id: 'daemon-a',
      boot_id: 'boot-a',
      checkpoint: null,
    };
    const invoke = () =>
      (
        service as unknown as {
          handleListenerInboundMessage: (
            channel: GatewayChannel,
            tenantId: string,
            msg: Record<string, unknown>,
            lease: typeof lease
          ) => Promise<void>;
        }
      ).handleListenerInboundMessage(
        channel,
        'tenant-durable',
        {
          providerEventId: 'slack:event:Ev-1',
          threadId: 'C1-1.0',
          text: 'hello',
          userId: 'U1',
          prepareDelivery,
        },
        lease
      );

    await invoke();
    await invoke();

    expect(create).toHaveBeenCalledOnce();
    expect(prepareDelivery).toHaveBeenCalledOnce();
    expect(recordDeliveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ eventId, metadata: { processing_comment_id: 42 } })
    );
    expect(create.mock.calls[0][0]).toMatchObject({
      gateway_inbound_event_id: eventId,
      metadata: { processing_comment_id: 42 },
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it('does not acknowledge an occurrence still processing under a previous owner', async () => {
    const service = new GatewayService(
      { run: vi.fn() } as never,
      { service: vi.fn(), get: vi.fn() } as never
    );
    Object.assign(service as unknown as Record<string, unknown>, {
      durableListenerOwnership: true,
      inboundEventRepo: {
        claim: vi.fn(async () => ({
          outcome: 'in_progress_elsewhere',
          event: { id: '01927f9d-0000-7000-8000-000000000099' },
        })),
      },
    });
    const create = vi.spyOn(service, 'create');
    const prepareDelivery = vi.fn();
    const channel = attachHiddenTenant(
      { ...slackChannel, id: 'pending-channel' as never },
      { tenant_id: 'tenant-a' }
    );

    await expect(
      (
        service as unknown as {
          handleListenerInboundMessage: (...args: unknown[]) => Promise<void>;
        }
      ).handleListenerInboundMessage(
        channel,
        'tenant-a',
        {
          providerEventId: 'slack:event:pending',
          threadId: 'C1-1.0',
          text: 'retry before expiry',
          userId: 'U1',
          prepareDelivery,
        },
        { claim_token: 'new-owner' }
      )
    ).rejects.toThrow(/still being processed/i);
    expect(prepareDelivery).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not hide non-unique Session creation failures behind idempotent recovery', async () => {
    const { service, sessionsCreate, sessionsGet } = makeGatewayHarness({ existingMapping: null });
    const original = new Error('model validation failed');
    sessionsCreate.mockRejectedValueOnce(original);

    await expect(
      service.create({
        channel_key: slackChannel.channel_key,
        thread_id: 'C123-200.000000',
        text: 'start',
        idempotency_session_id: '01927f9d-0000-7000-8000-000000000010' as SessionID,
        metadata: {
          channel: 'C123',
          channel_type: 'channel',
          slack_has_mention: true,
          slack_message_ts: '200.000000',
        },
      })
    ).rejects.toBe(original);
    expect(sessionsGet).not.toHaveBeenCalled();
  });

  it('fails closed before provider or Agor effects after listener loss', async () => {
    const service = new GatewayService(
      { run: vi.fn() } as never,
      { service: vi.fn(), get: vi.fn() } as never
    );
    Object.assign(service as unknown as Record<string, unknown>, {
      durableListenerOwnership: true,
      inboundEventRepo: { claim: vi.fn(async () => ({ outcome: 'listener_lost' })) },
    });
    const create = vi.spyOn(service, 'create');
    const prepareDelivery = vi.fn();
    const channel = attachHiddenTenant(
      { ...slackChannel, id: 'lost-channel' as never },
      { tenant_id: 'tenant-a' }
    );

    await expect(
      (
        service as unknown as {
          handleListenerInboundMessage: (...args: unknown[]) => Promise<void>;
        }
      ).handleListenerInboundMessage(
        channel,
        'tenant-a',
        {
          providerEventId: 'slack:event:lost',
          threadId: 'C1-1.0',
          text: 'stale',
          userId: 'U1',
          prepareDelivery,
        },
        { claim_token: 'stale-token' }
      )
    ).rejects.toThrow(/ownership lost/i);
    expect(prepareDelivery).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('stops a transport before releasing its durable claim on graceful drain', async () => {
    const service = new GatewayService(
      { run: vi.fn() } as never,
      { service: vi.fn(), get: vi.fn() } as never
    );
    const order: string[] = [];
    const channelId = 'graceful-channel';
    const key = `tenant-a\0${channelId}`;
    (
      service as unknown as { activeListeners: Map<string, Record<string, unknown>> }
    ).activeListeners.set(key, {
      stopListening: vi.fn(async () => {
        order.push('transport-stopped');
      }),
    });
    (
      service as unknown as { activeListenerLeases: Map<string, Record<string, unknown>> }
    ).activeListenerLeases.set(key, {
      tenant_id: 'tenant-a',
      channel_id: channelId,
      claim_token: 'owner-token',
    });
    (service as unknown as { channelRepo: unknown }).channelRepo = {
      releaseListener: vi.fn(async () => {
        order.push('claim-released');
        return true;
      }),
    };

    await runWithTenantContext('tenant-a', () => service.stopChannelListener(channelId));
    expect(order).toEqual(['transport-stopped', 'claim-released']);
  });

  it('keeps the claim until already-admitted callbacks drain during shutdown', async () => {
    const service = new GatewayService(
      { run: vi.fn() } as never,
      { service: vi.fn(), get: vi.fn() } as never
    );
    const channelId = 'draining-channel';
    const listenerKey = `tenant-a\0${channelId}`;
    const stopListening = vi.fn(async () => undefined);
    const releaseListener = vi.fn(async () => true);
    let finishCallback!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      finishCallback = resolve;
    });

    (
      service as unknown as { activeListeners: Map<string, Record<string, unknown>> }
    ).activeListeners.set(listenerKey, { stopListening });
    (
      service as unknown as { activeListenerLeases: Map<string, Record<string, unknown>> }
    ).activeListenerLeases.set(listenerKey, {
      tenant_id: 'tenant-a',
      channel_id: channelId,
      claim_token: 'owner-token',
    });
    (
      service as unknown as { inboundThreadQueues: Map<string, Promise<void>> }
    ).inboundThreadQueues.set(`${listenerKey}\0thread-1`, inFlight);
    (service as unknown as { channelRepo: unknown }).channelRepo = { releaseListener };

    const stopping = service.stopListeners();
    await vi.waitFor(() => expect(stopListening).toHaveBeenCalledOnce());
    expect(releaseListener).not.toHaveBeenCalled();

    finishCallback();
    await stopping;
    expect(releaseListener).toHaveBeenCalledWith(channelId, 'owner-token');
  });
});

describe('GatewayService listener retry supervision', () => {
  const makeSupervisor = () => {
    const service = new GatewayService(
      { run: vi.fn() } as never,
      { service: vi.fn(), get: vi.fn() } as never
    );
    (service as unknown as { durableListenerOwnership: boolean }).durableListenerOwnership = false;
    const channel = attachHiddenTenant(
      {
        ...slackChannel,
        id: 'retry-channel' as never,
        config: { bot_token: 'redacted', app_token: 'redacted' },
      },
      { tenant_id: 'tenant-a' }
    );
    const channelRepo = {
      findById: vi.fn(async () => channel),
      releaseListener: vi.fn(async () => true),
      renewListener: vi.fn(async () => null),
      listenerClaimIsCurrent: vi.fn(async () => true),
    };
    (service as unknown as { channelRepo: unknown }).channelRepo = channelRepo;
    const start = () =>
      runWithTenantContext('tenant-a', () =>
        (
          service as unknown as {
            startChannelListener(c: GatewayChannel, tenant: string): Promise<void>;
          }
        ).startChannelListener(channel, 'tenant-a')
      );
    return { service, channel, channelRepo, start };
  };

  it('parks permanent failures until an explicit channel refresh', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service, channel, start } = makeSupervisor();
    vi.mocked(getConnector).mockReturnValue({
      sendMessage: vi.fn(),
      startListening: vi.fn(async () => {
        throw new GatewayListenerError('slack_bot_token_invalid', 'permanent', 'replace token');
      }),
      stopListening: vi.fn(),
    });
    await start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(vi.mocked(getConnector)).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('retry=operator_action'));
    await runWithTenantContext('tenant-a', () => service.startListenerForChannel(channel.id));
    expect(vi.mocked(getConnector)).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('backs off transient failures, recovers, and cancels retries on disable', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { service, channel, channelRepo, start } = makeSupervisor();
    const startListening = vi
      .fn()
      .mockRejectedValueOnce(new Error('Authorization: Bearer secret'))
      .mockResolvedValue(undefined);
    vi.mocked(getConnector).mockReturnValue({
      sendMessage: vi.fn(),
      startListening,
      stopListening: vi.fn(),
    });
    await start();
    expect(startListening).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(startListening).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(startListening).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('event=recovered'));

    await runWithTenantContext('tenant-a', () => service.stopChannelListener(channel.id));
    channelRepo.findById.mockResolvedValue({ ...channel, enabled: false });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(startListening).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('lets refreshed config supersede a retry startup already in flight', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service, channel, channelRepo, start } = makeSupervisor();
    let finishOldStart!: () => void;
    const oldStart = new Promise<void>((resolve) => {
      finishOldStart = resolve;
    });
    const oldStop = vi.fn(async () => undefined);
    const oldStartListening = vi
      .fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockImplementationOnce(() => oldStart);
    const freshStartListening = vi.fn(async () => undefined);
    vi.mocked(getConnector).mockImplementation((_type, config) =>
      (config as { version?: string }).version === 'fresh'
        ? {
            sendMessage: vi.fn(),
            startListening: freshStartListening,
            stopListening: vi.fn(),
          }
        : {
            sendMessage: vi.fn(),
            startListening: oldStartListening,
            stopListening: oldStop,
          }
    );

    await start();
    const retryStarted = vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(oldStartListening).toHaveBeenCalledTimes(2));
    channelRepo.findById.mockResolvedValue({
      ...channel,
      config: { ...channel.config, version: 'fresh' },
    });
    await runWithTenantContext('tenant-a', () => service.startListenerForChannel(channel.id));
    expect(freshStartListening).toHaveBeenCalledOnce();
    finishOldStart();
    await retryStarted;
    expect(oldStop).toHaveBeenCalled();
    const active = (
      service as unknown as { activeListeners: Map<string, { startListening?: unknown }> }
    ).activeListeners.get(`tenant-a\0${channel.id}`);
    expect(active?.startListening).toBe(freshStartListening);
    vi.useRealTimers();
  });

  it('does not start a retry transport after its durable lease is lost', async () => {
    const { service, channel, channelRepo } = makeSupervisor();
    (service as unknown as { durableListenerOwnership: boolean }).durableListenerOwnership = true;
    const startListening = vi.fn(async () => undefined);
    vi.mocked(getConnector).mockReturnValue({ sendMessage: vi.fn(), startListening });
    channelRepo.renewListener.mockResolvedValue(null);
    const lease = {
      channel_id: channel.id,
      claim_token: 'lost-owner',
      generation: 1,
      claimed_at: '2026-08-10T00:00:00.000Z',
      lease_expires_at: '2026-08-10T00:00:30.000Z',
      instance_id: 'daemon-a',
      boot_id: 'boot-a',
      checkpoint: null,
    };

    await runWithTenantContext('tenant-a', () =>
      (
        service as unknown as {
          startChannelListener(
            c: GatewayChannel,
            tenant: string,
            lease: typeof lease
          ): Promise<void>;
        }
      ).startChannelListener(channel, 'tenant-a', lease)
    );
    expect(startListening).not.toHaveBeenCalled();
    expect(channelRepo.releaseListener).not.toHaveBeenCalled();
  });

  it('reschedules safely when retry preparation fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { channelRepo, start } = makeSupervisor();
    const startListening = vi.fn().mockRejectedValue(new Error('provider secret payload'));
    vi.mocked(getConnector).mockReturnValue({
      sendMessage: vi.fn(),
      startListening,
      stopListening: vi.fn(),
    });
    await start();
    channelRepo.findById.mockRejectedValueOnce(new Error('database details'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('event=start_retry_scheduled'));
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/secret payload|database details/);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(startListening).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('GatewayService MCP resolution', () => {
  const userDefaultMcpId = '00000000-0000-7000-8000-000000000101';
  const channelMcpId = '00000000-0000-7000-8000-000000000102';

  it.each([
    {
      name: 'Claude inherits the execution user default when the channel omits MCPs',
      agenticConfig: null,
      channelMcpIds: undefined,
      expectedMcpIds: [userDefaultMcpId],
    },
    {
      name: 'Codex preset selection does not suppress the execution user default',
      agenticConfig: { agent: 'codex', presetId: 'preset-codex' },
      channelMcpIds: undefined,
      expectedMcpIds: [userDefaultMcpId],
    },
    {
      name: 'an explicit empty channel selection disables inherited MCPs',
      agenticConfig: null,
      channelMcpIds: [],
      expectedMcpIds: [],
    },
    {
      name: 'explicit channel MCPs override the execution user default',
      agenticConfig: { agent: 'codex' },
      channelMcpIds: [channelMcpId],
      expectedMcpIds: [channelMcpId],
    },
  ])('$name', async ({ agenticConfig, channelMcpIds, expectedMcpIds }) => {
    const channel = {
      ...slackChannel,
      agentic_config: agenticConfig,
      mcp_server_ids: channelMcpIds,
    } as unknown as GatewayChannel;
    const executionUser = {
      ...user,
      default_mcp_server_ids: [userDefaultMcpId],
    } as unknown as User;
    const { service, setMCPServers } = makeGatewayHarness({
      channel,
      user: executionUser,
      existingMapping: null,
      connector: {
        fetchThreadHistory: vi.fn(async () => ({ has_more: false, messages: [] })),
        sendMessage: vi.fn(async () => '100.000001'),
      },
    });

    await service.create({
      channel_key: channel.channel_key,
      thread_id: 'C123-100.000000',
      text: 'start',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '100.000000',
      },
    });

    if (expectedMcpIds.length === 0) {
      expect(setMCPServers).not.toHaveBeenCalled();
    } else {
      expect(setMCPServers).toHaveBeenCalledWith('sess-new', expectedMcpIds, 'gateway');
    }
  });

  it('attaches gateway MCP defaults through the real guarded SessionsService boundary', async () => {
    const { db, observations, touch } = makeGuardedPostgresDatabase();
    const emitted = vi.fn(() => {
      expect(getCurrentTenantId()).toBe('tenant-channel');
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
    });
    const sessionsService = new SessionsService(db, {
      service: (name: string) => {
        if (name === 'session-mcp-servers') return { emit: emitted };
        throw new Error(`Unexpected SessionsService dependency: ${name}`);
      },
    } as never);
    const sessionMCPRepo = (
      sessionsService as unknown as {
        sessionMCPRepo: Record<string, (...args: never[]) => unknown>;
      }
    ).sessionMCPRepo;
    const addServer = vi.fn(async () => {
      touch('session-mcp-add');
    });
    sessionMCPRepo.addServer = addServer;
    const setMCPServers = vi.spyOn(sessionsService, 'setMCPServers');
    const executionUser = {
      ...user,
      default_mcp_server_ids: [userDefaultMcpId],
    } as unknown as User;
    const { service, createUnscoped } = makeGatewayHarness({
      db,
      user: executionUser,
      existingMapping: null,
      setMCPServers: sessionsService.setMCPServers.bind(sessionsService),
      connector: {
        fetchThreadHistory: vi.fn(async () => ({ has_more: false, messages: [] })),
        sendMessage: vi.fn(async () => '100.000001'),
      },
    });
    (
      service as unknown as {
        mcpServerRepo: { findById: (id: string) => Promise<Record<string, unknown>> };
      }
    ).mcpServerRepo = {
      findById: vi.fn(async () => ({ auth: { type: 'none' } })),
    };

    await runWithTenantContext('tenant-channel', () =>
      createUnscoped({
        channel_key: slackChannel.channel_key,
        thread_id: 'C123-100.000000',
        text: 'start',
        metadata: {
          channel: 'C123',
          channel_type: 'channel',
          slack_has_mention: true,
          slack_message_ts: '100.000000',
        },
      })
    );

    expect(setMCPServers).toHaveBeenCalledWith('sess-new', [userDefaultMcpId], 'gateway');
    expect(addServer).toHaveBeenCalledWith('sess-new', userDefaultMcpId);
    expect(observations).toContainEqual({
      label: 'session-mcp-add',
      kind: 'tenant',
      tenantId: 'tenant-channel',
    });
    expect(emitted).toHaveBeenCalledOnce();
  });

  it('warns when raw OAuth tokens exist but their authoritative binding is invalid', async () => {
    const channel = {
      ...slackChannel,
      mcp_server_ids: [channelMcpId],
    } as unknown as GatewayChannel;
    const { service, promptCreate } = makeGatewayHarness({ channel, existingMapping: null });
    Object.assign(service as unknown as Record<string, unknown>, {
      mcpServerRepo: {
        findById: vi.fn(async () => ({
          mcp_server_id: channelMcpId,
          name: 'bound-oauth',
          display_name: 'Bound OAuth',
          transport: 'http',
          scope: 'global',
          enabled: true,
          source: 'user',
          url: 'https://mcp.example.test',
          auth: { type: 'oauth', oauth_mode: 'per_user' },
        })),
      },
      userTokenRepo: {
        getToken: vi.fn(async () => ({
          user_id: user.user_id,
          mcp_server_id: channelMcpId,
          oauth_access_token: 'raw-token-must-not-suppress-warning',
          oauth_refresh_token: 'raw-refresh-must-not-suppress-warning',
          grant_generation: 1,
          grant_binding_version: 5,
          refresh_status: 'idle',
          refresh_generation: 0,
          refresh_success_generation: 0,
          created_at: new Date(),
        })),
      },
    });

    await service.create({
      channel_key: channel.channel_key,
      thread_id: 'C123-100.000000',
      text: 'start',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '100.000000',
      },
    });

    expect(promptCreate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('Bound OAuth') }),
      expect.anything()
    );
  });
});

describe('GatewayService Slack system message routing', () => {
  it('renders structured system messages with Slack context payloads', async () => {
    const sendMessage = vi.fn(async () => '104.000000');
    const mapping = makeMapping();
    const { service } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { sendMessage },
    });

    const result = await service.routeMessage({
      session_id: 'sess-1',
      message: '[system] Session is ready',
      metadata: { system: { render_hint: 'context' } },
    });

    expect(result).toEqual({ routed: true, channelType: 'slack' });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'C123-100.000000',
        text: expect.stringContaining('Session is ready'),
        blocks: expect.any(Array),
      })
    );
  });
});

describe('GatewayService Discord beta routing', () => {
  const discordChannel = {
    ...slackChannel,
    id: 'chan-discord',
    name: 'Discord Bot',
    channel_type: 'discord',
    channel_key: 'discord-key',
    config: {
      bot_token: 'discord-token',
      application_id: '123456789012345678',
      guild_id: '223456789012345678',
      allowed_channel_ids: ['323456789012345678'],
      allowed_user_ids: ['423456789012345678'],
      allowed_role_ids: [],
      outbound_enabled: true,
      default_outbound_target: 'channel:323456789012345678',
    },
  } as unknown as GatewayChannel;

  const validDiscordInbound = () => ({
    channel_key: discordChannel.channel_key,
    thread_id: 'discord:message:323456789012345678:523456789012345678',
    text: 'hello',
    user_name: '423456789012345678',
    metadata: {
      discord_guild_id: '223456789012345678',
      discord_channel_id: '323456789012345678',
      discord_message_id: '523456789012345678',
      discord_author_id: '423456789012345678',
      discord_role_ids: [],
      discord_bot_user_id: '123456789012345678',
      discord_is_thread: false,
      discord_has_mention: true,
    },
  });

  it.each([
    ['guild', { discord_guild_id: '999999999999999999' }],
    ['allowed channel', { discord_channel_id: '923456789012345678' }],
    ['mention', { discord_has_mention: false }],
    ['author', { discord_author_id: '523456789012345678' }],
    ['roles', { discord_role_ids: ['not-a-snowflake'] }],
  ] as const)(
    'rejects a Discord %s mismatch before mapping/session admission',
    async (_kind, patch) => {
      const { service, sessionsCreate, threadMapRepo } = makeGatewayHarness({
        channel: discordChannel,
      });
      const inbound = validDiscordInbound();
      inbound.metadata = { ...inbound.metadata, ...patch };

      await expect(service.create(inbound)).resolves.toEqual({
        success: false,
        sessionId: '',
        created: false,
      });
      expect(threadMapRepo.findByChannelAndThread).not.toHaveBeenCalled();
      expect(sessionsCreate).not.toHaveBeenCalled();
    }
  );

  it('accepts direct Discord with an event identity but rejects missing identity under durable ownership', async () => {
    const { service, promptCreate } = makeGatewayHarness({
      channel: discordChannel,
      existingMapping: null,
      outboundSeed: {
        id: 'discord-seed',
        gateway_channel_id: discordChannel.id,
        channel_type: 'discord',
        platform_channel_id: '323456789012345678',
        platform_message_id: '523456789012345678',
        platform_thread_id: 'discord:message:323456789012345678:523456789012345678',
        platform_permalink: null,
        target_branch_id: discordChannel.target_branch_id,
        emitted_by_user_id: 'user-1',
        emitted_by_session_id: null,
        emitted_by_task_id: null,
        emitted_by_schedule_id: null,
        message_text: 'proactive seed',
        message_preview: 'proactive seed',
        metadata: { provider_reply_aliases: [] },
        consumed_by_session_id: null,
        consumed_at: null,
        created_at: '2026-06-22T00:00:00.000Z',
        updated_at: '2026-06-22T00:00:00.000Z',
      } as GatewayOutboundMessage,
    });
    Object.assign(service as unknown as Record<string, unknown>, {
      durableListenerOwnership: true,
    });

    await expect(
      service.create({
        ...validDiscordInbound(),
        gateway_inbound_event_id: '01927f9d-0000-7000-8000-000000000099' as never,
      })
    ).resolves.toMatchObject({ success: true, created: true });
    expect(promptCreate).toHaveBeenCalledOnce();

    await expect(service.create(validDiscordInbound())).rejects.toThrow(
      'Direct gateway inbound delivery is unsupported on PostgreSQL without a provider event identity'
    );
    expect(promptCreate).toHaveBeenCalledOnce();
  });

  it('writes a new Discord mapping with the verified provider thread Snowflake', async () => {
    const harness = makeGatewayHarness({ channel: discordChannel, existingMapping: null });
    const inbound = validDiscordInbound();
    inbound.thread_id = '723456789012345678';
    inbound.metadata = {
      ...inbound.metadata,
      discord_thread_id: '723456789012345678',
      discord_thread: {
        guild_id: '223456789012345678',
        parent_channel_id: '323456789012345678',
        thread_channel_id: '723456789012345678',
        starter_message_id: '523456789012345678',
      },
      discord_thread_type: 11,
      discord_thread_accessible: true,
      discord_starter_message_accessible: true,
    };

    await expect(harness.service.create(inbound)).resolves.toMatchObject({
      success: true,
      created: true,
    });
    expect(harness.threadMapRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: '723456789012345678' })
    );
    expect(harness.threadMapRepo.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: 'discord:message:323456789012345678:523456789012345678',
      })
    );
  });

  it('does not send transient creation or queue progress to Discord', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const harness = makeGatewayHarness({
      channel: discordChannel,
      existingMapping: null,
      connector: { sendMessage },
    });
    const inbound = validDiscordInbound();
    inbound.thread_id = '723456789012345678';
    inbound.metadata = {
      ...inbound.metadata,
      discord_thread_id: '723456789012345678',
      discord_thread: {
        guild_id: '223456789012345678',
        parent_channel_id: '323456789012345678',
        thread_channel_id: '723456789012345678',
        starter_message_id: '523456789012345678',
      },
      discord_thread_type: 11,
      discord_thread_accessible: true,
      discord_starter_message_accessible: true,
    };
    await harness.service.create(inbound);
    expect(
      sendMessage.mock.calls.map(([request]) => String((request as { text?: unknown }).text))
    ).not.toEqual(expect.arrayContaining([expect.stringMatching(/Creating new|message queued/i)]));

    sendMessage.mockClear();
    const queued = makeGatewayHarness({
      channel: discordChannel,
      existingMapping: makeMapping({
        channel_id: discordChannel.id,
        thread_id: inbound.thread_id,
        metadata: {},
      }),
      connector: { sendMessage },
    });
    queued.promptCreate.mockResolvedValueOnce({
      task_id: 'task-queued',
      session_id: 'sess-1',
      status: 'queued',
      queue_position: 2,
    });
    await queued.service.create(inbound);
    expect(
      sendMessage.mock.calls.map(([request]) => String((request as { text?: unknown }).text))
    ).not.toEqual(expect.arrayContaining([expect.stringMatching(/message queued/i)]));
  });

  it('admits one complete Discord interval before advancing the mapping cursor', async () => {
    const connector = {
      sendMessage: vi.fn(async () => undefined),
      fetchProviderHistory: vi.fn(async (request: { throughProviderCursor: string }) => ({
        threadId: '723456789012345678',
        complete: true,
        messages: [
          {
            providerMessageId: '823456789012345678',
            timestamp: '2026-08-20T12:00:00.000Z',
            actorLabel: 'human',
            text: 'ambient context',
            isBot: false,
            isSystem: false,
            isRich: false,
            isTrigger: false,
            isMention: false,
          },
          {
            providerMessageId: request.throughProviderCursor,
            timestamp: '2026-08-20T12:01:00.000Z',
            actorLabel: 'summoner',
            text: 'live summon',
            isBot: false,
            isSystem: false,
            isRich: false,
            isTrigger: true,
            isMention: true,
          },
        ],
      })),
    };
    const harness = makeGatewayHarness({ channel: discordChannel, connector });
    const inbound = validDiscordInbound();
    inbound.thread_id = '723456789012345678';
    inbound.metadata = {
      ...inbound.metadata,
      discord_message_id: '923456789012345678',
      discord_channel_id: '723456789012345678',
      discord_parent_channel_id: '323456789012345678',
      discord_is_thread: true,
      discord_thread_id: '723456789012345678',
      discord_thread: {
        guild_id: '223456789012345678',
        parent_channel_id: '323456789012345678',
        thread_channel_id: '723456789012345678',
        starter_message_id: '723456789012345678',
      },
      discord_thread_type: 11,
      discord_thread_accessible: true,
      discord_starter_message_accessible: true,
    };

    await expect(harness.service.create(inbound)).resolves.toMatchObject({ success: true });
    const prompt = harness.promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('ambient context');
    expect(prompt).toContain('hello');
    expect(harness.promptCreate).toHaveBeenCalledOnce();
    const persistedMapping = await harness.threadMapRepo.findById('map-new');
    expect(JSON.stringify(persistedMapping?.metadata)).not.toContain('ambient context');
    expect(JSON.stringify(persistedMapping?.metadata)).not.toContain('live summon');
    expect(harness.threadMapRepo.advanceDiscordLastAdmittedMessageId).toHaveBeenCalledWith(
      'map-new',
      '923456789012345678'
    );
    expect(harness.promptCreate.mock.invocationCallOrder[0]).toBeLessThan(
      harness.threadMapRepo.advanceDiscordLastAdmittedMessageId.mock.invocationCallOrder[0]
    );
  });

  it('reads a new summon boundary from its parent before later catch-up moves to the thread', async () => {
    const connector = {
      sendMessage: vi.fn(async () => undefined),
      fetchProviderHistory: vi.fn(
        async (request: { afterProviderCursor?: string; throughProviderCursor: string }) => ({
          threadId: request.threadId,
          complete: true,
          messages: [
            {
              providerMessageId: request.throughProviderCursor,
              timestamp: '2026-08-20T12:01:00.000Z',
              actorLabel: 'summoner',
              text: 'live summon',
              isBot: false,
              isSystem: false,
              isRich: false,
              isTrigger: true,
              isMention: true,
            },
          ],
        })
      ),
    };
    const harness = makeGatewayHarness({ channel: discordChannel, connector });
    const inbound = validDiscordInbound();
    inbound.thread_id = '723456789012345678';
    inbound.metadata = {
      ...inbound.metadata,
      discord_message_id: '523456789012345678',
      discord_thread_id: '723456789012345678',
      discord_thread: {
        guild_id: '223456789012345678',
        parent_channel_id: '323456789012345678',
        thread_channel_id: '723456789012345678',
        starter_message_id: '523456789012345678',
      },
      discord_thread_type: 11,
      discord_thread_accessible: true,
      discord_starter_message_accessible: true,
    };

    await expect(harness.service.create(inbound)).resolves.toMatchObject({ success: true });
    expect(connector.fetchProviderHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: '323456789012345678',
        afterProviderCursor: '523456789012345678',
        throughProviderCursor: '523456789012345678',
      })
    );
  });

  it('rejects an incomplete Discord history interval without a Task or cursor advance', async () => {
    const connector = {
      sendMessage: vi.fn(async () => undefined),
      fetchProviderHistory: vi.fn(async () => {
        throw new Error('history coverage unavailable');
      }),
    };
    vi.mocked(getConnector).mockReturnValue(connector as never);
    const mapping = makeMapping({
      channel_id: discordChannel.id,
      thread_id: '723456789012345678',
      metadata: {
        discord_thread: {
          guild_id: '223456789012345678',
          parent_channel_id: '323456789012345678',
          thread_channel_id: '723456789012345678',
          starter_message_id: '723456789012345678',
        },
      },
    });
    const harness = makeGatewayHarness({ channel: discordChannel, existingMapping: mapping });
    (harness.service as unknown as { durableListenerOwnership: boolean }).durableListenerOwnership =
      true;
    const inbound = validDiscordInbound();
    inbound.thread_id = '723456789012345678';
    inbound.metadata = {
      ...inbound.metadata,
      discord_channel_id: '723456789012345678',
      discord_message_id: '923456789012345678',
      discord_is_thread: true,
      discord_parent_channel_id: '323456789012345678',
      discord_thread_id: '723456789012345678',
      discord_thread: mapping.metadata?.discord_thread,
      discord_thread_type: 11,
      discord_thread_accessible: true,
      discord_starter_message_accessible: true,
    };

    await expect(
      harness.service.create({
        ...inbound,
        gateway_inbound_event_id: '01927f9d-0000-7000-8000-000000000299' as never,
        listener_claim_token: 'opaque-owner',
        listener_channel_id: discordChannel.id,
      })
    ).rejects.toThrow('history coverage unavailable');
    expect(harness.promptCreate).not.toHaveBeenCalled();
    expect(harness.threadMapRepo.advanceDiscordLastAdmittedMessageId).not.toHaveBeenCalled();
  });

  it('rejects malformed stored Discord starter metadata before history or admission', async () => {
    const fetchProviderHistory = vi.fn(async () => ({
      threadId: '723456789012345678',
      complete: true,
      messages: [],
    }));
    const mapping = makeMapping({
      channel_id: discordChannel.id,
      thread_id: '723456789012345678',
      metadata: {
        discord_thread: {
          guild_id: '223456789012345678',
          parent_channel_id: '323456789012345678',
          thread_channel_id: '723456789012345678',
          starter_message_id: 'malformed',
        },
      },
    });
    const harness = makeGatewayHarness({
      channel: discordChannel,
      existingMapping: mapping,
      connector: { fetchProviderHistory },
    });
    (harness.service as unknown as { durableListenerOwnership: boolean }).durableListenerOwnership =
      true;
    const inbound = validDiscordInbound();
    inbound.thread_id = '723456789012345678';
    inbound.metadata = {
      ...inbound.metadata,
      discord_channel_id: '723456789012345678',
      discord_message_id: '923456789012345678',
      discord_is_thread: true,
      discord_parent_channel_id: '323456789012345678',
      discord_thread_id: '723456789012345678',
      discord_thread: {
        guild_id: '223456789012345678',
        parent_channel_id: '323456789012345678',
        thread_channel_id: '723456789012345678',
        starter_message_id: '723456789012345678',
      },
      discord_thread_type: 11,
      discord_thread_accessible: true,
      discord_starter_message_accessible: true,
    };

    await expect(
      harness.service.create({
        ...inbound,
        gateway_inbound_event_id: '01927f9d-0000-7000-8000-000000000399' as never,
        listener_claim_token: 'opaque-owner',
        listener_channel_id: discordChannel.id,
      })
    ).rejects.toThrow('Stored Discord authority metadata was malformed');
    expect(fetchProviderHistory).not.toHaveBeenCalled();
    expect(harness.promptCreate).not.toHaveBeenCalled();
    expect(harness.threadMapRepo.advanceDiscordLastAdmittedMessageId).not.toHaveBeenCalled();
  });

  it('labels a proactive Discord seed with Discord context in the initial prompt', async () => {
    const seed = {
      id: 'discord-seed-context',
      gateway_channel_id: discordChannel.id,
      channel_type: 'discord',
      platform_channel_id: '323456789012345678',
      platform_message_id: '523456789012345678',
      platform_thread_id: 'discord:message:323456789012345678:523456789012345678',
      emitted_by_user_id: user.user_id,
      emitted_by_session_id: null,
      emitted_by_task_id: null,
      emitted_by_schedule_id: null,
      message_text: 'proactive Discord seed',
      metadata: { provider_reply_aliases: [] },
      consumed_at: null,
    };
    const harness = makeGatewayHarness({ channel: discordChannel, existingMapping: null });
    harness.outboundRepo.admitReplySession.mockResolvedValue({
      admitted: true,
      message: seed,
      sessionId: 'discord-seed-session',
    } as never);

    await expect(harness.service.create(validDiscordInbound())).resolves.toMatchObject({
      success: true,
      created: true,
    });
    const prompt = harness.promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('This Discord thread began');
    expect(prompt).toContain('Discord channel: 323456789012345678');
    expect(prompt).toContain('Human Discord reply:');
    expect(prompt).not.toContain('Slack');
  });

  it('rejects a Discord thread whose parent is not in the fresh allowlist', async () => {
    const { service, sessionsCreate, threadMapRepo } = makeGatewayHarness({
      channel: discordChannel,
    });
    const inbound = validDiscordInbound();
    inbound.thread_id = 'discord:thread:923456789012345678:823456789012345678';
    inbound.metadata = {
      ...inbound.metadata,
      discord_channel_id: '823456789012345678',
      discord_message_id: '523456789012345678',
      discord_is_thread: true,
      discord_parent_channel_id: '923456789012345678',
    };

    await expect(service.create(inbound)).resolves.toMatchObject({
      success: false,
      sessionId: '',
      created: false,
    });
    expect(threadMapRepo.findByChannelAndThread).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('sanitizes prompt-admission errors before logs, progress, and Discord delivery', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const promptFailure = new Error(
      'AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCC https://discord.example.test/api /srv/agor/secrets\nunsafe'
    );
    const harness = makeGatewayHarness({
      channel: discordChannel,
      existingMapping: makeMapping({
        channel_id: discordChannel.id,
        thread_id: 'discord:message:323456789012345678:523456789012345678',
        metadata: {},
      }),
      connector: { sendMessage },
    });
    harness.promptCreate.mockRejectedValueOnce(promptFailure);

    const result = await harness.service.create(validDiscordInbound());
    const logged = errorLog.mock.calls.flat().join(' ');
    const providerMessages = sendMessage.mock.calls
      .map(([request]) => (request as { text?: string }).text ?? '')
      .join('\n');

    expect(result).toMatchObject({ success: true, sessionId: 'sess-1' });
    expect(logged).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB');
    expect(logged).not.toContain('discord.example.test');
    expect(logged).not.toContain('/srv/agor/secrets');
    expect(logged).not.toContain('\nunsafe');
    expect(providerMessages).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB');
    expect(providerMessages).not.toContain('discord.example.test');
    expect(providerMessages).not.toContain('/srv/agor/secrets');
    expect(providerMessages).not.toContain('\nunsafe');
    expect(providerMessages).toContain('provider_request_failed');
    expect(providerMessages).not.toContain('Bot');
    errorLog.mockRestore();
  });

  it('fails closed when stored Discord role metadata is malformed', async () => {
    const channel = {
      ...discordChannel,
      config: {
        ...(discordChannel.config as Record<string, unknown>),
        allowed_user_ids: [],
        allowed_role_ids: ['523456789012345678'],
      },
    } as unknown as GatewayChannel;
    const { service, sessionsCreate, threadMapRepo } = makeGatewayHarness({ channel });
    const inbound = validDiscordInbound();
    inbound.metadata = {
      ...inbound.metadata,
      discord_role_ids: ['malformed'],
    };

    await expect(service.create(inbound)).resolves.toMatchObject({
      success: false,
      sessionId: '',
      created: false,
    });
    expect(threadMapRepo.findByChannelAndThread).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('keeps one provider thread independent for two Discord rows in one shared store', async () => {
    const sharedMappings: ThreadSessionMap[] = [];
    const channelA = {
      ...discordChannel,
      id: 'discord-a',
      channel_key: 'discord-key-a',
    } as unknown as GatewayChannel;
    const channelB = {
      ...discordChannel,
      id: 'discord-b',
      channel_key: 'discord-key-b',
      config: {
        ...(discordChannel.config as Record<string, unknown>),
        application_id: '623456789012345679',
      },
    } as unknown as GatewayChannel;
    const inboundA = validDiscordInbound();
    const inboundB = {
      ...validDiscordInbound(),
      channel_key: channelB.channel_key,
      metadata: {
        ...validDiscordInbound().metadata,
        discord_bot_user_id: '623456789012345679',
      },
    };
    const first = makeGatewayHarness({ channel: channelA });
    const second = makeGatewayHarness({ channel: channelB });

    for (const harness of [first, second]) {
      harness.threadMapRepo.findByChannelAndThread.mockImplementation(
        async (channelId: string, threadId: string) =>
          sharedMappings.find(
            (mapping) => mapping.channel_id === channelId && mapping.thread_id === threadId
          ) ?? null
      );
      harness.threadMapRepo.create.mockImplementation(async (data) => {
        const mapping = makeMapping({
          ...data,
          id: `map-${sharedMappings.length + 1}`,
          session_id: data.session_id,
          metadata: data.metadata ?? null,
        });
        sharedMappings.push(mapping);
        return mapping;
      });
    }
    first.sessionsCreate.mockResolvedValueOnce({
      session_id: 'discord-session-a',
      branch_id: channelA.target_branch_id,
      status: SessionStatus.IDLE,
    });
    second.sessionsCreate.mockResolvedValueOnce({
      session_id: 'discord-session-b',
      branch_id: channelB.target_branch_id,
      status: SessionStatus.IDLE,
    });

    await expect(first.service.create(inboundA)).resolves.toMatchObject({ success: true });
    await expect(second.service.create(inboundB)).resolves.toMatchObject({ success: true });
    expect(sharedMappings).toHaveLength(2);
    expect(sharedMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel_id: channelA.id,
          thread_id: inboundA.thread_id,
          session_id: 'discord-session-a',
        }),
        expect.objectContaining({
          channel_id: channelB.id,
          thread_id: inboundB.thread_id,
          session_id: 'discord-session-b',
        }),
      ])
    );
    expect(first.threadMapRepo.findByThread).not.toHaveBeenCalled();
    expect(second.threadMapRepo.findByThread).not.toHaveBeenCalled();
  });

  it('reuses a stable outbound session only when every collision identity matches', async () => {
    const channel = attachHiddenTenant({ ...discordChannel }, { tenant_id: 'tenant-channel' });
    const inbound = validDiscordInbound();
    const stableSessionId = '01927f9d-0000-7000-8000-000000000011' as SessionID;
    const seed = {
      id: 'outbound-seed-1',
      platform_thread_id: 'discord:message:323456789012345678:523456789012345678',
      metadata: { provider_reply_aliases: [] },
    };
    const admission = { admitted: true, message: seed, sessionId: stableSessionId };
    const prior = attachHiddenTenant(
      {
        session_id: stableSessionId,
        branch_id: channel.target_branch_id,
        created_by: user.user_id,
        custom_context: {
          gateway_source: {
            channel_id: channel.id,
            channel_type: channel.channel_type,
            thread_id: inbound.thread_id,
            outbound_seed_id: seed.id,
            outbound_seed_thread_id: seed.platform_thread_id,
          },
        },
      },
      { tenant_id: 'tenant-channel' }
    );
    const { service, outboundRepo, sessionsCreate, sessionsGet } = makeGatewayHarness({ channel });
    outboundRepo.admitReplySession.mockResolvedValue(admission as never);
    const collision = Object.assign(new Error('duplicate session id'), { code: '23505' });
    sessionsCreate.mockRejectedValueOnce(collision);
    sessionsGet.mockResolvedValueOnce(prior as never);

    await expect(service.create(inbound)).resolves.toMatchObject({
      success: true,
      sessionId: stableSessionId,
    });
    expect(sessionsGet).toHaveBeenCalledWith(stableSessionId, { user });
    expect(outboundRepo.completeReplyAdmission).toHaveBeenCalledWith(seed.id, stableSessionId);
  });

  it('propagates non-unique session creation errors without collision recovery', async () => {
    const channel = attachHiddenTenant({ ...discordChannel }, { tenant_id: 'tenant-channel' });
    const inbound = validDiscordInbound();
    const stableSessionId = '01927f9d-0000-7000-8000-000000000013' as SessionID;
    const seed = {
      id: 'outbound-seed-3',
      platform_thread_id: inbound.thread_id,
      metadata: { provider_reply_aliases: [] },
    };
    const admission = { admitted: true, message: seed, sessionId: stableSessionId };
    const { service, outboundRepo, sessionsCreate, sessionsGet } = makeGatewayHarness({ channel });
    outboundRepo.admitReplySession.mockResolvedValue(admission as never);
    const failure = new Error('database unavailable');
    sessionsCreate.mockRejectedValueOnce(failure);

    await expect(service.create(inbound)).rejects.toBe(failure);
    expect(sessionsGet).not.toHaveBeenCalled();
    expect(outboundRepo.completeReplyAdmission).not.toHaveBeenCalled();
  });

  it.each([
    ['foreign tenant', { tenantId: 'tenant-other' }],
    ['wrong branch', { branch_id: 'branch-other' }],
    ['wrong user', { created_by: 'user-other' }],
    ['wrong channel', { source: { channel_id: 'chan-other' } }],
    ['wrong outbound seed', { source: { outbound_seed_id: 'outbound-seed-other' } }],
    ['malformed gateway source', { malformed: true }],
  ] as const)('fails closed for a %s stable-session collision', async (_kind, mutation) => {
    const channel = attachHiddenTenant({ ...discordChannel }, { tenant_id: 'tenant-channel' });
    const inbound = validDiscordInbound();
    const stableSessionId = '01927f9d-0000-7000-8000-000000000012' as SessionID;
    const seed = {
      id: 'outbound-seed-2',
      platform_thread_id: inbound.thread_id,
      metadata: { provider_reply_aliases: [] },
    };
    const admission = { admitted: true, message: seed, sessionId: stableSessionId };
    const source = {
      channel_id: channel.id,
      channel_type: channel.channel_type,
      thread_id: inbound.thread_id,
      outbound_seed_id: seed.id,
      outbound_seed_thread_id: seed.platform_thread_id,
      ...(mutation.source ?? {}),
    };
    const prior = mutation.malformed
      ? attachHiddenTenant(
          {
            session_id: stableSessionId,
            branch_id: channel.target_branch_id,
            created_by: user.user_id,
            custom_context: { gateway_source: 'malformed' },
          },
          { tenant_id: 'tenant-channel' }
        )
      : attachHiddenTenant(
          {
            session_id: stableSessionId,
            branch_id: mutation.branch_id ?? channel.target_branch_id,
            created_by: mutation.created_by ?? user.user_id,
            custom_context: { gateway_source: source },
          },
          { tenant_id: mutation.tenantId ?? 'tenant-channel' }
        );
    const { service, outboundRepo, sessionsCreate, sessionsGet } = makeGatewayHarness({ channel });
    outboundRepo.admitReplySession.mockResolvedValue(admission as never);
    const collision = Object.assign(new Error('duplicate session id'), { code: '23505' });
    sessionsCreate.mockRejectedValueOnce(collision);
    sessionsGet.mockResolvedValueOnce(prior as never);

    await expect(service.create(inbound)).rejects.toBe(collision);
    expect(outboundRepo.completeReplyAdmission).not.toHaveBeenCalled();
  });

  it('fails closed for an unmentioned inbound prompt', async () => {
    const sendMessage = vi.fn();
    const { service } = makeGatewayHarness({ channel: discordChannel, connector: { sendMessage } });

    const result = await service.create({
      channel_key: discordChannel.channel_key,
      thread_id: 'discord:message:323456789012345678:523456789012345678',
      text: 'not addressed to the bot',
      user_name: 'Discord user',
      metadata: { discord_has_mention: false },
    });

    expect(result).toEqual({ success: false, sessionId: '', created: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('creates separate sessions for top-level mentions replying to the same human message', async () => {
    const mappings: ThreadSessionMap[] = [];
    const harness = makeGatewayHarness({ channel: discordChannel, existingMapping: null });
    harness.threadMapRepo.findByChannelAndThread.mockImplementation(
      async (_channelId: string, threadId: string) =>
        mappings.find((mapping) => mapping.thread_id === threadId) ?? null
    );
    harness.threadMapRepo.findByChannel.mockImplementation(async () => mappings);
    harness.threadMapRepo.create.mockImplementation(async (data) => {
      const mapping = makeMapping({
        ...data,
        id: `discord-map-${mappings.length + 1}`,
        session_id: data.session_id,
        metadata: data.metadata ?? null,
      });
      mappings.push(mapping);
      return mapping;
    });
    harness.sessionsCreate
      .mockResolvedValueOnce({
        session_id: 'discord-session-one',
        branch_id: discordChannel.target_branch_id,
        status: SessionStatus.IDLE,
      })
      .mockResolvedValueOnce({
        session_id: 'discord-session-two',
        branch_id: discordChannel.target_branch_id,
        status: SessionStatus.IDLE,
      });

    const unrelatedHumanMessageId = '923456789012345678';
    const first = validDiscordInbound();
    first.thread_id = `discord:message:323456789012345678:${unrelatedHumanMessageId}`;
    first.metadata = {
      ...first.metadata,
      discord_message_id: '623456789012345678',
      discord_reply_to_message_id: unrelatedHumanMessageId,
    };
    const second = {
      ...first,
      text: 'second mention',
      metadata: {
        ...first.metadata,
        discord_message_id: '723456789012345678',
      },
    };

    await expect(harness.service.create(first)).resolves.toMatchObject({
      success: true,
      sessionId: 'discord-session-one',
      created: true,
    });
    await expect(harness.service.create(second)).resolves.toMatchObject({
      success: true,
      sessionId: 'discord-session-two',
      created: true,
    });
    expect(mappings.map((mapping) => mapping.thread_id)).toEqual([
      'discord:message:323456789012345678:623456789012345678',
      'discord:message:323456789012345678:723456789012345678',
    ]);
  });

  it('uses the canonical public Discord thread without storing ordinary response aliases', async () => {
    const sendMessage = vi.fn(async () => ({
      messageId: '623456789012345678',
      messageIds: ['623456789012345678', '723456789012345678'],
      threadId: 'discord:message:323456789012345678:523456789012345678',
      replyAliases: [
        'discord:message:323456789012345678:623456789012345678',
        'discord:message:323456789012345678:723456789012345678',
      ],
      platformChannelId: '323456789012345678',
      platformThreadId: 'discord:message:323456789012345678:523456789012345678',
    }));
    const mapping = makeMapping({
      channel_id: discordChannel.id,
      thread_id: 'discord:message:323456789012345678:523456789012345678',
      metadata: {},
    });
    const { service, threadMapRepo } = makeGatewayHarness({
      channel: discordChannel,
      existingMapping: mapping,
      connector: { sendMessage },
    });

    const result = await service.routeMessage({ session_id: mapping.session_id, message: 'reply' });

    expect(result).toEqual({ routed: true, channelType: 'discord' });
    expect(threadMapRepo.mergeGatewayReplyAliases).not.toHaveBeenCalled();
    expect(mapping.metadata).not.toHaveProperty('gateway_reply_aliases');
  });

  it('uses a content-free failure code for provider routing logs', async () => {
    const canary = 'private-user@example.test workspace-secret-label';
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mapping = makeMapping();
    const harness = makeGatewayHarness({
      channel: slackChannel,
      existingMapping: mapping,
      connector: { sendMessage: vi.fn(async () => Promise.reject(new Error(canary))) },
    });

    await expect(
      harness.service.routeMessage({ session_id: mapping.session_id, message: 'reply' })
    ).resolves.toEqual({ routed: false, channelType: 'slack' });

    const logged = errorLog.mock.calls.flat().join(' ');
    expect(logged).toContain(`channel_id=${slackChannel.id}`);
    expect(logged).toContain('code=provider_request_failed');
    expect(logged).not.toContain(canary);
    expect(logged).not.toContain('private-user@example.test');
    errorLog.mockRestore();
  });

  it('suppresses the legacy after-hook send when a durable Discord intent exists', async () => {
    const sendMessage = vi.fn(async () => '623456789012345678');
    const mapping = makeMapping({
      channel_id: discordChannel.id,
      thread_id: 'discord:message:323456789012345678:523456789012345678',
      metadata: {},
    });
    const { service } = makeGatewayHarness({
      channel: discordChannel,
      existingMapping: mapping,
      connector: { sendMessage },
    });
    const findByMessageId = vi.fn(async () => ({ delivery_id: 'durable-delivery' }));
    (
      service as unknown as { deliveryRepo: { findByMessageId: typeof findByMessageId } }
    ).deliveryRepo = { findByMessageId };

    await expect(
      service.routeMessage({
        session_id: mapping.session_id,
        message_id: 'assistant-message-1',
        message: 'reply from the agent',
      })
    ).resolves.toEqual({ routed: true, channelType: 'discord' });

    expect(findByMessageId).toHaveBeenCalledWith('assistant-message-1');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps legacy Slack, unmapped, and proactive-seed routing outside the Discord fence', async () => {
    const slackSend = vi.fn(async () => '104.000000');
    const slack = makeGatewayHarness({
      existingMapping: makeMapping(),
      connector: { sendMessage: slackSend },
    });
    (
      slack.service as unknown as { deliveryRepo: { findByMessageId: () => Promise<null> } }
    ).deliveryRepo = { findByMessageId: async () => null };
    await expect(
      runWithTenantContext('tenant-channel', () =>
        slack.service.routeMessage({ session_id: 'sess-1', message: 'slack' })
      )
    ).resolves.toEqual({ routed: true, channelType: 'slack' });
    expect(slackSend).toHaveBeenCalledOnce();

    const unmappedSend = vi.fn(async () => 'never');
    const unmapped = makeGatewayHarness({
      existingMapping: null,
      connector: { sendMessage: unmappedSend },
    });
    (
      unmapped.service as unknown as { deliveryRepo: { findByMessageId: () => Promise<null> } }
    ).deliveryRepo = { findByMessageId: async () => null };
    await expect(
      runWithTenantContext('tenant-channel', () =>
        unmapped.service.routeMessage({ session_id: 'sess-1', message: 'no-op' })
      )
    ).resolves.toEqual({ routed: false });
    expect(unmappedSend).not.toHaveBeenCalled();

    const proactiveSend = vi.fn(async () => '623456789012345678');
    const proactive = makeGatewayHarness({
      channel: discordChannel,
      existingMapping: makeMapping({
        channel_id: discordChannel.id,
        thread_id: 'discord:message:323456789012345678:523456789012345678',
        metadata: { outbound_seed_id: 'seed-1' },
      }),
      connector: { sendMessage: proactiveSend },
    });
    (
      proactive.service as unknown as { deliveryRepo: { findByMessageId: () => Promise<null> } }
    ).deliveryRepo = { findByMessageId: async () => null };
    await expect(
      runWithTenantContext('tenant-channel', () =>
        proactive.service.routeMessage({
          session_id: 'sess-1',
          message: 'follow-up to seed',
        })
      )
    ).resolves.toEqual({ routed: true, channelType: 'discord' });
    expect(proactiveSend).toHaveBeenCalledOnce();
  });

  it('does not accumulate ordinary Discord response aliases after more than one hundred replies', async () => {
    const currentMapping = makeMapping({
      channel_id: discordChannel.id,
      thread_id: 'discord:message:323456789012345678:523456789012345678',
      metadata: {},
    });
    const sendMessage = vi.fn(async () => {
      const messageId = `${623456789012345678n + BigInt(sendMessage.mock.calls.length)}`;
      return {
        messageId,
        messageIds: [messageId],
        threadId: currentMapping.thread_id,
        replyAliases: [`discord:message:323456789012345678:${messageId}`],
        platformChannelId: '323456789012345678',
        platformThreadId: currentMapping.thread_id,
      };
    });
    const harness = makeGatewayHarness({
      channel: discordChannel,
      existingMapping: currentMapping,
      connector: { sendMessage },
    });
    harness.threadMapRepo.findByChannelAndThread.mockImplementation(
      async (_channelId: string, threadId: string) =>
        threadId === currentMapping.thread_id ? currentMapping : null
    );
    harness.threadMapRepo.findByChannel.mockImplementation(async () => [currentMapping]);
    harness.threadMapRepo.findBySession.mockImplementation(async () => currentMapping);
    for (let index = 0; index < 101; index += 1) {
      await harness.service.routeMessage({
        session_id: currentMapping.session_id,
        message: 'chunk',
      });
    }

    expect(currentMapping.metadata).not.toHaveProperty('gateway_reply_aliases');
    expect(currentMapping.metadata).not.toHaveProperty('gateway_last_message_id');
    expect(harness.threadMapRepo.mergeGatewayReplyAliases).not.toHaveBeenCalled();
  });

  it('keeps Discord proactive target resolution and seed audit in the service boundary', async () => {
    const sendDirectMessage = vi.fn(async (request: { target: string }) => ({
      messageId: '823456789012345678',
      messageIds: ['823456789012345678'],
      threadId: 'discord:message:323456789012345678:823456789012345678',
      replyAliases: ['discord:message:323456789012345678:823456789012345678'],
      platformChannelId: '323456789012345678',
      platformThreadId: 'discord:message:323456789012345678:823456789012345678',
      metadata: { target: request.target },
    }));
    const { service } = makeGatewayHarness({ channel: discordChannel });
    const outboundRepo = {
      create: vi.fn(async (data: Record<string, unknown>) => ({ id: 'out-discord', ...data })),
    };
    (service as unknown as { outboundRepo: unknown }).outboundRepo = outboundRepo;
    vi.mocked(getConnector).mockReturnValue({ sendDirectMessage } as never);

    const result = await service.emitMessage({
      gatewayChannelId: discordChannel.id,
      message: 'proactive update',
      emittedByUserId: user.user_id as UserID,
      userRole: 'admin',
    });

    expect(sendDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'channel:323456789012345678', text: 'proactive update' })
    );
    expect(outboundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_type: 'discord',
        platform_channel_id: '323456789012345678',
        metadata: expect.objectContaining({
          provider_reply_aliases: ['discord:message:323456789012345678:823456789012345678'],
        }),
      })
    );
    expect(result).toMatchObject({
      success: true,
      channel_type: 'discord',
      platform_thread_id: 'discord:message:323456789012345678:823456789012345678',
    });
  });

  it('rejects Discord threadTs proactive sends before connector admission', async () => {
    const { service } = makeGatewayHarness({ channel: discordChannel });
    vi.mocked(getConnector).mockReturnValue({ sendDirectMessage: vi.fn() } as never);

    await expect(
      service.emitMessage({
        gatewayChannelId: discordChannel.id,
        message: 'thread target is Slack-only',
        threadTs: 'discord:thread:323456789012345678:523456789012345678',
        emittedByUserId: user.user_id as UserID,
        userRole: 'admin',
      })
    ).rejects.toThrow('fresh channel:<snowflake> seed');
  });
});

describe('GatewayService outbound routing tenant scope', () => {
  it('defers after-hook routing until the current tenant transaction commits', async () => {
    const events: string[] = [];
    const tx = {
      execute: vi.fn(async () => []),
    };
    let resolveRouted!: () => void;
    const routed = new Promise<void>((resolve) => {
      resolveRouted = resolve;
    });
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        events.push('tx:start');
        const result = await callback(tx);
        events.push('tx:commit');
        return result;
      }),
    } as TenantScopeAwareDatabase;

    const seenTenants: Array<string | undefined> = [];
    const sendMessage = vi.fn(async () => {
      events.push('send');
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      seenTenants.push(getCurrentTenantId() as string | undefined);
      resolveRouted();
      return '104.000000';
    });

    const { service } = makeGatewayHarness({
      db,
      existingMapping: makeMapping(),
      connector: { sendMessage },
    });

    await runWithTenantDatabaseScope(db, 'tenant-channel', async () => {
      service.routeMessageAfterCommit(
        {
          session_id: 'sess-1',
          message: 'hello from agent',
        },
        { tenant: { tenant_id: 'tenant-channel' } }
      );
      events.push('scheduled');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    await routed;

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(seenTenants).toEqual(['tenant-channel']);
    expect(events.indexOf('tx:commit')).toBeLessThan(events.indexOf('send'));
  });
});

describe('GatewayService Slack progress tenant scope', () => {
  it('defers Slack assistant status updates until the current tenant transaction commits', async () => {
    const events: string[] = [];
    const tx = {
      execute: vi.fn(async () => []),
    };
    let resolveUpdated!: () => void;
    const updated = new Promise<void>((resolve) => {
      resolveUpdated = resolve;
    });
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        events.push('tx:start');
        const result = await callback(tx);
        events.push('tx:commit');
        return result;
      }),
    } as TenantScopeAwareDatabase;

    const seenTenants: Array<string | undefined> = [];
    const setThreadStatus = vi.fn(async () => {
      events.push('status');
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      seenTenants.push(getCurrentTenantId() as string | undefined);
      resolveUpdated();
    });

    const { service } = makeGatewayHarness({
      db,
      existingMapping: makeMapping(),
      connector: { setThreadStatus },
    });

    await runWithTenantDatabaseScope(db, 'tenant-channel', async () => {
      service.updateProgressAfterCommit(
        {
          session_id: 'sess-1',
          state: 'working',
          task_id: 'task-1',
          tool_name: 'Read',
        },
        { tenant: { tenant_id: 'tenant-channel' } }
      );
      events.push('scheduled');
      expect(setThreadStatus).not.toHaveBeenCalled();
    });

    await updated;

    expect(setThreadStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'C123-100.000000',
        status: 'is using Read.',
      })
    );
    expect(seenTenants).toEqual(['tenant-channel']);
    expect(events.indexOf('tx:commit')).toBeLessThan(events.indexOf('status'));
  });
});

describe('GatewayService Slack streaming', () => {
  it('does not stream assistant chunks into channel-like Slack threads', async () => {
    const startStream = vi.fn(async () => '104.000000');
    const appendStream = vi.fn(async () => undefined);
    const mapping = makeMapping({
      metadata: {
        slack_active_thread_id: 'C123-100.000000',
        slack_user_id: 'U1',
        slack_team_id: 'T1',
      },
    });
    const { service } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { startStream, appendStream },
    });

    await service.handleMessageStreamingEvent('streaming:start', {
      session_id: 'sess-1',
      message_id: 'msg-1',
      task_id: 'task-1',
    });
    await service.handleMessageStreamingEvent('streaming:chunk', {
      session_id: 'sess-1',
      message_id: 'msg-1',
      task_id: 'task-1',
      chunk: 'hello channel',
    });

    expect(startStream).not.toHaveBeenCalled();
    expect(appendStream).not.toHaveBeenCalled();
    expect(service.wasTaskStreamedToSlack?.('task-1')).toBe(false);
  });

  it('keeps streaming enabled for Slack DMs', async () => {
    const startStream = vi.fn(async () => '104.000000');
    const appendStream = vi.fn(async () => undefined);
    const mapping = makeMapping({
      thread_id: 'D123-100.000000',
      metadata: { slack_active_thread_id: 'D123-100.000000' },
    });
    const { service } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { startStream, appendStream },
    });

    await service.handleMessageStreamingEvent('streaming:start', {
      session_id: 'sess-1',
      message_id: 'msg-1',
      task_id: 'task-1',
    });
    await service.handleMessageStreamingEvent('streaming:chunk', {
      session_id: 'sess-1',
      message_id: 'msg-1',
      task_id: 'task-1',
      chunk: 'hello dm',
    });

    expect(startStream).toHaveBeenCalledWith({
      threadId: 'D123-100.000000',
      text: 'hello dm',
      recipientUserId: undefined,
      recipientTeamId: undefined,
    });
    expect(service.wasTaskStreamedToSlack?.('task-1')).toBe(true);
  });
});

describe('GatewayService outbound emit session branch binding', () => {
  const outboundChannel: GatewayChannel = {
    ...slackChannel,
    id: 'chan-outbound',
    config: {
      bot_token: 'xoxb-test',
      outbound_enabled: true,
      default_outbound_target: 'channel:C123',
    },
  } as unknown as GatewayChannel;

  function makeEmitHarness(args: { session?: { session_id: string; branch_id: string } | null }) {
    const { service } = makeGatewayHarness({ channel: outboundChannel });
    const sendSlackMessage = vi.fn(async () => ({
      ts: '200.000100',
      channel: 'C123',
      thread_ts: '200.000100',
      permalink: null,
    }));
    const sendDirectMessage = vi.fn(
      async (req: { target: string; text: string; threadId?: string }) => {
        const sent = await sendSlackMessage({
          channel: req.target.replace(/^channel:/, ''),
          text: req.text,
          ...(req.threadId ? { thread_ts: req.threadId } : {}),
        });
        return {
          messageId: sent.ts,
          platformChannelId: sent.channel,
          platformThreadId: `${sent.channel}-${sent.thread_ts}`,
          permalink: sent.permalink,
        };
      }
    );
    vi.mocked(getConnector).mockReturnValue({ sendSlackMessage, sendDirectMessage } as never);
    const outboundRepo = {
      create: vi.fn(async (data: Record<string, unknown>) => ({ id: 'out-1', ...data })),
      admitReplySession: vi.fn(async () => null),
      completeReplyAdmission: vi.fn(async () => undefined),
    };
    const sessionRepo = { findById: vi.fn(async () => args.session ?? null) };
    const branchRepo = {
      findById: vi.fn(async () => ({
        branch_id: outboundChannel.target_branch_id,
        others_can: 'view',
      })),
      isOwner: vi.fn(async () => false),
      resolveUserPermission: vi.fn(async () => 'view'),
    };
    (service as unknown as { outboundRepo: unknown }).outboundRepo = outboundRepo;
    (service as unknown as { sessionRepo: unknown }).sessionRepo = sessionRepo;
    (service as unknown as { branchRepo: unknown }).branchRepo = branchRepo;
    return { service, sendSlackMessage, outboundRepo, sessionRepo, branchRepo };
  }

  type EmitData = Parameters<GatewayService['emitMessage']>[0];

  function emitData(overrides: Partial<EmitData> = {}): EmitData {
    return {
      gatewayChannelId: 'chan-outbound',
      message: 'ship update',
      emittedByUserId: 'user-1' as UserID,
      userRole: 'admin',
      ...overrides,
    };
  }

  it('allows a same-branch session emit and keeps session attribution on the audit row', async () => {
    const { service, sendSlackMessage, outboundRepo } = makeEmitHarness({
      session: { session_id: 'sess-1', branch_id: 'branch-1' },
    });

    const result = await service.emitMessage(
      emitData({ emittedBySessionId: 'sess-1' as SessionID })
    );

    expect(result).toMatchObject({
      success: true,
      gateway_outbound_message_id: 'out-1',
      gateway_channel_id: 'chan-outbound',
    });
    expect(sendSlackMessage).toHaveBeenCalledTimes(1);
    expect(outboundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ emitted_by_session_id: 'sess-1' })
    );
  });

  it('denies a cross-branch session emit even with admin role, before any Slack send', async () => {
    const { service, sendSlackMessage, outboundRepo, sessionRepo } = makeEmitHarness({
      session: { session_id: 'sess-1', branch_id: 'branch-2' },
    });

    await expect(
      service.emitMessage(emitData({ emittedBySessionId: 'sess-1' as SessionID }))
    ).rejects.toThrow(/Gateway outbound denied/);
    expect(sessionRepo.findById).toHaveBeenCalledWith('sess-1');
    expect(sendSlackMessage).not.toHaveBeenCalled();
    expect(outboundRepo.create).not.toHaveBeenCalled();
  });

  it('names the session branch but never the channel target branch in the denial', async () => {
    const { service } = makeEmitHarness({
      session: { session_id: 'sess-1', branch_id: 'branch-2' },
    });

    const error: Error = await service
      .emitMessage(emitData({ emittedBySessionId: 'sess-1' as SessionID }))
      .then(() => {
        throw new Error('expected emit to be denied');
      })
      .catch((err: Error) => err);

    expect(error.message).toContain(shortId('sess-1'));
    expect(error.message).toContain(shortId('branch-2'));
    expect(error.message).not.toContain(outboundChannel.target_branch_id);
    expect(error.message).not.toContain(shortId(outboundChannel.target_branch_id));
  });

  it('fails closed when the emitting session cannot be found', async () => {
    const { service, sendSlackMessage, outboundRepo } = makeEmitHarness({ session: null });

    await expect(
      service.emitMessage(emitData({ emittedBySessionId: 'sess-gone' as SessionID }))
    ).rejects.toThrow('Gateway outbound denied: emitting session not found');
    expect(sendSlackMessage).not.toHaveBeenCalled();
    expect(outboundRepo.create).not.toHaveBeenCalled();
  });

  it('keeps admin access for calls without session context', async () => {
    const { service, sendSlackMessage, sessionRepo } = makeEmitHarness({});

    const result = await service.emitMessage(emitData());

    expect(result).toMatchObject({ success: true });
    expect(sessionRepo.findById).not.toHaveBeenCalled();
    expect(sendSlackMessage).toHaveBeenCalledTimes(1);
  });

  it('denies no-session members without branch all permission', async () => {
    const { service, sendSlackMessage, branchRepo } = makeEmitHarness({});

    await expect(service.emitMessage(emitData({ userRole: 'member' }))).rejects.toThrow(
      'Insufficient branch permission'
    );
    expect(branchRepo.resolveUserPermission).toHaveBeenCalled();
    expect(sendSlackMessage).not.toHaveBeenCalled();
  });

  it('plumbs threadTs through to the connector as thread_ts', async () => {
    const { service, sendSlackMessage } = makeEmitHarness({});

    await service.emitMessage(emitData({ threadTs: '171234.000100' }));

    expect(sendSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '171234.000100' })
    );
  });

  it('omits thread_ts from the connector call when threadTs is not provided', async () => {
    const { service, sendSlackMessage } = makeEmitHarness({});

    await service.emitMessage(emitData());

    expect(sendSlackMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ thread_ts: expect.anything() })
    );
  });
});

describe('GatewayService outbound emit allowed_channel_ids enforcement', () => {
  function makeAllowlistHarness(
    args: { config?: Record<string, unknown>; connectorExtras?: Record<string, unknown> } = {}
  ) {
    const channel = {
      ...slackChannel,
      id: 'chan-outbound',
      config: {
        bot_token: 'xoxb-test',
        outbound_enabled: true,
        ...args.config,
      },
    } as unknown as GatewayChannel;
    const { service } = makeGatewayHarness({ channel });
    const sendSlackMessage = vi.fn(async (req: { channel: string }) => ({
      ts: '200.000100',
      channel: req.channel,
      thread_ts: '200.000100',
      permalink: null,
    }));
    const sendDirectMessage = vi.fn(
      async (req: { target: string; text: string; threadId?: string }) => {
        let channel = req.target.replace(/^channel:/, '');
        if (req.target.startsWith('#')) {
          const resolved = await args.connectorExtras?.resolveChannelByName?.(req.target.slice(1));
          channel = resolved?.channel ?? channel;
        } else if (req.target.includes('@')) {
          const resolved = await args.connectorExtras?.openDmByEmail?.(req.target);
          channel = resolved?.channel ?? channel;
        }
        const allowed = args.config?.allowed_channel_ids;
        if (Array.isArray(allowed) && !channel.startsWith('D') && !allowed.includes(channel)) {
          throw new Error(`target resolves to ${channel}; allowed_channel_ids whitelist denied it`);
        }
        const sent = await sendSlackMessage({
          channel,
          text: req.text,
          ...(req.threadId ? { thread_ts: req.threadId } : {}),
        });
        return {
          messageId: sent.ts,
          platformChannelId: sent.channel,
          platformThreadId: `${sent.channel}-${sent.thread_ts}`,
          permalink: sent.permalink,
        };
      }
    );
    vi.mocked(getConnector).mockReturnValue({
      sendSlackMessage,
      sendDirectMessage,
      ...args.connectorExtras,
    } as never);
    const outboundRepo = {
      create: vi.fn(async (data: Record<string, unknown>) => ({ id: 'out-1', ...data })),
      admitReplySession: vi.fn(async () => null),
      completeReplyAdmission: vi.fn(async () => undefined),
    };
    (service as unknown as { outboundRepo: unknown }).outboundRepo = outboundRepo;
    return { service, sendSlackMessage, outboundRepo };
  }

  type EmitData = Parameters<GatewayService['emitMessage']>[0];

  function emitData(overrides: Partial<EmitData> = {}): EmitData {
    return {
      gatewayChannelId: 'chan-outbound',
      message: 'ship update',
      emittedByUserId: 'user-1' as UserID,
      userRole: 'admin',
      ...overrides,
    };
  }

  it('denies a channel-id target outside the allowlist before any Slack send', async () => {
    const { service, sendSlackMessage, outboundRepo } = makeAllowlistHarness({
      config: { allowed_channel_ids: ['C123'] },
    });

    await expect(service.emitMessage(emitData({ target: 'channel:C999' }))).rejects.toThrow(
      /provider_request_failed/
    );
    expect(sendSlackMessage).not.toHaveBeenCalled();
    expect(outboundRepo.create).not.toHaveBeenCalled();
  });

  it('denies a channel-name target that resolves to an id outside the allowlist', async () => {
    const resolveChannelByName = vi.fn(async () => ({ channel: 'C999', name: 'general' }));
    const { service, sendSlackMessage } = makeAllowlistHarness({
      config: { allowed_channel_ids: ['C123'] },
      connectorExtras: { resolveChannelByName },
    });

    await expect(service.emitMessage(emitData({ target: '#general' }))).rejects.toThrow(
      /provider_request_failed/
    );
    expect(resolveChannelByName).toHaveBeenCalledWith('general');
    expect(sendSlackMessage).not.toHaveBeenCalled();
  });

  it('does not expose provider-authored text from proactive outbound failures', async () => {
    const canary = 'private-user@example.test workspace-secret-label';
    const sendDirectMessage = vi.fn(async () => Promise.reject(new Error(canary)));
    const { service } = makeAllowlistHarness({ connectorExtras: { sendDirectMessage } });

    const failure = await service
      .emitMessage(emitData({ target: 'channel:C123' }))
      .catch((error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Slack API failure: provider_request_failed');
    expect(failure.message).not.toMatch(/private-user|workspace/);
  });

  it('allows an email target resolved to a DM even with an allowlist configured', async () => {
    const openDmByEmail = vi.fn(async () => ({ channel: 'D777', user_id: 'U42' }));
    const { service, sendSlackMessage } = makeAllowlistHarness({
      config: { allowed_channel_ids: ['C123'] },
      connectorExtras: { openDmByEmail },
    });

    const result = await service.emitMessage(emitData({ target: 'user@example.com' }));

    expect(result).toMatchObject({ success: true, platform_channel_id: 'D777' });
    expect(openDmByEmail).toHaveBeenCalledWith('user@example.com');
    expect(sendSlackMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'D777' }));
  });

  it('allows an allowlisted channel target', async () => {
    const { service, sendSlackMessage } = makeAllowlistHarness({
      config: { allowed_channel_ids: ['C123'] },
    });

    const result = await service.emitMessage(emitData({ target: 'channel:C123' }));

    expect(result).toMatchObject({ success: true, platform_channel_id: 'C123' });
    expect(sendSlackMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C123' }));
  });

  it('allows any channel target when no allowlist is configured', async () => {
    const { service, sendSlackMessage } = makeAllowlistHarness();

    const result = await service.emitMessage(emitData({ target: 'channel:C999' }));

    expect(result).toMatchObject({ success: true, platform_channel_id: 'C999' });
    expect(sendSlackMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C999' }));
  });
});

describe('GatewayService Slack attachment ingestion', () => {
  const ingestChannel = {
    ...slackChannel,
    config: { bot_token: 'xoxb-test', ingest_files: true },
  } as GatewayChannel;

  const inboundFiles = [
    {
      id: 'F123',
      name: 'screenshot.png',
      mimetype: 'image/png',
      size: 2048,
      url_private_download: 'https://files.slack.com/files-pri/T1-F123/download/screenshot.png',
    },
  ];

  const dmMetadata = {
    channel: 'D123',
    channel_type: 'im',
    slack_message_ts: '103.000000',
  };

  it('downloads image attachments and folds the stored paths into the prompt', async () => {
    vi.mocked(ingestInboundAttachments).mockResolvedValue({
      uploads: [
        {
          ref: 'upl_00000000-0000-4000-8000-000000000001',
          name: 'screenshot.png',
          mimeType: 'image/png',
          size: 2048,
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-02T00:00:00.000Z',
          provenance: 'gateway-slack',
        },
      ],
      failed: 0,
    });
    const { service, promptCreate } = makeGatewayHarness({
      channel: ingestChannel,
      existingMapping: makeMapping({ thread_id: 'D123-100.000000' }),
      connector: {},
    });

    const result = await runWithTenantContext('tenant-channel', () =>
      service.create({
        channel_key: 'slack-key',
        thread_id: 'D123-100.000000',
        text: 'what does this screenshot show?',
        files: inboundFiles,
        metadata: dmMetadata,
      })
    );

    expect(result).toMatchObject({ success: true, sessionId: 'sess-1' });
    expect(ingestInboundAttachments).toHaveBeenCalledWith({
      files: inboundFiles,
      botToken: 'xoxb-test',
      tenantId: 'tenant-channel',
      sessionId: 'sess-1',
      branchId: 'branch-1',
      createdBy: 'user-1',
    });
    const prompt = promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('upl_00000000-0000-4000-8000-000000000001');
    expect(prompt).toContain('what does this screenshot show?');
    expect(prompt).not.toContain('an attachment could not be fetched');
  });

  it('never attempts downloads when the channel does not enable ingest_files', async () => {
    const { service, promptCreate } = makeGatewayHarness({
      existingMapping: makeMapping({ thread_id: 'D123-100.000000' }),
      connector: {},
    });

    await service.create({
      channel_key: 'slack-key',
      thread_id: 'D123-100.000000',
      text: 'what does this screenshot show?',
      files: inboundFiles,
      metadata: dmMetadata,
    });

    expect(ingestInboundAttachments).not.toHaveBeenCalled();
    const prompt = promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('what does this screenshot show?');
    expect(prompt).not.toContain('Attached files:');
  });

  it('delivers the prompt with a degradation note when downloads fail', async () => {
    vi.mocked(ingestInboundAttachments).mockResolvedValue({ uploads: [], failed: 1 });
    const { service, promptCreate } = makeGatewayHarness({
      channel: ingestChannel,
      existingMapping: makeMapping({ thread_id: 'D123-100.000000' }),
      connector: {},
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'D123-100.000000',
      text: 'what does this screenshot show?',
      files: inboundFiles,
      metadata: dmMetadata,
    });

    expect(result).toMatchObject({ success: true, sessionId: 'sess-1' });
    const prompt = promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('what does this screenshot show?');
    expect(prompt).toContain('(an attachment could not be fetched)');
    expect(prompt).not.toContain('Attached files:');
  });

  it('folds successful paths and appends the note when only some downloads fail', async () => {
    vi.mocked(ingestInboundAttachments).mockResolvedValue({
      uploads: [
        {
          ref: 'upl_00000000-0000-4000-8000-000000000002',
          name: 'ok.png',
          mimeType: 'image/png',
          size: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-02T00:00:00.000Z',
          provenance: 'gateway-slack',
        },
      ],
      failed: 1,
    });
    const { service, promptCreate } = makeGatewayHarness({
      channel: ingestChannel,
      existingMapping: makeMapping({ thread_id: 'D123-100.000000' }),
      connector: {},
    });

    await service.create({
      channel_key: 'slack-key',
      thread_id: 'D123-100.000000',
      text: 'compare these',
      files: inboundFiles,
      metadata: dmMetadata,
    });

    const prompt = promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('upl_00000000-0000-4000-8000-000000000002');
    expect(prompt).toContain('(an attachment could not be fetched)');
  });
});

describe('GatewayService inbound create without ambient tenant DB scope', () => {
  // Socket Mode listener messages enter through runWithTenantContext (tenant
  // identity only) — unlike HTTP requests, no ambient tenant DB scope is open.
  // Regression: #1890 made agent resolution throw
  // 'Missing tenant database scope for gateway agent resolution' on this path,
  // breaking all inbound Slack messages.
  it('processes a Slack listener message with tenant identity only', async () => {
    const materializationScopes: unknown[] = [];
    vi.mocked(materializeAgenticToolConfiguration).mockImplementationOnce(async (tenantDb) => {
      const scope = getCurrentTenantDatabaseScope();
      materializationScopes.push(scope);
      expect(tenantDb).toBe(scope?.db);
      return {
        agentic_tool_preset_id: null,
        permission_config: { mode: 'default' },
        model_config: null,
      };
    });
    const fetchThreadHistory = vi.fn(async () => ({ has_more: false, messages: [] }));
    const { createUnscoped, promptCreate } = makeGatewayHarness({
      existingMapping: makeMapping(),
      connector: { fetchThreadHistory, sendMessage: vi.fn(async () => undefined) },
    });

    const result = await runWithTenantContext('tenant-channel', () =>
      createUnscoped({
        channel_key: 'slack-key',
        thread_id: 'C123-100.000000',
        text: 'please answer',
        metadata: {
          channel: 'C123',
          channel_type: 'channel',
          slack_has_mention: true,
          slack_message_ts: '103.000000',
          slack_thread_ts: '100.000000',
        },
      })
    );

    expect(getCurrentTenantDatabaseScope()).toBeUndefined();
    expect(materializationScopes).toEqual([
      expect.objectContaining({ kind: 'tenant', tenantId: 'tenant-channel' }),
    ]);
    expect(result).toMatchObject({ success: true, sessionId: 'sess-1', created: false });
    expect(promptCreate).toHaveBeenCalled();
  });

  it('rejects materialization through a retained foreign tenant scope', async () => {
    const db = { run: vi.fn() } as unknown as TenantScopeAwareDatabase;
    const { createUnscoped } = makeGatewayHarness({
      db,
      existingMapping: makeMapping(),
      connector: {
        fetchThreadHistory: vi.fn(async () => ({ has_more: false, messages: [] })),
        sendMessage: vi.fn(async () => undefined),
      },
    });

    await expect(
      runWithTenantDatabaseScope(db, 'tenant-a', () =>
        runWithTenantContext('tenant-b', () =>
          createUnscoped({
            channel_key: 'slack-key',
            thread_id: 'C123-100.000000',
            text: 'please answer',
            metadata: {
              channel: 'C123',
              channel_type: 'channel',
              slack_has_mention: true,
              slack_message_ts: '103.000000',
              slack_thread_ts: '100.000000',
            },
          })
        )
      )
    ).rejects.toThrow('Cannot enter tenant scope tenant-b from active tenant scope tenant-a');
    expect(materializeAgenticToolConfiguration).not.toHaveBeenCalled();
  });
});
