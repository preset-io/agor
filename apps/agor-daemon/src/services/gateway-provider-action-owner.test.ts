import { Readable } from 'node:stream';
import { runWithTenantContext } from '@agor/core/db';
import {
  createDiscordDeliveryPlan,
  DiscordNonceRecoveryIncompleteError,
  discordMessageNonce,
  discordNonceRecoveryWindowFromTimes,
  discordRoutingNoticeNonceSeed,
  getConnector,
  renderDiscordRoutingNotice,
} from '@agor/core/gateway';
import type {
  GatewayChannel,
  GatewayProviderAction,
  Message,
  Session,
  Task,
  ThreadSessionMap,
  UploadMetadata,
  UploadReadInput,
  UploadStageInput,
  UploadStagingStore,
} from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureUploadStagingStore,
  resetUploadStagingStoreForTests,
} from '../utils/upload-staging.js';
import { stageDiscordThreadHistorySnapshot } from './discord-thread-history-rpc.js';
import { GatewayService } from './gateway.js';

vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return { ...actual, getConnector: vi.fn() };
});

const ids = {
  channel: '01927f9d-1000-7000-8000-000000000001',
  mapping: '01927f9d-1000-7000-8000-000000000002',
  session: '01927f9d-1000-7000-8000-000000000003',
  task: '01927f9d-1000-7000-8000-000000000004',
  taskB: '01927f9d-1000-7000-8000-000000000009',
  message: '01927f9d-1000-7000-8000-000000000005',
  action: '01927f9d-1000-7000-8000-000000000006',
  actionB: '01927f9d-1000-7000-8000-00000000000a',
  inboundEvent: '01927f9d-1000-7000-8000-00000000000b',
  branch: '01927f9d-1000-7000-8000-000000000007',
} as const;

function recoverableSend(sendMessage: ReturnType<typeof vi.fn>) {
  return vi.fn(
    async (
      request: { threadId: string; text: string; metadata?: Record<string, unknown> },
      options?: { beforeProviderCall?: () => Promise<void> }
    ) => {
      await options?.beforeProviderCall?.();
      return sendMessage(request);
    }
  );
}

const channel = {
  id: ids.channel,
  name: 'Discord',
  channel_type: 'discord',
  channel_key: 'discord-key',
  enabled: true,
  provider_installation_id: '223456789012345678',
  provider_config_generation: 3,
  target_branch_id: ids.branch,
  agor_user_id: null,
  config: {
    bot_token: 'discord-test-token',
    application_id: '223456789012345678',
    guild_id: '323456789012345678',
    allowed_channel_ids: ['423456789012345678'],
    align_discord_users: true,
    user_map: {
      '523456789012345678': '01927f9d-1000-7000-8000-000000000008',
    },
  },
  agentic_config: null,
  created_by: '01927f9d-1000-7000-8000-000000000008',
  created_at: '2026-08-18T00:00:00.000Z',
  updated_at: '2026-08-18T00:00:00.000Z',
  last_message_at: null,
} as unknown as GatewayChannel;

const mapping = {
  id: ids.mapping,
  channel_id: ids.channel,
  thread_id: 'discord:823456789012345678',
  session_id: ids.session,
  branch_id: ids.branch,
  status: 'active',
  metadata: {
    discord_application_id: '223456789012345678',
    discord_guild_id: '323456789012345678',
    discord_parent_channel_id: '423456789012345678',
    discord_message_id: '623456789012345678',
    discord_last_summon_message_id: '823456789012345678',
    discord_last_delivered_message_id: '823456789012345678',
  },
  created_at: '2026-08-18T00:00:00.000Z',
  last_message_at: '2026-08-18T00:00:00.000Z',
} as unknown as ThreadSessionMap;

const session = {
  session_id: ids.session,
  branch_id: ids.branch,
  created_by: '01927f9d-1000-7000-8000-000000000008',
} as Session;

const task = {
  task_id: ids.task,
  session_id: ids.session,
  status: 'running',
  created_at: '2026-08-18T00:00:00.000Z',
} as Task;

const message = {
  message_id: ids.message,
  session_id: ids.session,
  task_id: ids.task,
  role: 'assistant',
  type: 'assistant',
  index: 1,
  timestamp: '2026-08-18T00:00:00.000Z',
  content_preview: 'canonical answer',
  content: 'canonical answer',
} as Message;

function providerAction(overrides: Partial<GatewayProviderAction> = {}): GatewayProviderAction {
  return {
    id: ids.action as never,
    gateway_channel_id: ids.channel as never,
    channel_type: 'discord',
    provider_installation_id: channel.provider_installation_id!,
    provider_config_generation: channel.provider_config_generation,
    kind: 'deliver_message',
    idempotency_key: `deliver_message:${ids.message}:create`,
    thread_session_map_id: ids.mapping as never,
    session_id: ids.session as never,
    task_id: ids.task as never,
    message_id: ids.message as never,
    gateway_inbound_event_id: null,
    params: { operation: 'create' },
    status: 'processing',
    attempts: 1,
    not_before: '2026-08-18T00:00:00.000Z',
    drop_after: null,
    claim_token: 'action-a',
    claim_generation: 1,
    claim_expires_at: '2099-01-01T00:00:00.000Z',
    claim_listener_token: 'listener-a',
    claim_listener_generation: 1,
    claim_instance_id: 'daemon-a',
    claim_boot_id: 'boot-a',
    last_error_code: null,
    execution_metadata: null,
    result_metadata: null,
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
    completed_at: null,
    dead_lettered_at: null,
    canceled_at: null,
    ...overrides,
  };
}

