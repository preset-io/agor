import {
  type DiscordMessageDeliveryClaim,
  DiscordMessageDeliveryClaimLostError,
  type DiscordMessageDeliveryDiscoveryRef,
} from '@agor/core/db';
import type { GatewayConnector, GatewaySendReceipt } from '@agor/core/gateway';
import type {
  DiscordMessageDelivery,
  DiscordMessageDeliveryChunkReceipt,
  DiscordMessageDeliveryID,
  GatewayChannel,
  Message,
  ThreadSessionMap,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  DiscordMessageDeliveryWorker,
  deterministicDiscordDeliveryNonce,
  fairOrderByTenant,
} from './discord-message-delivery-worker';

const DELIVERY_ID = '018f5f63-0fd1-7c2e-9e7d-8fb27d4a6e1a' as DiscordMessageDeliveryID;
const MESSAGE_ID = '018f5f63-0fd1-7c2e-9e7d-8fb27d4a6e1b' as never;
const SESSION_ID = '018f5f63-0fd1-7c2e-9e7d-8fb27d4a6e1c' as never;
const CHANNEL_ID = '018f5f63-0fd1-7c2e-9e7d-8fb27d4a6d1a' as never;
const MAPPING_ID = '018f5f63-0fd1-7c2e-9e7d-8fb27d4a6d1b' as never;
const NOW = new Date('2026-08-20T12:00:00.000Z');

function copyDelivery(delivery: DiscordMessageDelivery): DiscordMessageDelivery {
  return {
    ...delivery,
    chunk_receipts: delivery.chunk_receipts.map((receipt) => ({
      ...receipt,
      reply_aliases: [...receipt.reply_aliases],
    })),
    reply_aliases: [...delivery.reply_aliases],
  };
}

class FakeDeliveryRepository {
  row: DiscordMessageDelivery;
  checkpointLost = 0;
  completeLost = 0;
  completeCalls = 0;
  crashBeforeComplete = false;
  crashAfterMark = false;
  afterCheckpoint?: () => Promise<void>;
  onComplete?: (delivery: DiscordMessageDelivery) => void;

  constructor() {
    this.row = {
      delivery_id: DELIVERY_ID,
      message_id: MESSAGE_ID,
      gateway_channel_id: CHANNEL_ID,
      thread_session_map_id: MAPPING_ID,
      provider_installation_id: 'discord-installation',
      provider_config_generation: 1,
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: NOW.toISOString(),
      claim_token: null,
      claim_expires_at: null,
      claim_generation: 0,
      ambiguous_chunk_index: null,
      effect_started_at: null,
      effect_recovery_grace_until: null,
      chunk_receipts: [],
      reply_aliases: [],
      last_error_code: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      completed_at: null,
      canceled_at: null,
      dead_lettered_at: null,
    };
  }

  private current(token: string, generation: number, now: Date): boolean {
    return (
      this.row.status === 'processing' &&
      this.row.claim_token === token &&
      this.row.claim_generation === generation &&
      !!this.row.claim_expires_at &&
      new Date(this.row.claim_expires_at) > now
    );
  }

  async findDueRefs(
    _db: never,
    options: { limit?: number; now?: Date } = {}
  ): Promise<DiscordMessageDeliveryDiscoveryRef[]> {
    const now = options.now ?? new Date();
    const due =
      new Date(this.row.next_attempt_at) <= now &&
      (this.row.status === 'pending' ||
        (this.row.status === 'processing' &&
          (!this.row.claim_expires_at || new Date(this.row.claim_expires_at) <= now)));
    return due && (options.limit ?? 25) > 0
      ? [
          {
            tenant_id: 'tenant-test',
            delivery_id: this.row.delivery_id,
            thread_session_map_id: this.row.thread_session_map_id,
          },
        ]
      : [];
  }

