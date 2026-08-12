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
import type { GatewayChannel, SessionID, ThreadSessionMap, User, UserID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestInboundAttachments } from '../utils/gateway-attachments.js';
import { GatewayService, tenantIdFromGatewayChannel } from './gateway.js';
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
    getConnector: vi.fn(),
  };
});

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    assertInlineAgenticConfigurationAllowed: vi.fn(async () => undefined),
    getBaseUrl: vi.fn(async () => 'https://agor.example.com'),
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
  const threadMapRepo = {
    findByChannelAndThread: vi.fn(async () => mapping),
    findByChannel: vi.fn(async () => []),
    findByThread: vi.fn(async () => null),
    findBySession: vi.fn(async () => mapping),
    updateLastMessage: vi.fn(async () => undefined),
    updateMetadata: vi.fn(async (_id: string, metadata: Record<string, unknown>) => {
      if (mapping) mapping = { ...mapping, metadata } as ThreadSessionMap;
    }),
    findById: vi.fn(async () => mapping),
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
  (service as unknown as { channelRepo: typeof channelRepo }).channelRepo = channelRepo;
  (service as unknown as { threadMapRepo: typeof threadMapRepo }).threadMapRepo = threadMapRepo;
  (
    service as unknown as {
      usersRepo: { findByEmailForAlignment: typeof findByEmailForAlignment };
    }
  ).usersRepo = { findByEmailForAlignment };
  (
    service as unknown as { outboundRepo: { findUnconsumedByChannelAndThread: unknown } }
  ).outboundRepo = {
    findUnconsumedByChannelAndThread: vi.fn(async () => null),
  };
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
    threadMapRepo,
    findByEmailForAlignment,
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
  it('leaves MCP authentication notices to the common executor launch path', async () => {
    const channel = {
      ...slackChannel,
      mcp_server_ids: ['oauth-server'],
    } as GatewayChannel;
    const { service, promptCreate } = makeGatewayHarness({ channel, connector: {} });
    (
      service as unknown as {
        mcpServerRepo: { findById: (id: string) => Promise<unknown> };
        userTokenRepo: { getToken: () => Promise<null> };
      }
    ).mcpServerRepo = {
      findById: vi.fn(async () => ({
        mcp_server_id: 'oauth-server',
        name: 'OAuth server',
        auth: { type: 'oauth', oauth_mode: 'per_user' },
      })),
    };
    (service as unknown as { userTokenRepo: { getToken: () => Promise<null> } }).userTokenRepo = {
      getToken: vi.fn(async () => null),
    };

    await service.create({
      channel_key: channel.channel_key,
      thread_id: 'C123-100.000000',
      text: 'please answer',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '103.000000',
      },
    });

    const [promptData, promptParams] = promptCreate.mock.calls[0];
    const prompt = promptData.prompt as string;
    expect(prompt).not.toContain('[System notice:');
    expect(prompt).not.toContain('[Agor runtime context]');
    expect(promptData.messageSource).toBe('gateway');
    expect(promptParams).toMatchObject({
      user,
      tenant: { tenant_id: 'tenant-channel', source: 'explicit' },
    });
  });

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
    expect(warn).toHaveBeenCalledWith(
      '[gateway] Failed to fetch Slack thread catch-up context:',
      expect.any(Error)
    );
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

describe('GatewayService durable listener delivery fences', () => {
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
    const mapping = makeMapping();
    const { service, promptCreate, sessionsCreate } = makeGatewayHarness({
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
    expect(promptCreate).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
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
    vi.mocked(getConnector).mockReturnValue({ sendSlackMessage } as never);
    const outboundRepo = {
      create: vi.fn(async (data: Record<string, unknown>) => ({ id: 'out-1', ...data })),
      findUnconsumedByChannelAndThread: vi.fn(async () => null),
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
    vi.mocked(getConnector).mockReturnValue({
      sendSlackMessage,
      ...args.connectorExtras,
    } as never);
    const outboundRepo = {
      create: vi.fn(async (data: Record<string, unknown>) => ({ id: 'out-1', ...data })),
      findUnconsumedByChannelAndThread: vi.fn(async () => null),
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
      /allowed_channel_ids/
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
      /allowed_channel_ids/
    );
    expect(resolveChannelByName).toHaveBeenCalledWith('general');
    expect(sendSlackMessage).not.toHaveBeenCalled();
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