function progressAction(overrides: Partial<GatewayProviderAction> = {}): GatewayProviderAction {
  return providerAction({
    kind: 'discord_progress',
    idempotency_key: `discord_progress:${ids.mapping}:${ids.task}`,
    message_id: null,
    params: { state: 'working', revision: 1, tool_name: 'Grep' },
    drop_after: '2099-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function noticeAction(overrides: Partial<GatewayProviderAction> = {}): GatewayProviderAction {
  return providerAction({
    kind: 'discord_notice',
    idempotency_key: `discord_notice:${ids.inboundEvent}:routing`,
    thread_session_map_id: null,
    session_id: null,
    task_id: null,
    message_id: null,
    gateway_inbound_event_id: ids.inboundEvent as never,
    params: { notice_code: 'alignment_missing' },
    drop_after: '2099-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function historyAction(overrides: Partial<GatewayProviderAction> = {}): GatewayProviderAction {
  return providerAction({
    kind: 'discord_thread_history',
    idempotency_key: `discord_thread_history:${ids.action}`,
    task_id: null,
    message_id: null,
    gateway_inbound_event_id: null,
    params: {
      request_id: ids.action,
      initial_message_id: '623456789012345678',
      through_message_id: '823456789012345678',
      limit: 50,
    },
    drop_after: '2099-01-01T00:00:00.000Z',
    ...overrides,
  });
}

class HistoryMemoryStore implements UploadStagingStore {
  bytes?: Buffer;
  metadata?: UploadMetadata;
  owner?: UploadStageInput['owner'];
  consume = vi.fn(async () => {
    this.bytes = undefined;
    this.metadata = undefined;
  });
  delete = vi.fn(async () => {
    this.bytes = undefined;
    this.metadata = undefined;
  });

  async stage(input: UploadStageInput): Promise<UploadMetadata> {
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    this.bytes = Buffer.concat(chunks);
    this.owner = input.owner;
    this.metadata = {
      ref: 'upl_00000000-0000-4000-8000-000000000099' as never,
      name: input.name,
      mimeType: input.mimeType,
      size: this.bytes.byteLength,
      createdAt: '2026-08-18T00:00:00.000Z',
      expiresAt: '2026-08-18T00:02:00.000Z',
      provenance: input.provenance,
    };
    return this.metadata;
  }

  private authorize(input: UploadReadInput): void {
    if (
      !this.owner ||
      input.tenantId !== this.owner.tenantId ||
      input.sessionId !== this.owner.sessionId ||
      input.branchId !== this.owner.branchId ||
      input.ref !== this.metadata?.ref
    ) {
      throw new Error('Upload not found');
    }
  }

  async inspect(input: UploadReadInput): Promise<UploadMetadata> {
    this.authorize(input);
    return this.metadata!;
  }

  async read(input: UploadReadInput): Promise<NodeJS.ReadableStream> {
    this.authorize(input);
    return Readable.from(this.bytes!);
  }

  async cleanupExpired(): Promise<number> {
    return 0;
  }
}

function serviceHarness() {
  const service = new GatewayService(
    { run: vi.fn() } as never,
    { service: vi.fn(), get: vi.fn() } as never
  );
  let enqueueCount = 0;
  const enqueue = vi.fn(async () => ({
    outcome: enqueueCount++ === 0 ? 'enqueued' : 'duplicate',
    action: providerAction(),
  }));
  const admitProviderCall = vi.fn(async () => providerAction());
  const updateDiscordProgressHandle = vi.fn(async () => 'updated');
  const armDiscordProgressCreate = vi.fn(async () => 'updated');
  const settleDiscordProgressCleanupDebt = vi.fn(async () => 'updated');
  const recordDiscordProgressCleanupDebt = vi.fn(async () => 'updated');
  const prepareDiscordProgressCleanup = vi.fn(async () => 'superseded');
  const initializeDiscordDelivery = vi.fn(async (input: { metadata: Record<string, unknown> }) => ({
    outcome: 'initialized' as const,
    metadata: input.metadata,
  }));
  const recordDiscordDeliveryChunk = vi.fn(
    async (input: {
      expectedMetadata: { chunks: Array<Record<string, unknown>> };
      chunkIndex: number;
      providerMessageId: string;
    }) => ({
      outcome: 'recorded' as const,
      metadata: {
        ...input.expectedMetadata,
        chunks: input.expectedMetadata.chunks.map((chunk, index) =>
          index === input.chunkIndex
            ? { ...chunk, provider_message_id: input.providerMessageId }
            : chunk
        ),
      },
    })
  );
  const wake = vi.fn();
  const listenerClaimIsCurrent = vi.fn(async () => true);
  const countActiveDiscordProgress = vi.fn(async () => 2);
  Object.assign(service as unknown as Record<string, unknown>, {
    durableListenerOwnership: true,
    runtimeProviderGate: () => true,
    channelRepo: {
      findById: vi.fn(async () => channel),
      listenerClaimIsCurrent,
      updateLastMessage: vi.fn(async () => undefined),
    },
    threadMapRepo: {
      findBySession: vi.fn(async () => mapping),
      findActiveBySessionBounded: vi.fn(async () => [mapping]),
      findById: vi.fn(async () => mapping),
      updateLastMessage: vi.fn(async () => undefined),
      countActiveDiscordProgress,
    },
    sessionRepo: { findById: vi.fn(async () => session) },
    taskRepo: { findById: vi.fn(async () => task) },
    messagesRepo: { findById: vi.fn(async () => message) },
    providerActionRepo: {
      enqueue,
      findById: vi.fn(async () => providerAction()),
      admitProviderCall,
      updateDiscordProgressHandle,
      armDiscordProgressCreate,
      settleDiscordProgressCleanupDebt,
      recordDiscordProgressCleanupDebt,
      prepareDiscordProgressCleanup,
      initializeDiscordDelivery,
      recordDiscordDeliveryChunk,
    },
    providerActionProcessor: { wake },
  });
  return {
    service,
    enqueue,
    admitProviderCall,
    updateDiscordProgressHandle,
    armDiscordProgressCreate,
    settleDiscordProgressCleanupDebt,
    recordDiscordProgressCleanupDebt,
    prepareDiscordProgressCleanup,
    initializeDiscordDelivery,
    recordDiscordDeliveryChunk,
    wake,
    listenerClaimIsCurrent,
    countActiveDiscordProgress,
  };
}

function executeOwnedAction(
  service: GatewayService,
  action: GatewayProviderAction,
  token: string,
  owner: { listenerClaimToken: string; listenerGeneration: number } = {
    listenerClaimToken: 'listener-a',
    listenerGeneration: 1,
  }
) {
  return runWithTenantContext('tenant-a', () =>
    (
      service as unknown as {
        executeDiscordProviderAction: (
          owner: Record<string, unknown>,
          action: GatewayProviderAction,
          token: string
        ) => Promise<Record<string, unknown>>;
      }
    ).executeDiscordProviderAction(
      {
        tenantId: 'tenant-a',
        channelId: ids.channel,
        ...owner,
      },
      action,
      token
    )
  );
}

describe('GatewayService Discord provider actions', () => {
  beforeEach(() => {
    vi.mocked(getConnector).mockReset();
  });

  afterEach(() => resetUploadStagingStoreForTests());

  it('lets a random daemon enqueue canonical work without creating or calling Discord REST', async () => {
    const { service, enqueue, wake } = serviceHarness();
    const first = await runWithTenantContext('tenant-a', () =>
      service.routeMessage({
        session_id: ids.session,
        message_id: ids.message,
        message: 'caller supplied text must not be persisted or sent',
      })
    );
    const second = await runWithTenantContext('tenant-a', () =>
      service.routeMessage({
        session_id: ids.session,
        message_id: ids.message,
        message: 'a different caller value is still the same canonical action',
      })
    );

    expect(first).toEqual({ routed: true, channelType: 'discord' });
    expect(second).toEqual({ routed: true, channelType: 'discord' });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenLastCalledWith({
      kind: 'deliver_message',
      channelId: ids.channel,
      idempotencyKey: `deliver_message:${ids.message}:create`,
      mappingId: ids.mapping,
      sessionId: ids.session,
      taskId: ids.task,
      messageId: ids.message,
      params: { operation: 'create' },
    });
    expect(wake).toHaveBeenCalledWith('tenant-a', ids.channel);
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('executes history through the exact owner connector and stages no content in the action row', async () => {
    const { service, admitProviderCall } = serviceHarness();
    const store = new HistoryMemoryStore();
    configureUploadStagingStore(() => store, { sharedAcrossDaemons: true });
    const action = historyAction();
    (
      service as unknown as { providerActionRepo: { findById: ReturnType<typeof vi.fn> } }
    ).providerActionRepo.findById.mockResolvedValue(action);
    const fetchConversationHistory = vi.fn(
      async (request: { beforeProviderCall?: () => Promise<void> }) => {
        await request.beforeProviderCall?.();
        return {
          messages: [
            {
              cursor: '723456789012345678',
              iso_time: '2026-08-18T00:01:00.000Z',
              actor_label: 'caller',
              text: 'provider content only in staging',
              is_trigger: false,
              attachment_summary: '1 attached file(s)',
            },
          ],
          has_more: false,
          next_cursor: '723456789012345678',
        };
      }
    );
    const exactConnector = {
      history: { fetchConversationHistory, compareCursors: vi.fn() },
      sendMessage: vi.fn(),
    };
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: exactConnector,
    });

    const result = await executeOwnedAction(service, action, 'action-a');
    expect(result).toEqual({
      outcome: 'complete',
      result: expect.objectContaining({
        kind: 'discord_thread_history',
        message_count: 1,
        has_more: false,
      }),
    });
    expect(fetchConversationHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: mapping.thread_id,
        afterCursor: '623456789012345677',
        throughCursor: '823456789012345678',
        includeBotMessages: false,
        beforeProviderCall: expect.any(Function),
      })
    );
    expect(admitProviderCall).toHaveBeenCalledTimes(2);
    expect(JSON.stringify((result as { result: unknown }).result)).not.toContain(
      'provider content only in staging'
    );
    expect(store.bytes?.toString()).toContain('provider content only in staging');
    expect(store.owner).toMatchObject({
      tenantId: 'tenant-a',
      sessionId: session.session_id,
      branchId: session.branch_id,
      createdBy: session.created_by,
    });
    expect(exactConnector.sendMessage).not.toHaveBeenCalled();
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('lets a non-owner request via enqueue/poll/staging without constructing Discord REST', async () => {
    const { service, enqueue, wake } = serviceHarness();
    const store = new HistoryMemoryStore();
    configureUploadStagingStore(() => store, { sharedAcrossDaemons: true });
    let completed: GatewayProviderAction | undefined;
    enqueue.mockImplementation(async (input: Record<string, any>) => {
      const pending = historyAction({
        status: 'pending',
        claim_token: null,
        params: input.params,
        idempotency_key: input.idempotencyKey,
      });
      const result = await stageDiscordThreadHistorySnapshot(
        store,
        {
          tenantId: 'tenant-a' as never,
          sessionId: ids.session as never,
          branchId: ids.branch as never,
          createdBy: session.created_by as never,
        },
        {
          version: 1,
          initial_message_id: '623456789012345678',
          through_message_id: '823456789012345678',
          messages: [],
          has_more: false,
        }
      );
      completed = {
        ...pending,
        status: 'completed',
        result_metadata: result,
        completed_at: '2026-08-18T00:00:01.000Z',
      };
      return { outcome: 'enqueued', action: pending };
    });
    (
      service as unknown as { providerActionRepo: { findById: ReturnType<typeof vi.fn> } }
    ).providerActionRepo.findById.mockImplementation(async () => completed);

    await expect(
      runWithTenantContext('tenant-a', () =>
        service.requestDiscordThreadHistory({
          sessionId: ids.session as never,
          branchId: ids.branch as never,
          limit: 50,
        })
      )
    ).resolves.toMatchObject({ messages: [], through_message_id: '823456789012345678' });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'discord_thread_history',
        channelId: ids.channel,
        mappingId: ids.mapping,
        sessionId: ids.session,
        idempotencyKey: expect.stringMatching(/^discord_thread_history:/),
      })
    );
    expect(wake).toHaveBeenCalledWith('tenant-a', ids.channel);
    expect(store.consume).toHaveBeenCalledOnce();
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('rejects local staging and cursors outside the admitted summon snapshot before enqueue', async () => {
    const { service, enqueue } = serviceHarness();
    await expect(
      runWithTenantContext('tenant-a', () =>
        service.requestDiscordThreadHistory({
          sessionId: ids.session as never,
          branchId: ids.branch as never,
        })
      )
    ).rejects.toThrow(/shared upload staging/);
    expect(enqueue).not.toHaveBeenCalled();

    configureUploadStagingStore(() => new HistoryMemoryStore(), {
      sharedAcrossDaemons: true,
    });
    await expect(
      runWithTenantContext('tenant-a', () =>
        service.requestDiscordThreadHistory({
          sessionId: ids.session as never,
          branchId: ids.branch as never,
          afterMessageId: '923456789012345678',
        })
      )
    ).rejects.toThrow(/invalid bounds/);
    expect(enqueue).not.toHaveBeenCalled();

    await expect(
      runWithTenantContext('tenant-a', () =>
        service.requestDiscordThreadHistory({
          sessionId: ids.session as never,
          branchId: ids.branch as never,
          afterMessageId: '523456789012345678',
        })
      )
    ).rejects.toThrow(/invalid bounds/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('fails closed before enqueue across every same-session mapping and channel boundary', async () => {
    configureUploadStagingStore(() => new HistoryMemoryStore(), {
      sharedAcrossDaemons: true,
    });
    const otherBranch = '01927f9d-1000-7000-8000-000000000099';
    const cases: Array<{
      name: string;
      configure: (service: GatewayService) => void;
      branchId?: string;
    }> = [
      {
        name: 'missing mapping',
        configure: (service) => {
          (
            service as unknown as {
              threadMapRepo: { findActiveBySessionBounded: ReturnType<typeof vi.fn> };
            }
          ).threadMapRepo.findActiveBySessionBounded.mockResolvedValue([]);
        },
      },
      {
        name: 'inactive mapping',
        configure: (service) => {
          (
            service as unknown as {
              threadMapRepo: { findActiveBySessionBounded: ReturnType<typeof vi.fn> };
            }
          ).threadMapRepo.findActiveBySessionBounded.mockResolvedValue([
            { ...mapping, status: 'archived' },
          ]);
        },
      },
      {
        name: 'different mapped session',
        configure: (service) => {
          (
            service as unknown as {
              threadMapRepo: { findActiveBySessionBounded: ReturnType<typeof vi.fn> };
            }
          ).threadMapRepo.findActiveBySessionBounded.mockResolvedValue([
            {
              ...mapping,
              session_id: '01927f9d-1000-7000-8000-000000000098',
            },
          ]);
        },
      },
      {
        name: 'ambiguous active mapping graph',
        configure: (service) => {
          (
            service as unknown as {
              threadMapRepo: { findActiveBySessionBounded: ReturnType<typeof vi.fn> };
            }
          ).threadMapRepo.findActiveBySessionBounded.mockResolvedValue([
            mapping,
            { ...mapping, id: '01927f9d-1000-7000-8000-000000000097' },
          ]);
        },
      },
      {
        name: 'disabled channel',
        configure: (service) => {
          (
            service as unknown as {
              channelRepo: { findById: ReturnType<typeof vi.fn> };
            }
          ).channelRepo.findById.mockResolvedValue({ ...channel, enabled: false });
        },
      },
      {
        name: 'non-Discord channel',
        configure: (service) => {
          (
            service as unknown as {
              channelRepo: { findById: ReturnType<typeof vi.fn> };
            }
          ).channelRepo.findById.mockResolvedValue({ ...channel, channel_type: 'slack' });
        },
      },
      {
        name: 'history capability disabled',
        configure: (service) => {
          (
            service as unknown as {
              channelRepo: { findById: ReturnType<typeof vi.fn> };
            }
          ).channelRepo.findById.mockResolvedValue({
            ...channel,
            config: { ...channel.config, agent_tools: { thread_history: false } },
          });
        },
      },
      {
        name: 'different target branch',
        configure: () => undefined,
        branchId: otherBranch,
      },
    ];

    for (const testCase of cases) {
      const { service, enqueue } = serviceHarness();
      testCase.configure(service);
      await expect(
        runWithTenantContext('tenant-a', () =>
          service.requestDiscordThreadHistory({
            sessionId: ids.session as never,
            branchId: (testCase.branchId ?? ids.branch) as never,
          })
        ),
        testCase.name
      ).rejects.toThrow(/mapping|not available/);
      expect(enqueue, testCase.name).not.toHaveBeenCalled();
      expect(getConnector, testCase.name).not.toHaveBeenCalled();
    }
  });

  it('does not enqueue a history request that is already aborted', async () => {
    const { service, enqueue } = serviceHarness();
    const abort = new AbortController();
    abort.abort(new Error('caller canceled'));

    await expect(
      runWithTenantContext('tenant-a', () =>
        service.requestDiscordThreadHistory({
          sessionId: ids.session as never,
          branchId: ids.branch as never,
          signal: abort.signal,
        })
      )
    ).rejects.toThrow('caller canceled');
    expect(enqueue).not.toHaveBeenCalled();
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('bounds pending cross-daemon polling and remains abort-aware after enqueue', async () => {
    vi.useFakeTimers();
    try {
      configureUploadStagingStore(() => new HistoryMemoryStore(), {
        sharedAcrossDaemons: true,
      });
      const makePendingHarness = () => {
        const harness = serviceHarness();
        let pending: GatewayProviderAction | undefined;
        harness.enqueue.mockImplementation(async (input: Record<string, any>) => {
          pending = historyAction({
            status: 'pending',
            claim_token: null,
            params: input.params,
            idempotency_key: input.idempotencyKey,
          });
          return { outcome: 'enqueued', action: pending };
        });
        (
          harness.service as unknown as {
            providerActionRepo: { findById: ReturnType<typeof vi.fn> };
          }
        ).providerActionRepo.findById.mockImplementation(async () => pending);
        return harness;
      };

      const timed = makePendingHarness();
      const timeout = runWithTenantContext('tenant-a', () =>
        timed.service.requestDiscordThreadHistory({
          sessionId: ids.session as never,
          branchId: ids.branch as never,
        })
      );
      const timeoutAssertion = expect(timeout).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(30_100);
      await timeoutAssertion;
      expect(timed.enqueue).toHaveBeenCalledOnce();

      const aborted = makePendingHarness();
      const controller = new AbortController();
      const request = runWithTenantContext('tenant-a', () =>
        aborted.service.requestDiscordThreadHistory({
          sessionId: ids.session as never,
          branchId: ids.branch as never,
          signal: controller.signal,
        })
      );
      const abortAssertion = expect(request).rejects.toThrow('request canceled after enqueue');
      await vi.waitFor(() => expect(aborted.enqueue).toHaveBeenCalledOnce());
      controller.abort(new Error('request canceled after enqueue'));
      await vi.advanceTimersByTimeAsync(100);
      await abortAssertion;
      expect(getConnector).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('performs no history GET or stage when the action expires at admission', async () => {
    const { service, admitProviderCall } = serviceHarness();
    const store = new HistoryMemoryStore();
    configureUploadStagingStore(() => store, { sharedAcrossDaemons: true });
    const action = historyAction();
    admitProviderCall.mockResolvedValueOnce(null);
    const repo = (
      service as unknown as { providerActionRepo: { findById: ReturnType<typeof vi.fn> } }
    ).providerActionRepo;
    repo.findById.mockResolvedValueOnce(action).mockResolvedValueOnce({
      ...action,
      status: 'canceled',
      last_error_code: 'discord_history_expired',
    });
    const restGet = vi.fn();
    const fetchConversationHistory = vi.fn(
      async (request: { beforeProviderCall?: () => Promise<void> }) => {
        await request.beforeProviderCall?.();
        await restGet();
        return { messages: [], has_more: false };
      }
    );
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        history: { fetchConversationHistory, compareCursors: vi.fn() },
        sendMessage: vi.fn(),
      },
    });
    await expect(executeOwnedAction(service, action, 'action-a')).resolves.toEqual({
      outcome: 'already_transitioned',
    });
    expect(fetchConversationHistory).toHaveBeenCalledOnce();
    expect(restGet).not.toHaveBeenCalled();
    expect(store.bytes).toBeUndefined();
  });

  it('renders and recovers a fixed inbound-event notice on the exact owner connector', async () => {
    const { service, admitProviderCall } = serviceHarness();
    const action = noticeAction();
    const providerActionRepo = (
      service as unknown as { providerActionRepo: Record<string, unknown> }
    ).providerActionRepo;
    providerActionRepo.findById = vi.fn(async () => action);
    (service as unknown as { inboundEventRepo: Record<string, unknown> }).inboundEventRepo = {
      findById: vi.fn(async () => ({
        id: ids.inboundEvent,
        gateway_channel_id: ids.channel,
        provider_event_id: 'discord:message:223456789012345678:923456789012345678',
        thread_id: 'discord:823456789012345678',
        delivery_metadata: null,
        status: 'completed',
        processing_token: 'listener-a',
        processing_expires_at: '2026-08-18T00:01:00.000Z',
        session_id: null,
        task_id: null,
        received_at: '2026-08-18T00:00:00.000Z',
        completed_at: '2026-08-18T00:00:01.000Z',
      })),
    };
    const sendDeliveryChunk = recoverableSend(vi.fn(async () => '823456789012345679'));
    const exactConnector = {
      sendMessage: vi.fn(),
      sendMessageRecoverable: sendDeliveryChunk,
      sendDeliveryChunk,
      deleteMessage: vi.fn(async () => undefined),
      triggerTyping: vi.fn(async () => undefined),
    };
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: exactConnector,
    });

    await expect(executeOwnedAction(service, action, 'action-a')).resolves.toEqual({
      outcome: 'complete',
      result: { kind: 'discord_notice', provider_message_id: '823456789012345679' },
    });
    expect(sendDeliveryChunk).toHaveBeenCalledWith(
      {
        threadId: 'discord:823456789012345678',
        content: renderDiscordRoutingNotice('alignment_missing'),
        nonce: discordMessageNonce(
          discordRoutingNoticeNonceSeed(ids.inboundEvent as never, 'alignment_missing'),
          0
        ),
      },
      expect.objectContaining({
        recoveryWindow: expect.any(Object),
        beforeProviderCall: expect.any(Function),
      })
    );
    expect(admitProviderCall).toHaveBeenCalled();
    expect(exactConnector.sendMessage).not.toHaveBeenCalled();
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('performs no Discord REST side effect when a claimed notice expires at admission', async () => {
    const { service, admitProviderCall } = serviceHarness();
    const action = noticeAction();
    admitProviderCall.mockResolvedValueOnce(null);
    const providerActionRepo = (
      service as unknown as { providerActionRepo: { findById: ReturnType<typeof vi.fn> } }
    ).providerActionRepo;
    providerActionRepo.findById.mockResolvedValueOnce(action).mockResolvedValueOnce({
      ...action,
      status: 'canceled',
      last_error_code: 'notice_expired',
      canceled_at: '2026-08-18T00:02:00.000Z',
    });
    (service as unknown as { inboundEventRepo: Record<string, unknown> }).inboundEventRepo = {
      findById: vi.fn(async () => ({
        id: ids.inboundEvent,
        gateway_channel_id: ids.channel,
        provider_event_id: 'discord:message:223456789012345678:923456789012345678',
        thread_id: 'discord:823456789012345678',
        delivery_metadata: null,
        status: 'completed',
        processing_token: 'listener-a',
        processing_expires_at: '2026-08-18T00:01:00.000Z',
        session_id: null,
        task_id: null,
        received_at: '2026-08-18T00:00:00.000Z',
        completed_at: '2026-08-18T00:00:01.000Z',
      })),
    };
    const providerRest = vi.fn(async () => '823456789012345679');
    const sendDeliveryChunk = recoverableSend(providerRest);
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        sendMessage: vi.fn(),
        sendMessageRecoverable: sendDeliveryChunk,
        sendDeliveryChunk,
      },
    });

    await expect(executeOwnedAction(service, action, 'action-a')).resolves.toEqual({
      outcome: 'already_transitioned',
    });
    expect(admitProviderCall).toHaveBeenCalledOnce();
    expect(providerRest).not.toHaveBeenCalled();
  });

  it('keeps Discord outbound inert while the immutable runtime gate is closed', async () => {
    const { service, enqueue } = serviceHarness();
    (service as unknown as { runtimeProviderGate: (type: string) => boolean }).runtimeProviderGate =
      () => false;

    const result = await runWithTenantContext('tenant-a', () =>
      service.routeMessage({
        session_id: ids.session,
        message_id: ids.message,
        message: 'canonical hook value',
      })
    );

    expect(result).toEqual({ routed: false, channelType: 'discord' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('lets a random daemon coalesce progress with database work only', async () => {
    const { service, wake } = serviceHarness();
    const enqueueDiscordProgress = vi.fn(async () => ({
      outcome: 'enqueued' as const,
      action: progressAction({ status: 'pending', claim_token: null }),
    }));
    Object.assign(service as unknown as Record<string, unknown>, {
      shouldQueryGatewayRouting: vi.fn(async () => true),
      runtimeProviderGate: () => true,
      providerActionRepo: {
        enqueueDiscordProgress,
      },
      providerActionProcessor: { wake },
    });

    await runWithTenantContext('tenant-a', () =>
      service.updateProgress({
        session_id: ids.session,
        task_id: ids.task,
        state: 'working',
        tool_name: 'Grep',
        tool_input: { path: '/must/not/persist' },
      })
    );

    expect(enqueueDiscordProgress).toHaveBeenCalledWith({
      channelId: ids.channel,
      mappingId: ids.mapping,
      sessionId: ids.session,
      taskId: ids.task,
      state: 'working',
      toolName: 'Grep',
      dropAfterMs: 300_000,
    });
    expect(JSON.stringify(enqueueDiscordProgress.mock.calls)).not.toContain('/must/not/persist');
    expect(wake).toHaveBeenCalledWith('tenant-a', ids.channel);
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('fails closed on a taskless Discord terminal callback', async () => {
    const { service, wake } = serviceHarness();
    const enqueueDiscordProgress = vi.fn();
    Object.assign(service as unknown as Record<string, unknown>, {
      shouldQueryGatewayRouting: vi.fn(async () => true),
      runtimeProviderGate: () => true,
      providerActionRepo: { enqueueDiscordProgress },
      providerActionProcessor: { wake },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runWithTenantContext('tenant-a', () =>
      service.updateProgress({ session_id: ids.session, state: 'done' })
    );

    expect(enqueueDiscordProgress).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      `[gateway.provider_action] event=progress_ignored channel_id=${JSON.stringify(ids.channel)} code=terminal_task_missing`
    );
    warn.mockRestore();
  });

  it('keeps durable backlog health authoritative while adding content-free local presence', async () => {
    const { service } = serviceHarness();
    const getBacklogMetrics = vi.fn(async () => ({
      activeCount: 7,
      oldestDueAt: '2026-08-18T00:00:00.000Z',
      oldestDueAgeMs: 45_000,
      deadLetterCount: 2,
      partialDeliveryCount: 1,
      nonceRecoveryIncompleteCount: 1,
      historyIncompleteCount: 1,
      formatterMismatchCount: 0,
      observedAt: '2026-08-18T00:00:45.000Z',
    }));
    Object.assign(service as unknown as Record<string, unknown>, {
      providerActionRepo: { getBacklogMetrics },
      providerActionProcessor: {
        getDiagnostic: vi.fn(() => ({
          backlog: 7,
          lastErrorCode: 'discord_rate_limited',
          updatedAt: '2026-08-18T00:00:44.000Z',
        })),
      },
    });
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      connector: {
        getAggregatePresenceDiagnostic: () => ({
          desiredActiveCount: 3,
          lastSentActiveCount: 2,
          pending: true,
          retryCount: 1,
          lastErrorCode: 'discord_presence_send_failed',
        }),
      },
    });

    await expect(
      runWithTenantContext('tenant-a', () => service.getProviderActionDiagnostic(ids.channel))
    ).resolves.toEqual({
      activeCount: 7,
      oldestDueAt: '2026-08-18T00:00:00.000Z',
      oldestDueAgeMs: 45_000,
      deadLetterCount: 2,
      partialDeliveryCount: 1,
      nonceRecoveryIncompleteCount: 1,
      historyIncompleteCount: 1,
      formatterMismatchCount: 0,
      observedAt: '2026-08-18T00:00:45.000Z',
      lastErrorCode: 'discord_rate_limited',
      processorUpdatedAt: '2026-08-18T00:00:44.000Z',
      aggregatePresence: {
        locallyOwned: true,
        desiredActiveCount: 3,
        lastSentActiveCount: 2,
        pending: true,
        retryCount: 1,
        lastErrorCode: 'discord_presence_send_failed',
      },
    });
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('fails routing closed when durable backlog admission is rejected', async () => {
    const { service, enqueue } = serviceHarness();
    const backlog = new Error('must not be logged');
    backlog.name = 'GatewayProviderActionBacklogError';
    enqueue.mockRejectedValue(backlog);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runWithTenantContext('tenant-a', () =>
      service.routeMessage({
        session_id: ids.session,
        message_id: ids.message,
        message: 'caller text must not reach logs',
      })
    );

    expect(result).toEqual({ routed: false, channelType: 'discord' });
    expect(getConnector).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('code=backlog_full');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('must not be logged');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('caller text');
  });

  it('uses the exact live owner connector and replays with the same canonical nonce seed', async () => {
    const { service, admitProviderCall } = serviceHarness();
    const sendA = vi.fn(async () => '823456789012345679');
    const sendB = vi.fn(async () => '823456789012345679');
    const ownerMap = (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors;
    ownerMap.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      lease_expires_at: '2099-01-01T00:00:00.000Z',
      phase: 'ready',
      connector: {
        sendMessage: sendA,
        sendMessageRecoverable: recoverableSend(sendA),
        sendDeliveryChunk: recoverableSend(sendA),
        formatMessage: (text: string) => text,
        deleteMessage: vi.fn(async () => undefined),
        triggerTyping: vi.fn(async () => undefined),
      },
    });
    const execute = (
      service as unknown as {
        executeDiscordProviderAction: (
          owner: Record<string, unknown>,
          action: GatewayProviderAction,
          token: string
        ) => Promise<Record<string, unknown>>;
      }
    ).executeDiscordProviderAction.bind(service);

    const first = await runWithTenantContext('tenant-a', () =>
      execute(
        {
          tenantId: 'tenant-a',
          channelId: ids.channel,
          listenerClaimToken: 'listener-a',
          listenerGeneration: 1,
        },
        providerAction(),
        'action-a'
      )
    );
    expect(first).toEqual({
      outcome: 'complete',
      result: {
        kind: 'deliver_message',
        provider_message_id: '823456789012345679',
      },
    });

    const replay = providerAction({
      claim_token: 'action-b',
      claim_generation: 2,
      claim_listener_token: 'listener-b',
      claim_listener_generation: 2,
    });
    (
      service as unknown as {
        providerActionRepo: { findById: ReturnType<typeof vi.fn>; admitProviderCall: unknown };
      }
    ).providerActionRepo.findById.mockResolvedValue(replay);
    ownerMap.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-b',
      generation: 2,
      lease_expires_at: '2099-01-01T00:00:00.000Z',
      phase: 'ready',
      connector: {
        sendMessage: sendB,
        sendMessageRecoverable: recoverableSend(sendB),
        sendDeliveryChunk: recoverableSend(sendB),
        formatMessage: (text: string) => text,
        deleteMessage: vi.fn(async () => undefined),
        triggerTyping: vi.fn(async () => undefined),
      },
    });
    const second = await runWithTenantContext('tenant-a', () =>
      execute(
        {
          tenantId: 'tenant-a',
          channelId: ids.channel,
          listenerClaimToken: 'listener-b',
          listenerGeneration: 2,
        },
        replay,
        'action-b'
      )
    );

    expect(second).toEqual({
      outcome: 'complete',
      result: {
        kind: 'deliver_message',
        provider_message_id: '823456789012345679',
      },
    });
    expect(sendA).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'canonical answer',
        nonce: discordMessageNonce(ids.message, 0),
      })
    );
    expect(sendB).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: discordMessageNonce(ids.message, 0) })
    );
    expect(admitProviderCall).toHaveBeenCalledTimes(2);
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('fences every bounded final nonce-recovery page before deciding whether to POST', async () => {
    const { service, admitProviderCall } = serviceHarness();
    const post = vi.fn(async () => '823456789012345679');
    const sendMessageRecoverable = vi.fn(
      async (
        _request: Record<string, unknown>,
        options: { beforeProviderCall?: () => Promise<void> }
      ) => {
        await options.beforeProviderCall?.();
        await options.beforeProviderCall?.();
        return '823456789012345679';
      }
    );
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        sendMessage: post,
        sendMessageRecoverable,
        sendDeliveryChunk: sendMessageRecoverable,
        deleteMessage: vi.fn(async () => undefined),
        triggerTyping: vi.fn(async () => undefined),
      },
    });

    await expect(
      executeOwnedAction(service, providerAction({ attempts: 2 }), 'action-a')
    ).resolves.toMatchObject({ outcome: 'complete' });
    expect(sendMessageRecoverable).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: discordMessageNonce(ids.message, 0) }),
      expect.objectContaining({
        recoveryWindow: expect.objectContaining({
          after: expect.any(String),
          before: expect.any(String),
        }),
        beforeProviderCall: expect.any(Function),
      })
    );
    expect(admitProviderCall).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
  });

  it('bounds final nonce recovery from the canonical Message timestamp, not the older Task', async () => {
    const { service } = serviceHarness();
    const canonicalMessage = { ...message, timestamp: '2026-08-18T00:20:00.000Z' };
    (service as unknown as { messagesRepo: { findById: () => Promise<Message> } }).messagesRepo = {
      findById: vi.fn(async () => canonicalMessage),
    };
    const sendDeliveryChunk = recoverableSend(vi.fn(async () => '823456789012345679'));
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        sendMessage: vi.fn(),
        sendMessageRecoverable: sendDeliveryChunk,
        sendDeliveryChunk,
        deleteMessage: vi.fn(async () => undefined),
        triggerTyping: vi.fn(async () => undefined),
      },
    });
    const action = providerAction({ updated_at: '2026-08-18T00:30:00.000Z' });
    (
      service as unknown as {
        providerActionRepo: { findById: (id: string) => Promise<GatewayProviderAction> };
      }
    ).providerActionRepo.findById = vi.fn(async () => action);

    await expect(executeOwnedAction(service, action, 'action-a')).resolves.toMatchObject({
      outcome: 'complete',
    });
    expect(sendDeliveryChunk).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        recoveryWindow: discordNonceRecoveryWindowFromTimes(
          canonicalMessage.timestamp,
          action.updated_at
        ),
      })
    );
    expect(
      discordNonceRecoveryWindowFromTimes(canonicalMessage.timestamp, action.updated_at).after
    ).not.toBe(discordNonceRecoveryWindowFromTimes(task.created_at, action.updated_at).after);
  });

  it('stops nonce recovery before POST when the exact action fence is lost between pages', async () => {
    const { service, admitProviderCall } = serviceHarness();
    admitProviderCall.mockResolvedValueOnce(providerAction()).mockResolvedValueOnce(null);
    const post = vi.fn();
    const sendMessageRecoverable = vi.fn(
      async (
        _request: Record<string, unknown>,
        options: { beforeProviderCall?: () => Promise<void> }
      ) => {
        await options.beforeProviderCall?.();
        await options.beforeProviderCall?.();
        await post();
        return '823456789012345679';
      }
    );
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        sendMessage: vi.fn(),
        sendMessageRecoverable,
        sendDeliveryChunk: sendMessageRecoverable,
        deleteMessage: vi.fn(async () => undefined),
        triggerTyping: vi.fn(async () => undefined),
      },
    });

    await expect(executeOwnedAction(service, providerAction(), 'action-a')).resolves.toEqual({
      outcome: 'claim_lost',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('dead-letters incomplete recovery but checkpoints every multi-chunk final', async () => {
    const { service, admitProviderCall, recordDiscordDeliveryChunk } = serviceHarness();
    const sendMessageRecoverable = vi.fn(async () => {
      throw new DiscordNonceRecoveryIncompleteError();
    });
    const ownerMap = (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors;
    ownerMap.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        sendMessage: vi.fn(),
        sendMessageRecoverable,
        sendDeliveryChunk: sendMessageRecoverable,
        deleteMessage: vi.fn(async () => undefined),
        triggerTyping: vi.fn(async () => undefined),
      },
    });

    await expect(executeOwnedAction(service, providerAction(), 'action-a')).resolves.toEqual({
      outcome: 'dead_letter',
      errorCode: 'discord_nonce_recovery_incomplete',
    });

    (
      service as unknown as { messagesRepo: { findById: ReturnType<typeof vi.fn> } }
    ).messagesRepo.findById.mockResolvedValue({ ...message, content: 'x'.repeat(2_500) });
    sendMessageRecoverable.mockClear();
    admitProviderCall.mockClear();
    recordDiscordDeliveryChunk.mockClear();
    sendMessageRecoverable.mockImplementation(
      async (
        _request: Record<string, unknown>,
        options: { beforeProviderCall?: () => Promise<void> }
      ) => {
        await options.beforeProviderCall?.();
        return String(823456789012345679n + BigInt(sendMessageRecoverable.mock.calls.length));
      }
    );
    await expect(executeOwnedAction(service, providerAction(), 'action-a')).resolves.toMatchObject({
      outcome: 'complete',
    });
    expect(sendMessageRecoverable).toHaveBeenCalledTimes(2);
    expect(recordDiscordDeliveryChunk).toHaveBeenCalledTimes(2);
    expect(admitProviderCall).toHaveBeenCalledTimes(2);
  });

  it('recovers every overflow chunk boundary after POST-before-checkpoint death', async () => {
    const content = Array.from({ length: 20 }, (_, index) => `${index}:${'x'.repeat(1_950)}`).join(
      '\n\n'
    );
    const expectedPlan = createDiscordDeliveryPlan(content, ids.message, content);
    expect(expectedPlan.chunks).toHaveLength(8);
    expect(expectedPlan.metadata.overflow_attachment).toBeDefined();

    for (const crashIndex of expectedPlan.chunks.map((chunk) => chunk.index)) {
      const { service, initializeDiscordDelivery, recordDiscordDeliveryChunk } = serviceHarness();
      (
        service as unknown as { messagesRepo: { findById: ReturnType<typeof vi.fn> } }
      ).messagesRepo.findById.mockResolvedValue({ ...message, content });
      let persisted: typeof expectedPlan.metadata | undefined;
      let crashPending = true;
      initializeDiscordDelivery.mockImplementation(
        async (input: { metadata: typeof expectedPlan.metadata }) => {
          if (!persisted) persisted = structuredClone(input.metadata);
          return { outcome: 'matched', metadata: structuredClone(persisted) };
        }
      );
      recordDiscordDeliveryChunk.mockImplementation(
        async (input: {
          chunkIndex: number;
          providerMessageId: string;
          expectedMetadata: typeof expectedPlan.metadata;
        }) => {
          if (input.chunkIndex === crashIndex && crashPending) {
            crashPending = false;
            return { outcome: 'fenced' };
          }
          persisted ??= structuredClone(input.expectedMetadata);
          persisted.chunks[input.chunkIndex] = {
            ...persisted.chunks[input.chunkIndex],
            provider_message_id: input.providerMessageId,
          };
          return { outcome: 'recorded', metadata: structuredClone(persisted) };
        }
      );
      const firstRequests: Array<Record<string, unknown>> = [];
      const takeoverRequests: Array<Record<string, unknown>> = [];
      const delivery = (requests: Array<Record<string, unknown>>) =>
        vi.fn(
          async (
            request: Record<string, unknown>,
            options: { beforeProviderCall?: () => Promise<void> }
          ) => {
            requests.push(request);
            await options.beforeProviderCall?.();
            const index = expectedPlan.chunks.findIndex((chunk) => chunk.nonce === request.nonce);
            return String(823456789012345679n + BigInt(index));
          }
        );
      const ownerMap = (
        service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
      ).ownedDiscordConnectors;
      ownerMap.set(`tenant-a\0${ids.channel}`, {
        tenant_id: 'tenant-a',
        channel_id: ids.channel,
        claim_token: 'listener-a',
        generation: 1,
        phase: 'ready',
        connector: {
          sendMessage: vi.fn(),
          sendMessageRecoverable: recoverableSend(vi.fn()),
          sendDeliveryChunk: delivery(firstRequests),
          deleteMessage: vi.fn(async () => undefined),
          triggerTyping: vi.fn(async () => undefined),
        },
      });

      await expect(executeOwnedAction(service, providerAction(), 'action-a')).resolves.toEqual({
        outcome: 'claim_lost',
      });
      expect(firstRequests.at(-1)).toMatchObject({
        nonce: expectedPlan.chunks[crashIndex]?.nonce,
      });
      ownerMap.set(`tenant-a\0${ids.channel}`, {
        tenant_id: 'tenant-a',
        channel_id: ids.channel,
        claim_token: 'listener-b',
        generation: 2,
        phase: 'ready',
        connector: {
          sendMessage: vi.fn(),
          sendMessageRecoverable: recoverableSend(vi.fn()),
          sendDeliveryChunk: delivery(takeoverRequests),
          deleteMessage: vi.fn(async () => undefined),
          triggerTyping: vi.fn(async () => undefined),
        },
      });
      const takeoverAction = providerAction({
        claim_token: 'action-b',
        claim_generation: 2,
        claim_listener_token: 'listener-b',
        claim_listener_generation: 2,
      });
      (
        service as unknown as { providerActionRepo: { findById: ReturnType<typeof vi.fn> } }
      ).providerActionRepo.findById.mockResolvedValue(takeoverAction);
      const takeoverResult = await executeOwnedAction(service, takeoverAction, 'action-b', {
        listenerClaimToken: 'listener-b',
        listenerGeneration: 2,
      });
      expect(takeoverResult).toEqual({
        outcome: 'complete',
        result: {
          kind: 'deliver_message',
          provider_message_id: String(823456789012345679n + BigInt(expectedPlan.chunks.length - 1)),
        },
      });
      expect(takeoverRequests[0]).toMatchObject({
        nonce: expectedPlan.chunks[crashIndex]?.nonce,
      });
      expect(takeoverRequests).toHaveLength(expectedPlan.chunks.length - crashIndex);
      expect(JSON.stringify(persisted)).not.toContain(content.slice(0, 100));
      if (crashIndex === expectedPlan.chunks.length - 1) {
        expect(takeoverRequests[0]).toMatchObject({
          overflowAttachment: {
            filename: 'agor-response.md',
            byteLength: Buffer.byteLength(content),
          },
        });
      }
    }
  });

  it('fails closed on a formatter identity mismatch before Discord REST', async () => {
    const { service, initializeDiscordDelivery } = serviceHarness();
    initializeDiscordDelivery.mockResolvedValue({ outcome: 'formatter_mismatch' });
    const sendDeliveryChunk = vi.fn();
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        sendMessage: vi.fn(),
        sendMessageRecoverable: recoverableSend(vi.fn()),
        sendDeliveryChunk,
        deleteMessage: vi.fn(async () => undefined),
        triggerTyping: vi.fn(async () => undefined),
      },
    });

    await expect(executeOwnedAction(service, providerAction(), 'action-a')).resolves.toEqual({
      outcome: 'dead_letter',
      errorCode: 'discord_formatter_mismatch',
    });
    expect(sendDeliveryChunk).not.toHaveBeenCalled();
  });

  it('runs progress create through the exact owner connector and fences the handle write', async () => {
    const { service, admitProviderCall, updateDiscordProgressHandle } = serviceHarness();
    const progress = progressAction();
    const progressMapping = {
      ...mapping,
      metadata: {
        ...mapping.metadata,
        discord_progress_task_id: ids.task,
        discord_progress_revision: 1,
        discord_progress_state: 'working',
        discord_progress_tool_name: 'Grep',
      },
    };
    const providerRepo = (
      service as unknown as {
        providerActionRepo: { findById: ReturnType<typeof vi.fn> };
      }
    ).providerActionRepo;
    providerRepo.findById.mockResolvedValue(progress);
    (
      service as unknown as { threadMapRepo: { findById: ReturnType<typeof vi.fn> } }
    ).threadMapRepo.findById.mockResolvedValue(progressMapping);
    const sendMessage = vi.fn(async () => '823456789012345679');
    const triggerTyping = vi.fn(async () => undefined);
    const deleteMessage = vi.fn(async () => undefined);
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      lease_expires_at: '2000-01-01T00:00:00.000Z',
      phase: 'ready',
      connector: {
        sendMessage,
        sendMessageRecoverable: recoverableSend(sendMessage),
        sendDeliveryChunk: recoverableSend(sendMessage),
        triggerTyping,
        deleteMessage,
      },
    });

    const result = await runWithTenantContext('tenant-a', () =>
      (
        service as unknown as {
          executeDiscordProviderAction: (
            owner: Record<string, unknown>,
            action: GatewayProviderAction,
            token: string
          ) => Promise<Record<string, unknown>>;
        }
      ).executeDiscordProviderAction(
        {
          tenantId: 'tenant-a',
          channelId: ids.channel,
          listenerClaimToken: 'listener-a',
          listenerGeneration: 1,
        },
        progress,
        'action-a'
      )
    );

    expect(result).toEqual({
      outcome: 'complete',
      result: {
        kind: 'discord_progress',
        outcome: 'upserted',
        provider_message_id: '823456789012345679',
      },
    });
    expect(triggerTyping).toHaveBeenCalledWith(mapping.thread_id);
    expect(sendMessage).toHaveBeenCalledWith({
      threadId: mapping.thread_id,
      text: 'Using Grep…',
      metadata: { discord_nonce_seed: `discord-progress:${ids.mapping}:${ids.task}` },
    });
    expect(admitProviderCall).toHaveBeenCalledTimes(2);
    expect(updateDiscordProgressHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        expectedProviderMessageId: null,
        providerMessageId: '823456789012345679',
      })
    );
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('replays progress when the handle write loses its exact action claim', async () => {
    const { service, updateDiscordProgressHandle, recordDiscordProgressCleanupDebt } =
      serviceHarness();
    const progress = progressAction();
    (
      service as unknown as {
        providerActionRepo: { findById: ReturnType<typeof vi.fn> };
      }
    ).providerActionRepo.findById.mockResolvedValue(progress);
    (
      service as unknown as { threadMapRepo: { findById: ReturnType<typeof vi.fn> } }
    ).threadMapRepo.findById.mockResolvedValue({
      ...mapping,
      metadata: {
        ...mapping.metadata,
        discord_progress_task_id: ids.task,
        discord_progress_revision: 1,
        discord_progress_state: 'working',
        discord_progress_tool_name: 'Grep',
      },
    });
    updateDiscordProgressHandle.mockResolvedValue('fenced');
    const sendMessage = vi.fn(async () => '823456789012345679');
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        sendMessage,
        sendMessageRecoverable: recoverableSend(sendMessage),
        sendDeliveryChunk: recoverableSend(sendMessage),
        triggerTyping: vi.fn(async () => undefined),
        deleteMessage: vi.fn(async () => undefined),
      },
    });

    await expect(
      runWithTenantContext('tenant-a', () =>
        (
          service as unknown as {
            executeDiscordProviderAction: (
              owner: Record<string, unknown>,
              action: GatewayProviderAction,
              token: string
            ) => Promise<Record<string, unknown>>;
          }
        ).executeDiscordProviderAction(
          {
            tenantId: 'tenant-a',
            channelId: ids.channel,
            listenerClaimToken: 'listener-a',
            listenerGeneration: 1,
          },
          progress,
          'action-a'
        )
      )
    ).resolves.toEqual({ outcome: 'claim_lost' });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(recordDiscordProgressCleanupDebt).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: ids.task,
        providerMessageId: '823456789012345679',
      })
    );
  });

  it('leaves pre-armed nonce cleanup replayable when the listener fence is lost after POST', async () => {
    const {
      service,
      armDiscordProgressCreate,
      updateDiscordProgressHandle,
      recordDiscordProgressCleanupDebt,
      listenerClaimIsCurrent,
    } = serviceHarness();
    const progress = progressAction();
    (
      service as unknown as { providerActionRepo: { findById: ReturnType<typeof vi.fn> } }
    ).providerActionRepo.findById.mockResolvedValue(progress);
    (
      service as unknown as { threadMapRepo: { findById: ReturnType<typeof vi.fn> } }
    ).threadMapRepo.findById.mockResolvedValue({
      ...mapping,
      metadata: {
        ...mapping.metadata,
        discord_progress_task_id: ids.task,
        discord_progress_revision: 1,
        discord_progress_state: 'working',
        discord_progress_tool_name: 'Grep',
      },
    });
    updateDiscordProgressHandle.mockResolvedValue('fenced');
    recordDiscordProgressCleanupDebt.mockImplementation(async () => {
      listenerClaimIsCurrent.mockResolvedValue(false);
      return 'fenced';
    });
    const sendMessage = vi.fn(async () => '823456789012345679');
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        sendMessage,
        sendMessageRecoverable: recoverableSend(sendMessage),
        sendDeliveryChunk: recoverableSend(sendMessage),
        deleteMessage: vi.fn(async () => undefined),
        triggerTyping: vi.fn(async () => undefined),
      },
    });

    await expect(executeOwnedAction(service, progress, 'action-a')).resolves.toEqual({
      outcome: 'owner_lost',
    });
    expect(armDiscordProgressCreate).toHaveBeenCalledOnce();
    expect(armDiscordProgressCreate.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessage.mock.invocationCallOrder[0]
    );
    expect(recordDiscordProgressCleanupDebt).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: '823456789012345679' })
    );
  });

  it('converges a same-task working-to-done coalesce while create is in flight', async () => {
    const {
      service,
      updateDiscordProgressHandle,
      armDiscordProgressCreate,
      recordDiscordProgressCleanupDebt,
      settleDiscordProgressCleanupDebt,
    } = serviceHarness();
    const working = progressAction();
    let mappingState: ThreadSessionMap = {
      ...mapping,
      metadata: {
        ...mapping.metadata,
        discord_progress_task_id: ids.task,
        discord_progress_revision: 1,
        discord_progress_state: 'working',
        discord_progress_tool_name: 'Grep',
      },
    };
    const providerRepo = (
      service as unknown as {
        providerActionRepo: { findById: ReturnType<typeof vi.fn> };
      }
    ).providerActionRepo;
    providerRepo.findById.mockResolvedValue(working);
    (
      service as unknown as { threadMapRepo: { findById: ReturnType<typeof vi.fn> } }
    ).threadMapRepo.findById.mockImplementation(async () => mappingState);
    armDiscordProgressCreate.mockImplementation(async () => {
      mappingState = {
        ...mappingState,
        metadata: {
          ...(mappingState.metadata ?? {}),
          discord_progress_cleanup_debt: [{ task_id: ids.task }],
        },
      };
      return 'updated';
    });
    let finishCreate!: (value: string) => void;
    const createGate = new Promise<string>((resolve) => {
      finishCreate = resolve;
    });
    const sendMessage = vi.fn(async () => createGate);
    const deleteMessage = vi.fn(async () => undefined);
    const ownerMap = (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors;
    ownerMap.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        sendMessage,
        sendMessageRecoverable: recoverableSend(sendMessage),
        sendDeliveryChunk: recoverableSend(sendMessage),
        deleteMessage,
        triggerTyping: vi.fn(async () => undefined),
      },
    });

    const staleExecution = executeOwnedAction(service, working, 'action-a');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    mappingState = {
      ...mappingState,
      metadata: {
        ...mapping.metadata,
        discord_progress_task_id: ids.task,
        discord_progress_revision: 2,
        discord_progress_state: 'done',
        discord_progress_cleanup_debt: [{ task_id: ids.task }],
      },
    };
    updateDiscordProgressHandle.mockResolvedValueOnce('fenced');
    recordDiscordProgressCleanupDebt.mockImplementationOnce(async (input) => {
      mappingState = {
        ...mappingState,
        metadata: {
          ...(mappingState.metadata ?? {}),
          discord_progress_cleanup_debt: [
            { task_id: ids.task, provider_message_id: input.providerMessageId },
          ],
        },
      };
      return 'updated';
    });
    finishCreate('823456789012345679');
    await expect(staleExecution).resolves.toEqual({ outcome: 'claim_lost' });

    const done = progressAction({
      params: { state: 'done', revision: 2 },
      drop_after: null,
      claim_token: 'action-b',
      claim_generation: 2,
      claim_listener_token: 'listener-b',
      claim_listener_generation: 2,
    });
    providerRepo.findById.mockResolvedValue(done);
    settleDiscordProgressCleanupDebt.mockImplementationOnce(async () => {
      mappingState = {
        ...mappingState,
        metadata: {
          ...(mappingState.metadata ?? {}),
          discord_progress_cleanup_debt: undefined,
        },
      };
      return 'updated';
    });
    ownerMap.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-b',
      generation: 2,
      phase: 'ready',
      connector: {
        sendMessage: vi.fn(),
        sendMessageRecoverable: recoverableSend(vi.fn()),
        sendDeliveryChunk: recoverableSend(vi.fn()),
        deleteMessage,
        triggerTyping: vi.fn(async () => undefined),
      },
    });

    await expect(
      executeOwnedAction(service, done, 'action-b', {
        listenerClaimToken: 'listener-b',
        listenerGeneration: 2,
      })
    ).resolves.toEqual({
      outcome: 'complete',
      result: { kind: 'discord_progress', outcome: 'cleaned' },
    });
    expect(deleteMessage).toHaveBeenCalledWith({
      threadId: mapping.thread_id,
      messageId: '823456789012345679',
    });
  });

  it('does not let task A operate task B handle after a task switch during POST', async () => {
    const {
      service,
      updateDiscordProgressHandle,
      recordDiscordProgressCleanupDebt,
      settleDiscordProgressCleanupDebt,
    } = serviceHarness();
    const actionA = progressAction();
    const taskB = { ...task, task_id: ids.taskB } as Task;
    let mappingState: ThreadSessionMap = {
      ...mapping,
      metadata: {
        ...mapping.metadata,
        discord_progress_task_id: ids.task,
        discord_progress_revision: 1,
        discord_progress_state: 'working',
        discord_progress_tool_name: 'Grep',
      },
    };
    const providerRepo = (
      service as unknown as {
        providerActionRepo: { findById: ReturnType<typeof vi.fn> };
      }
    ).providerActionRepo;
    providerRepo.findById.mockResolvedValue(actionA);
    (
      service as unknown as { threadMapRepo: { findById: ReturnType<typeof vi.fn> } }
    ).threadMapRepo.findById.mockImplementation(async () => mappingState);
    (
      service as unknown as { taskRepo: { findById: ReturnType<typeof vi.fn> } }
    ).taskRepo.findById.mockImplementation(async (taskId: string) =>
      taskId === ids.taskB ? taskB : task
    );
    let finishCreate!: (value: string) => void;
    const createGate = new Promise<string>((resolve) => {
      finishCreate = resolve;
    });
    const sendA = vi.fn(async () => createGate);
    const ownerMap = (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors;
    ownerMap.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        sendMessage: sendA,
        sendMessageRecoverable: recoverableSend(sendA),
        sendDeliveryChunk: recoverableSend(sendA),
        deleteMessage: vi.fn(async () => undefined),
        triggerTyping: vi.fn(async () => undefined),
      },
    });
    const staleExecution = executeOwnedAction(service, actionA, 'action-a');
    await vi.waitFor(() => expect(sendA).toHaveBeenCalledOnce());
    mappingState = {
      ...mappingState,
      metadata: {
        ...mapping.metadata,
        discord_progress_task_id: ids.taskB,
        discord_progress_revision: 2,
        discord_progress_state: 'working',
        discord_progress_cleanup_debt: [{ task_id: ids.task }],
      },
    };
    updateDiscordProgressHandle.mockResolvedValueOnce('superseded');
    recordDiscordProgressCleanupDebt.mockImplementationOnce(async (input) => {
      mappingState = {
        ...mappingState,
        metadata: {
          ...(mappingState.metadata ?? {}),
          discord_progress_cleanup_debt: [
            { task_id: ids.task, provider_message_id: input.providerMessageId },
          ],
        },
      };
      return 'updated';
    });
    finishCreate('823456789012345679');
    await expect(staleExecution).resolves.toEqual({ outcome: 'claim_lost' });

    const actionB = progressAction({
      id: ids.actionB as never,
      idempotency_key: `discord_progress:${ids.mapping}:${ids.taskB}`,
      task_id: ids.taskB as never,
      params: { state: 'working', revision: 2 },
      claim_token: 'action-b',
      claim_generation: 1,
      claim_listener_token: 'listener-b',
      claim_listener_generation: 2,
    });
    providerRepo.findById.mockResolvedValue(actionB);
    settleDiscordProgressCleanupDebt.mockImplementationOnce(async () => {
      mappingState = {
        ...mappingState,
        metadata: {
          ...(mappingState.metadata ?? {}),
          discord_progress_cleanup_debt: undefined,
        },
      };
      return 'updated';
    });
    const deleteB = vi.fn(async () => undefined);
    const sendB = vi.fn(async () => '923456789012345679');
    ownerMap.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-b',
      generation: 2,
      phase: 'ready',
      connector: {
        sendMessage: sendB,
        sendMessageRecoverable: recoverableSend(sendB),
        sendDeliveryChunk: recoverableSend(sendB),
        deleteMessage: deleteB,
        triggerTyping: vi.fn(async () => undefined),
      },
    });

    await expect(
      executeOwnedAction(service, actionB, 'action-b', {
        listenerClaimToken: 'listener-b',
        listenerGeneration: 2,
      })
    ).resolves.toMatchObject({ outcome: 'complete' });
    expect(deleteB).toHaveBeenCalledWith({
      threadId: mapping.thread_id,
      messageId: '823456789012345679',
    });
    expect(sendB).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { discord_nonce_seed: `discord-progress:${ids.mapping}:${ids.taskB}` },
      })
    );
    expect(deleteB.mock.invocationCallOrder[0]).toBeLessThan(sendB.mock.invocationCallOrder[0]);
  });

  it('retries expired stable-nonce cleanup and completes it after owner takeover', async () => {
    const { service, recordDiscordProgressCleanupDebt, settleDiscordProgressCleanupDebt } =
      serviceHarness();
    let mappingState: ThreadSessionMap = {
      ...mapping,
      metadata: {
        ...mapping.metadata,
        discord_progress_task_id: ids.task,
        discord_progress_revision: 2,
        discord_progress_state: 'done',
        discord_progress_cleanup_debt: [{ task_id: ids.task }],
      },
    };
    const expiredCleanup = progressAction({
      params: { state: 'done', revision: 2, cleanup_reason: 'activity_expired' },
      drop_after: null,
    });
    const providerRepo = (
      service as unknown as {
        providerActionRepo: { findById: ReturnType<typeof vi.fn> };
      }
    ).providerActionRepo;
    providerRepo.findById.mockResolvedValue(expiredCleanup);
    (
      service as unknown as { threadMapRepo: { findById: ReturnType<typeof vi.fn> } }
    ).threadMapRepo.findById.mockImplementation(async () => mappingState);
    recordDiscordProgressCleanupDebt.mockImplementation(async (input) => {
      mappingState = {
        ...mappingState,
        metadata: {
          ...(mappingState.metadata ?? {}),
          discord_progress_cleanup_debt: [
            { task_id: ids.task, provider_message_id: input.providerMessageId },
          ],
        },
      };
      return 'updated';
    });
    const resolveCreate = vi.fn(async () => '823456789012345679');
    const firstDelete = vi.fn(async () => {
      throw { status: 429, retryAfter: 2_500 };
    });
    const ownerMap = (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors;
    ownerMap.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        sendMessage: resolveCreate,
        sendMessageRecoverable: recoverableSend(resolveCreate),
        sendDeliveryChunk: recoverableSend(resolveCreate),
        deleteMessage: firstDelete,
        triggerTyping: vi.fn(async () => undefined),
      },
    });

    await expect(executeOwnedAction(service, expiredCleanup, 'action-a')).resolves.toEqual({
      outcome: 'retry',
      errorCode: 'discord_rate_limited',
      retryAfterMs: 2_500,
    });
    expect(resolveCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { discord_nonce_seed: `discord-progress:${ids.mapping}:${ids.task}` },
      })
    );

    const takeoverCleanup = progressAction({
      params: { state: 'done', revision: 2, cleanup_reason: 'activity_expired' },
      drop_after: null,
      claim_token: 'action-b',
      claim_generation: 2,
      claim_listener_token: 'listener-b',
      claim_listener_generation: 2,
    });
    providerRepo.findById.mockResolvedValue(takeoverCleanup);
    settleDiscordProgressCleanupDebt.mockImplementationOnce(async () => {
      mappingState = {
        ...mappingState,
        metadata: {
          ...(mappingState.metadata ?? {}),
          discord_progress_cleanup_debt: undefined,
        },
      };
      return 'updated';
    });
    const takeoverDelete = vi.fn(async () => undefined);
    const takeoverSend = vi.fn();
    ownerMap.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-b',
      generation: 2,
      phase: 'ready',
      connector: {
        sendMessage: takeoverSend,
        sendMessageRecoverable: recoverableSend(takeoverSend),
        sendDeliveryChunk: recoverableSend(takeoverSend),
        deleteMessage: takeoverDelete,
        triggerTyping: vi.fn(async () => undefined),
      },
    });
    await expect(
      executeOwnedAction(service, takeoverCleanup, 'action-b', {
        listenerClaimToken: 'listener-b',
        listenerGeneration: 2,
      })
    ).resolves.toEqual({
      outcome: 'complete',
      result: {
        kind: 'discord_progress',
        outcome: 'cleaned',
        reason: 'activity_expired',
      },
    });
    expect(takeoverSend).not.toHaveBeenCalled();
    expect(takeoverDelete).toHaveBeenCalledWith({
      threadId: mapping.thread_id,
      messageId: '823456789012345679',
    });
  });

  it('cleans a task progress handle after final delivery and accepts a 404 delete', async () => {
    const { service, prepareDiscordProgressCleanup, settleDiscordProgressCleanupDebt } =
      serviceHarness();
    const progressMapping = {
      ...mapping,
      metadata: {
        ...mapping.metadata,
        discord_progress_task_id: ids.task,
        discord_progress_revision: 4,
        discord_progress_state: 'working',
        discord_progress_message_id: '723456789012345678',
      },
    };
    (
      service as unknown as { threadMapRepo: { findById: ReturnType<typeof vi.fn> } }
    ).threadMapRepo.findById.mockResolvedValue(progressMapping);
    prepareDiscordProgressCleanup.mockImplementation(async () => {
      (
        service as unknown as { threadMapRepo: { findById: ReturnType<typeof vi.fn> } }
      ).threadMapRepo.findById.mockResolvedValue({
        ...progressMapping,
        metadata: {
          ...progressMapping.metadata,
          discord_progress_revision: 5,
          discord_progress_state: 'done',
          discord_progress_message_id: undefined,
          discord_progress_cleanup_debt: [
            {
              task_id: ids.task,
              provider_message_id: '723456789012345678',
            },
          ],
        },
      });
      return 'updated';
    });
    const sendMessage = vi.fn(async () => '823456789012345679');
    const deleteMessage = vi.fn(async () => {
      throw { status: 404, rawError: { code: 10008 } };
    });
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        sendMessage,
        sendMessageRecoverable: recoverableSend(sendMessage),
        sendDeliveryChunk: recoverableSend(sendMessage),
        deleteMessage,
        triggerTyping: vi.fn(async () => undefined),
      },
    });

    const result = await runWithTenantContext('tenant-a', () =>
      (
        service as unknown as {
          executeDiscordProviderAction: (
            owner: Record<string, unknown>,
            action: GatewayProviderAction,
            token: string
          ) => Promise<Record<string, unknown>>;
        }
      ).executeDiscordProviderAction(
        {
          tenantId: 'tenant-a',
          channelId: ids.channel,
          listenerClaimToken: 'listener-a',
          listenerGeneration: 1,
        },
        providerAction(),
        'action-a'
      )
    );

    expect(result).toMatchObject({ outcome: 'complete' });
    expect(deleteMessage).toHaveBeenCalledWith({
      threadId: mapping.thread_id,
      messageId: '723456789012345678',
    });
    expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      deleteMessage.mock.invocationCallOrder[0]
    );
    expect(settleDiscordProgressCleanupDebt).toHaveBeenCalledWith(
      expect.objectContaining({
        debt: {
          taskId: ids.task,
          providerMessageId: '723456789012345678',
        },
      })
    );
  });

  it('never lets task A final delivery delete task B current handle', async () => {
    const { service } = serviceHarness();
    const taskBMapping = {
      ...mapping,
      metadata: {
        ...mapping.metadata,
        discord_progress_task_id: ids.taskB,
        discord_progress_revision: 5,
        discord_progress_state: 'working',
        discord_progress_message_id: '923456789012345678',
      },
    };
    (
      service as unknown as { threadMapRepo: { findById: ReturnType<typeof vi.fn> } }
    ).threadMapRepo.findById.mockResolvedValue(taskBMapping);
    const sendMessage = vi.fn(async () => '823456789012345679');
    const deleteMessage = vi.fn(async () => undefined);
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      phase: 'ready',
      connector: {
        sendMessage,
        sendMessageRecoverable: recoverableSend(sendMessage),
        sendDeliveryChunk: recoverableSend(sendMessage),
        deleteMessage,
        triggerTyping: vi.fn(async () => undefined),
      },
    });

    await expect(executeOwnedAction(service, providerAction(), 'action-a')).resolves.toMatchObject({
      outcome: 'complete',
    });
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('performs zero REST calls when the listener fence is lost before admission', async () => {
    const { service, admitProviderCall, listenerClaimIsCurrent } = serviceHarness();
    listenerClaimIsCurrent.mockResolvedValue(false);
    const sendMessage = vi.fn();
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      lease_expires_at: '2099-01-01T00:00:00.000Z',
      phase: 'ready',
      connector: { sendMessage },
    });

    const result = await runWithTenantContext('tenant-a', () =>
      (
        service as unknown as {
          executeDiscordProviderAction: (
            owner: Record<string, unknown>,
            action: GatewayProviderAction,
            token: string
          ) => Promise<Record<string, unknown>>;
        }
      ).executeDiscordProviderAction(
        {
          tenantId: 'tenant-a',
          channelId: ids.channel,
          listenerClaimToken: 'listener-a',
          listenerGeneration: 1,
        },
        providerAction(),
        'action-a'
      )
    );

    expect(result).toEqual({ outcome: 'owner_lost' });
    expect(admitProviderCall).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not expose an owner connector across tenant context', async () => {
    const { service, admitProviderCall, listenerClaimIsCurrent } = serviceHarness();
    const sendMessage = vi.fn();
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      lease_expires_at: '2099-01-01T00:00:00.000Z',
      phase: 'ready',
      connector: { sendMessage },
    });

    const result = await runWithTenantContext('tenant-b', () =>
      (
        service as unknown as {
          executeDiscordProviderAction: (
            owner: Record<string, unknown>,
            action: GatewayProviderAction,
            token: string
          ) => Promise<Record<string, unknown>>;
        }
      ).executeDiscordProviderAction(
        {
          tenantId: 'tenant-a',
          channelId: ids.channel,
          listenerClaimToken: 'listener-a',
          listenerGeneration: 1,
        },
        providerAction(),
        'action-a'
      )
    );

    expect(result).toEqual({ outcome: 'owner_lost' });
    expect(listenerClaimIsCurrent).not.toHaveBeenCalled();
    expect(admitProviderCall).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('uses the database owner fence even when the process clock is far ahead', async () => {
    const { service, listenerClaimIsCurrent } = serviceHarness();
    const connector = { sendMessage: vi.fn() };
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(`tenant-a\0${ids.channel}`, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      lease_expires_at: '2026-08-18T00:00:01.000Z',
      phase: 'ready',
      connector,
    });
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2099-01-01T00:00:00.000Z').getTime());
    try {
      const owned = await runWithTenantContext('tenant-a', () =>
        (
          service as unknown as {
            getOwnedDiscordConnector: (input: Record<string, unknown>) => Promise<unknown>;
          }
        ).getOwnedDiscordConnector({
          tenantId: 'tenant-a',
          channelId: ids.channel,
          listenerClaimToken: 'listener-a',
          listenerGeneration: 1,
          allowStarting: false,
        })
      );
      expect(owned).toBe(connector);
      expect(listenerClaimIsCurrent).toHaveBeenCalledOnce();
    } finally {
      now.mockRestore();
    }
  });

  it('installs the provisional exact connector for startup callbacks and drains only after readiness', async () => {
    const { service, listenerClaimIsCurrent } = serviceHarness();
    const lease = {
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      claimed_at: '2026-08-18T00:00:00.000Z',
      lease_expires_at: '2099-01-01T00:00:00.000Z',
      instance_id: 'daemon-a',
      boot_id: 'boot-a',
      checkpoint: null,
    };
    const processorStart = vi.fn();
    const processorUpdate = vi.fn();
    const processorStop = vi.fn(async () => true);
    Object.assign(service as unknown as Record<string, unknown>, {
      durableProviderGate: () => true,
      providerActionProcessor: {
        start: processorStart,
        updateOwner: processorUpdate,
        stop: processorStop,
      },
      channelRepo: {
        renewListener: vi.fn(async () => lease),
        listenerClaimIsCurrent,
        releaseListener: vi.fn(async () => true),
      },
    });
    const sendMessage = vi.fn();
    const updateAggregatePresence = vi.fn();
    const connector = {
      sendMessage,
      updateAggregatePresence,
      startListening: vi.fn(async () => {
        expect(processorStart).not.toHaveBeenCalled();
        const provisional = await (
          service as unknown as {
            getOwnedDiscordConnector: (input: Record<string, unknown>) => Promise<unknown>;
          }
        ).getOwnedDiscordConnector({
          tenantId: 'tenant-a',
          channelId: ids.channel,
          listenerClaimToken: 'listener-a',
          listenerGeneration: 1,
          allowStarting: true,
        });
        expect(provisional).toBe(connector);
        const unavailableToDrainer = await (
          service as unknown as {
            getOwnedDiscordConnector: (input: Record<string, unknown>) => Promise<unknown>;
          }
        ).getOwnedDiscordConnector({
          tenantId: 'tenant-a',
          channelId: ids.channel,
          listenerClaimToken: 'listener-a',
          listenerGeneration: 1,
          allowStarting: false,
        });
        expect(unavailableToDrainer).toBeUndefined();
      }),
      stopListening: vi.fn(async () => undefined),
    };
    vi.mocked(getConnector).mockReturnValue(connector as never);

    await runWithTenantContext('tenant-a', () =>
      (
        service as unknown as {
          startChannelListener: (
            channel: GatewayChannel,
            tenantId: string,
            lease: typeof lease
          ) => Promise<void>;
        }
      ).startChannelListener(channel, 'tenant-a', lease)
    );

    expect(connector.startListening).toHaveBeenCalledOnce();
    expect(processorStart).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      channelId: ids.channel,
      listenerClaimToken: 'listener-a',
      listenerGeneration: 1,
    });
    expect(updateAggregatePresence).toHaveBeenCalledWith(2);
    await runWithTenantContext('tenant-a', () => service.stopChannelListener(ids.channel));
    expect(processorStop).toHaveBeenCalled();
    expect(connector.stopListening).toHaveBeenCalledOnce();
  });

  it('reconstructs presence on a takeover owner and fences a lost owner before requesting a send', async () => {
    const { service, listenerClaimIsCurrent, countActiveDiscordProgress } = serviceHarness();
    const updateAggregatePresence = vi.fn();
    const key = `tenant-a\0${ids.channel}`;
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(key, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-b',
      generation: 2,
      phase: 'ready',
      connector: { updateAggregatePresence },
    });
    const refresh = () =>
      runWithTenantContext('tenant-a', () =>
        (
          service as unknown as {
            refreshDiscordAggregatePresence: (owner: Record<string, unknown>) => Promise<void>;
          }
        ).refreshDiscordAggregatePresence({
          tenantId: 'tenant-a',
          channelId: ids.channel,
          listenerClaimToken: 'listener-b',
          listenerGeneration: 2,
        })
      );

    await refresh();
    expect(countActiveDiscordProgress).toHaveBeenCalledWith(ids.channel);
    expect(updateAggregatePresence).toHaveBeenCalledWith(2);

    updateAggregatePresence.mockClear();
    listenerClaimIsCurrent.mockResolvedValue(false);
    await refresh();
    expect(updateAggregatePresence).not.toHaveBeenCalled();
  });

  it('removes owner access and keeps the listener claim when action shutdown cannot drain', async () => {
    const { service } = serviceHarness();
    const stopListening = vi.fn(async () => {
      const owner = (
        service as unknown as { ownedDiscordConnectors: Map<string, unknown> }
      ).ownedDiscordConnectors.get(`tenant-a\0${ids.channel}`);
      expect(owner).toBeUndefined();
    });
    const releaseListener = vi.fn(async () => true);
    const key = `tenant-a\0${ids.channel}`;
    (
      service as unknown as { activeListeners: Map<string, Record<string, unknown>> }
    ).activeListeners.set(key, { stopListening });
    (
      service as unknown as { activeListenerLeases: Map<string, Record<string, unknown>> }
    ).activeListenerLeases.set(key, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
    });
    (
      service as unknown as { ownedDiscordConnectors: Map<string, Record<string, unknown>> }
    ).ownedDiscordConnectors.set(key, {
      tenant_id: 'tenant-a',
      channel_id: ids.channel,
      claim_token: 'listener-a',
      generation: 1,
      connector: { stopListening },
    });
    Object.assign(service as unknown as Record<string, unknown>, {
      providerActionProcessor: { stop: vi.fn(async () => false) },
      channelRepo: { releaseListener },
    });

    const stopped = await runWithTenantContext('tenant-a', () =>
      service.stopChannelListener(ids.channel)
    );
    expect(stopped).toBe(false);
    expect(stopListening).toHaveBeenCalledOnce();
    expect(releaseListener).not.toHaveBeenCalled();
  });
});