  async claim(
    deliveryId: DiscordMessageDeliveryID,
    claimToken: string,
    leaseDurationMs: number,
    now = new Date()
  ): Promise<DiscordMessageDeliveryClaim | null> {
    if (deliveryId !== this.row.delivery_id) return null;
    const claimable =
      new Date(this.row.next_attempt_at) <= now &&
      (this.row.status === 'pending' ||
        (this.row.status === 'processing' &&
          (!this.row.claim_expires_at || new Date(this.row.claim_expires_at) <= now)));
    if (!claimable) return null;
    this.row = {
      ...this.row,
      status: 'processing',
      claim_token: claimToken,
      claim_expires_at: new Date(now.getTime() + leaseDurationMs).toISOString(),
      claim_generation: this.row.claim_generation + 1,
      attempt_count: this.row.attempt_count + 1,
      updated_at: now.toISOString(),
    };
    return {
      delivery_id: deliveryId,
      claim_token: claimToken,
      claim_generation: this.row.claim_generation,
      lease_expires_at: this.row.claim_expires_at!,
      delivery: copyDelivery(this.row),
    };
  }

  async reloadClaim(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    now?: Date;
  }): Promise<DiscordMessageDelivery | null> {
    const now = input.now ?? new Date();
    return input.deliveryId === this.row.delivery_id &&
      this.current(input.claimToken, input.claimGeneration, now)
      ? copyDelivery(this.row)
      : null;
  }

  async renewClaim(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    leaseDurationMs: number;
    now?: Date;
  }): Promise<DiscordMessageDeliveryClaim | null> {
    const now = input.now ?? new Date();
    if (
      input.deliveryId !== this.row.delivery_id ||
      !this.current(input.claimToken, input.claimGeneration, now)
    ) {
      return null;
    }
    this.row = {
      ...this.row,
      claim_expires_at: new Date(now.getTime() + input.leaseDurationMs).toISOString(),
      updated_at: now.toISOString(),
    };
    return {
      delivery_id: this.row.delivery_id,
      claim_token: input.claimToken,
      claim_generation: input.claimGeneration,
      lease_expires_at: this.row.claim_expires_at!,
      delivery: copyDelivery(this.row),
    };
  }

  async checkpointChunk(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    receipt: DiscordMessageDeliveryChunkReceipt;
    now?: Date;
  }): Promise<DiscordMessageDelivery> {
    const now = input.now ?? new Date();
    if (
      input.deliveryId !== this.row.delivery_id ||
      !this.current(input.claimToken, input.claimGeneration, now)
    ) {
      this.checkpointLost += 1;
      throw new DiscordMessageDeliveryClaimLostError(input.deliveryId);
    }
    if (
      this.row.ambiguous_chunk_index !== input.receipt.chunk_index &&
      !this.row.chunk_receipts.some((item) => item.chunk_index === input.receipt.chunk_index)
    ) {
      throw new Error('Discord delivery checkpoint lacked an effect marker');
    }
    if (!this.row.chunk_receipts.some((item) => item.chunk_index === input.receipt.chunk_index)) {
      this.row = {
        ...this.row,
        ambiguous_chunk_index: null,
        effect_started_at: null,
        effect_recovery_grace_until: null,
        chunk_receipts: [...this.row.chunk_receipts, input.receipt],
        reply_aliases: [...new Set([...this.row.reply_aliases, ...input.receipt.reply_aliases])],
        updated_at: now.toISOString(),
      };
    }
    if (this.afterCheckpoint) await this.afterCheckpoint();
    return copyDelivery(this.row);
  }

  async markChunkEffectStarted(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    chunkIndex: number;
    recoveryGraceMs?: number;
    now?: Date;
  }): Promise<DiscordMessageDelivery> {
    const now = input.now ?? new Date();
    if (
      input.deliveryId !== this.row.delivery_id ||
      !this.current(input.claimToken, input.claimGeneration, now)
    ) {
      throw new DiscordMessageDeliveryClaimLostError(input.deliveryId);
    }
    if (
      this.row.ambiguous_chunk_index !== null &&
      this.row.ambiguous_chunk_index !== input.chunkIndex
    ) {
      throw new Error('another ambiguous chunk');
    }
    this.row = {
      ...this.row,
      ambiguous_chunk_index: input.chunkIndex,
      effect_started_at: now.toISOString(),
      effect_recovery_grace_until: new Date(
        now.getTime() + (input.recoveryGraceMs ?? 60_000)
      ).toISOString(),
      updated_at: now.toISOString(),
    };
    if (this.crashAfterMark) {
      this.crashAfterMark = false;
      throw new Error('daemon crashed after effect marker');
    }
    return copyDelivery(this.row);
  }

  async clearChunkEffectMarker(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    chunkIndex: number;
    now?: Date;
  }): Promise<DiscordMessageDelivery> {
    const now = input.now ?? new Date();
    if (
      input.deliveryId !== this.row.delivery_id ||
      !this.current(input.claimToken, input.claimGeneration, now)
    ) {
      throw new DiscordMessageDeliveryClaimLostError(input.deliveryId);
    }
    if (this.row.ambiguous_chunk_index === input.chunkIndex) {
      this.row = {
        ...this.row,
        ambiguous_chunk_index: null,
        effect_started_at: null,
        effect_recovery_grace_until: null,
        updated_at: now.toISOString(),
      };
    }
    return copyDelivery(this.row);
  }

  async completeClaim(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    now?: Date;
  }): Promise<DiscordMessageDelivery> {
    this.completeCalls += 1;
    const now = input.now ?? new Date();
    if (
      input.deliveryId !== this.row.delivery_id ||
      !this.current(input.claimToken, input.claimGeneration, now)
    ) {
      this.completeLost += 1;
      throw new DiscordMessageDeliveryClaimLostError(input.deliveryId);
    }
    if (this.crashBeforeComplete) {
      this.crashBeforeComplete = false;
      throw new Error('daemon crashed before alias merge completed');
    }
    this.row = {
      ...this.row,
      status: 'completed',
      claim_token: null,
      claim_expires_at: null,
      completed_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.onComplete?.(copyDelivery(this.row));
    return copyDelivery(this.row);
  }

  async failClaim(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    status: 'pending' | 'canceled' | 'dead_letter';
    errorCode: string;
    nextAttemptAt?: Date;
    now?: Date;
  }): Promise<DiscordMessageDelivery> {
    const now = input.now ?? new Date();
    if (
      input.deliveryId !== this.row.delivery_id ||
      !this.current(input.claimToken, input.claimGeneration, now)
    ) {
      throw new DiscordMessageDeliveryClaimLostError(input.deliveryId);
    }
    this.row = {
      ...this.row,
      status: input.status,
      claim_token: null,
      claim_expires_at: null,
      last_error_code: input.errorCode,
      next_attempt_at: (input.nextAttemptAt ?? now).toISOString(),
      canceled_at: input.status === 'canceled' ? now.toISOString() : null,
      dead_lettered_at: input.status === 'dead_letter' ? now.toISOString() : null,
      updated_at: now.toISOString(),
    };
    return copyDelivery(this.row);
  }

  async purgeExpired(): Promise<number> {
    return 0;
  }
}

function makeHarness(
  options: {
    messageText?: string;
    channel?: Partial<GatewayChannel>;
    mappingMetadata?: Record<string, unknown>;
    now?: Date;
  } = {}
) {
  const repository = new FakeDeliveryRepository();
  const message = {
    message_id: MESSAGE_ID,
    session_id: SESSION_ID,
    type: 'assistant',
    role: 'assistant',
    index: 0,
    timestamp: NOW.toISOString(),
    content_preview: options.messageText ?? 'A durable reply',
    content: options.messageText ?? 'A durable reply',
    metadata: { source: 'executor' },
  } as unknown as Message;
  const mapping = {
    id: MAPPING_ID,
    channel_id: CHANNEL_ID,
    thread_id: 'discord:message:333333333333333333:888888888888888888',
    session_id: SESSION_ID,
    branch_id: '018f5f63-0fd1-7c2e-9e7d-8fb27d4a6d1c',
    status: 'active',
    metadata: options.mappingMetadata ?? {},
  } as unknown as ThreadSessionMap;
  const channel = {
    id: CHANNEL_ID,
    name: 'Test Discord',
    channel_type: 'discord',
    enabled: true,
    provider_installation_id: 'discord-installation',
    provider_config_generation: 1,
    config: { application_id: 'application-id' },
    ...options.channel,
  } as unknown as GatewayChannel;
  const receipts = new Map<string, GatewaySendReceipt>();
  const sendMessage = vi.fn(
    async (request: { metadata?: Record<string, unknown>; threadId: string; text: string }) => {
      const nonce = request.metadata?.discord_delivery_nonce as string;
      const receipt = {
        messageId: `provider-${receipts.size + 1}`,
        replyAliases: [`discord:message:333333333333333333:${receipts.size + 1}`],
      } satisfies GatewaySendReceipt;
      receipts.set(nonce, receipt);
      return receipt;
    }
  );
  const recoverMessageByNonce = vi.fn(
    async (request: { nonce: string; threadId: string }) => receipts.get(request.nonce) ?? null
  );
  const connector: GatewayConnector = {
    channelType: 'discord',
    sendMessage,
    recoverMessageByNonce,
  };
  let now = options.now ?? new Date(NOW);
  const workerOptions = {
    tenantId: 'tenant-test',
    leaseDurationMs: 30,
    discover: async () => [
      {
        tenant_id: 'tenant-test',
        delivery_id: repository.row.delivery_id,
        thread_session_map_id: repository.row.thread_session_map_id,
      },
    ],
    now: () => new Date(now),
    repositories: {
      delivery: repository,
      channel: { findById: vi.fn(async () => channel) },
      mapping: { findById: vi.fn(async () => mapping) },
      message: { findById: vi.fn(async () => message) },
    },
    connectorFactory: vi.fn(() => connector),
  } as const;
  const makeWorker = (overrides: Record<string, unknown> = {}) =>
    new DiscordMessageDeliveryWorker(
      {} as never,
      {
        ...workerOptions,
        ...overrides,
      } as never
    );
  return {
    repository,
    message,
    mapping,
    channel,
    receipts,
    sendMessage,
    recoverMessageByNonce,
    connector,
    makeWorker,
    get now() {
      return now;
    },
    set now(value: Date) {
      now = value;
    },
  };
}

describe('DiscordMessageDeliveryWorker', () => {
  it('derives stable bounded nonces per delivery chunk', () => {
    const first = deterministicDiscordDeliveryNonce(DELIVERY_ID, 0);
    expect(first).toBe(deterministicDiscordDeliveryNonce(DELIVERY_ID, 0));
    expect(first).not.toBe(deterministicDiscordDeliveryNonce(DELIVERY_ID, 1));
    expect(first).toMatch(/^agor-[0-9a-f]{16}-0$/);
    expect(first.length).toBeLessThanOrEqual(25);
  });

  it('round-robins discovery across tenants before applying bounded concurrency', () => {
    const refs: DiscordMessageDeliveryDiscoveryRef[] = [
      {
        tenant_id: 'tenant-a',
        delivery_id: 'a-1' as DiscordMessageDeliveryID,
        thread_session_map_id: 'map-a' as never,
      },
      {
        tenant_id: 'tenant-a',
        delivery_id: 'a-2' as DiscordMessageDeliveryID,
        thread_session_map_id: 'map-a' as never,
      },
      {
        tenant_id: 'tenant-b',
        delivery_id: 'b-1' as DiscordMessageDeliveryID,
        thread_session_map_id: 'map-b' as never,
      },
      {
        tenant_id: 'tenant-a',
        delivery_id: 'a-3' as DiscordMessageDeliveryID,
        thread_session_map_id: 'map-a' as never,
      },
    ];

    expect(fairOrderByTenant(refs).map((ref) => ref.delivery_id)).toEqual([
      'a-1',
      'b-1',
      'a-2',
      'a-3',
    ]);
  });

  it('lets duplicate discovery and two workers produce one provider effect', async () => {
    const harness = makeHarness();
    const workerA = harness.makeWorker();
    const workerB = harness.makeWorker();

    await Promise.all([workerA.checkOnce(), workerB.checkOnce()]);

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.repository.row.status).toBe('completed');
  });

  it('takes over before the first send resolves without dead-lettering or duplicating the receipt', async () => {
    const harness = makeHarness();
    let resolveSend!: (receipt: GatewaySendReceipt) => void;
    harness.sendMessage.mockImplementationOnce(
      (request: { metadata?: Record<string, unknown>; threadId: string; text: string }) =>
        new Promise<GatewaySendReceipt>((resolve) => {
          resolveSend = (receipt) => {
            const nonce = request.metadata?.discord_delivery_nonce as string;
            harness.receipts.set(nonce, receipt);
            resolve(receipt);
          };
        })
    );
    const workerOptions = {
      leaseDurationMs: 100,
      providerCallTimeoutMs: 75,
      recoveryGraceMs: 1_000,
    };
    const workerA = harness.makeWorker(workerOptions);
    const first = workerA.checkOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.sendMessage).toHaveBeenCalledOnce();

    harness.now = new Date(NOW.getTime() + 101);
    await harness.makeWorker(workerOptions).checkOnce();
    expect(harness.repository.row).toMatchObject({
      status: 'pending',
      ambiguous_chunk_index: 0,
      effect_recovery_grace_until: expect.any(String),
    });

    resolveSend({ messageId: 'provider-accepted-after-takeover', replyAliases: [] });
    await first;
    expect(harness.repository.row.chunk_receipts).toHaveLength(0);

    harness.now = new Date(harness.repository.row.next_attempt_at);
    await harness.makeWorker(workerOptions).checkOnce();
    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.repository.row).toMatchObject({
      status: 'completed',
      chunk_receipts: [
        expect.objectContaining({ provider_message_id: 'provider-accepted-after-takeover' }),
      ],
    });
  });

  it('fences a stale worker before checkpoint after a lease takeover', async () => {
    const harness = makeHarness();
    const workerA = harness.makeWorker();
    harness.sendMessage.mockImplementationOnce(async (request) => {
      const nonce = request.metadata?.discord_delivery_nonce as string;
      const receipt = { messageId: 'provider-accepted' } satisfies GatewaySendReceipt;
      harness.receipts.set(nonce, receipt);
      harness.now = new Date(harness.now.getTime() + 31);
      await harness.repository.claim(DELIVERY_ID, 'takeover', 30, harness.now);
      harness.now = new Date(harness.now.getTime() + 31);
      return receipt;
    });

    await workerA.checkOnce();
    expect(harness.repository.checkpointLost).toBe(0);
    expect(harness.repository.completeLost).toBe(0);

    harness.now = new Date(harness.now.getTime() + 31);
    await harness.makeWorker().checkOnce();
    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.repository.row.status).toBe('completed');
  });

  it('bounds shutdown drain and leaves an active claim for takeover', async () => {
    const harness = makeHarness();
    let resolveSend!: (receipt: GatewaySendReceipt) => void;
    harness.sendMessage.mockImplementationOnce(
      (request: { metadata?: Record<string, unknown>; threadId: string; text: string }) =>
        new Promise<GatewaySendReceipt>((resolve) => {
          resolveSend = (receipt) => {
            const nonce = request.metadata?.discord_delivery_nonce as string;
            harness.receipts.set(nonce, receipt);
            resolve(receipt);
          };
        })
    );
    const worker = harness.makeWorker({
      leaseDurationMs: 100,
      providerCallTimeoutMs: 75,
      shutdownTimeoutMs: 5,
    });
    const running = worker.checkOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.repository.row.status).toBe('processing');

    await worker.stop();
    expect(harness.repository.row.status).toBe('processing');

    resolveSend({ messageId: 'provider-accepted-after-drain', replyAliases: [] });
    await running;
    expect(harness.repository.row.status).toBe('completed');
  });

  it.each([
    ['disabled', { enabled: false }],
    ['config generation changed', { provider_config_generation: 2 }],
  ] as const)(
    'cancels before any provider call when the channel is %s',
    async (_label, channel) => {
      const harness = makeHarness({ channel });
      await harness.makeWorker().checkOnce();

      expect(harness.sendMessage).not.toHaveBeenCalled();
      expect(harness.recoverMessageByNonce).not.toHaveBeenCalled();
      expect(harness.repository.row).toMatchObject({
        status: 'canceled',
        last_error_code: expect.any(String),
      });
    }
  );

  it('reclaims a lease after a crash before the provider call', async () => {
    const harness = makeHarness();
    await harness.repository.claim(DELIVERY_ID, 'crashed-worker', 30, harness.now);
    harness.now = new Date(harness.now.getTime() + 31);

    await harness.makeWorker().checkOnce();

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.repository.row.status).toBe('completed');
    expect(harness.repository.row.attempt_count).toBe(2);
  });

  it('keeps recovery retryable during the persisted effect grace window', async () => {
    const harness = makeHarness();
    harness.repository.crashAfterMark = true;

    await harness.makeWorker().checkOnce();
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.repository.row).toMatchObject({
      status: 'pending',
      ambiguous_chunk_index: 0,
      effect_started_at: NOW.toISOString(),
    });

    harness.now = new Date(harness.repository.row.next_attempt_at);
    await harness.makeWorker().checkOnce();
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.repository.row).toMatchObject({
      status: 'pending',
      last_error_code: 'nonce_acceptance_unproven',
      ambiguous_chunk_index: 0,
    });

    harness.now = new Date(harness.repository.row.effect_recovery_grace_until!);
    await harness.makeWorker().checkOnce();
    expect(harness.repository.row).toMatchObject({
      status: 'dead_letter',
      last_error_code: 'nonce_acceptance_unproven',
    });
  });

  it('recovers a provider-accepted ambiguous send by exact nonce without resending', async () => {
    const harness = makeHarness();
    harness.sendMessage.mockImplementationOnce(async (request) => {
      const nonce = request.metadata?.discord_delivery_nonce as string;
      harness.receipts.set(nonce, { messageId: 'accepted-before-timeout' });
      throw new Error('connection closed after provider acceptance');
    });

    await harness.makeWorker().checkOnce();

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.recoverMessageByNonce).toHaveBeenCalledTimes(2);
    expect(harness.recoverMessageByNonce.mock.calls[0][0].nonce).toBe(
      harness.recoverMessageByNonce.mock.calls[1][0].nonce
    );
    expect(harness.repository.row.status).toBe('completed');
  });

  it('does not blindly retry an unresolved ambiguous send and dead-letters after grace', async () => {
    const harness = makeHarness();
    harness.sendMessage.mockRejectedValueOnce(new Error('connection outcome unknown'));

    await harness.makeWorker().checkOnce();

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.recoverMessageByNonce).toHaveBeenCalledTimes(2);
    expect(harness.repository.row).toMatchObject({
      status: 'pending',
      last_error_code: 'nonce_acceptance_unproven',
    });

    harness.now = new Date(harness.repository.row.effect_recovery_grace_until!);
    await harness.makeWorker().checkOnce();
    expect(harness.repository.row.status).toBe('dead_letter');
  });

  it('resumes at the next chunk after a persisted checkpoint', async () => {
    const harness = makeHarness({ messageText: 'x'.repeat(2_001) });
    let simulatedCrash = true;
    harness.repository.afterCheckpoint = async () => {
      if (simulatedCrash) {
        simulatedCrash = false;
        throw new Error('daemon crashed after chunk checkpoint');
      }
    };

    await harness.makeWorker().checkOnce();
    expect(harness.repository.row.chunk_receipts).toHaveLength(1);
    expect(harness.repository.row.status).toBe('pending');
    expect(harness.sendMessage).toHaveBeenCalledOnce();

    harness.now = new Date(harness.repository.row.next_attempt_at);
    await harness.makeWorker().checkOnce();

    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    expect(harness.sendMessage.mock.calls[1][0].metadata?.discord_delivery_nonce).toBe(
      deterministicDiscordDeliveryNonce(DELIVERY_ID, 1)
    );
    expect(harness.repository.row.status).toBe('completed');
  });

  it('does not accumulate ordinary Discord response aliases', async () => {
    const harness = makeHarness({ mappingMetadata: { gateway_reply_aliases: ['alias-0'] } });
    harness.repository.crashBeforeComplete = true;
    harness.repository.row.chunk_receipts = [
      {
        chunk_index: 0,
        nonce: deterministicDiscordDeliveryNonce(DELIVERY_ID, 0),
        provider_message_id: 'provider-0',
        reply_aliases: ['alias-0', 'alias-1'],
      },
    ];
    harness.repository.row.reply_aliases = ['alias-0', 'alias-1'];

    await harness.makeWorker().checkOnce();
    expect(harness.repository.row.status).toBe('pending');
    expect(harness.repository.completeCalls).toBe(1);

    harness.now = new Date(harness.repository.row.next_attempt_at);
    await harness.makeWorker().checkOnce();

    expect(harness.mapping.metadata).toEqual({ gateway_reply_aliases: ['alias-0'] });
    expect(harness.repository.completeCalls).toBe(2);
  });

  it.each([
    ['rate limit', { status: 429, retry_after_ms: 5_000 }, 'provider_rate_limited'],
    ['safe transient', { retryable: true, providerAccepted: false }, 'provider_transient'],
  ] as const)('retries a %s failure with bounded scheduling', async (_label, error, code) => {
    const harness = makeHarness();
    harness.sendMessage.mockRejectedValueOnce(error);

    await harness.makeWorker().checkOnce();
    expect(harness.repository.row).toMatchObject({ status: 'pending', last_error_code: code });
    expect(new Date(harness.repository.row.next_attempt_at).getTime()).toBe(
      NOW.getTime() + ('retry_after_ms' in error ? 5_000 : 1_000)
    );

    harness.now = new Date(harness.repository.row.next_attempt_at);
    await harness.makeWorker().checkOnce();
    expect(harness.repository.row.status).toBe('completed');
  });

  it('dead-letters a definitive provider rejection without nonce recovery', async () => {
    const harness = makeHarness();
    harness.sendMessage.mockRejectedValueOnce({ status: 400 });

    await harness.makeWorker().checkOnce();

    expect(harness.recoverMessageByNonce).toHaveBeenCalledOnce();
    expect(harness.repository.row).toMatchObject({
      status: 'dead_letter',
      last_error_code: 'provider_http_400',
    });
  });

  it('honors max attempts before dead-lettering a safe transient', async () => {
    const harness = makeHarness();
    harness.sendMessage.mockRejectedValue({ retryable: true, providerAccepted: false });
    const workerOptions = { maxAttempts: 2 };

    await harness.makeWorker(workerOptions).checkOnce();
    expect(harness.repository.row.status).toBe('pending');
    harness.now = new Date(harness.repository.row.next_attempt_at);
    await harness.makeWorker(workerOptions).checkOnce();

    expect(harness.repository.row).toMatchObject({
      status: 'dead_letter',
      attempt_count: 2,
      last_error_code: 'provider_transient',
    });
  });

  it('completes without changing inbound state, cursor, session/task, or Message data', async () => {
    const harness = makeHarness({ mappingMetadata: { unrelated: 'value' } });
    const beforeMessage = structuredClone(harness.message);
    const beforeMetadata = structuredClone(harness.mapping.metadata);
    const inboundEvent = { event_id: 'event-1', status: 'completed' };
    const session = { session_id: SESSION_ID, status: 'running' };
    const task = { task_id: 'task-1', status: 'running' };

    await harness.makeWorker().checkOnce();

    expect(harness.message).toEqual(beforeMessage);
    expect(harness.mapping.metadata).toEqual(beforeMetadata);
    expect({ inboundEvent, session, task }).toEqual({
      inboundEvent: { event_id: 'event-1', status: 'completed' },
      session: { session_id: SESSION_ID, status: 'running' },
      task: { task_id: 'task-1', status: 'running' },
    });
  });
});
