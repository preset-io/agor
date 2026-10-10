import {
  type FencedTeamsAddress,
  type TeamsMessageDeliveryClaim,
  TeamsMessageDeliveryClaimLostError,
} from '@agor/core/db';
import { type PreparedTeamsSend, TeamsSendError } from '@agor/core/gateway';
import type {
  GatewayChannel,
  Message,
  TeamsMessageDelivery,
  TeamsMessageDeliveryChunkReceipt,
  TeamsMessageDeliveryID,
  ThreadSessionMap,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { TeamsSendConnector } from '../utils/teams-connector-cache.js';
import { planTeamsChunks, TeamsMessageDeliveryWorker } from './teams-message-delivery-worker.js';

const DELIVERY_ID = '018f5f63-0fd1-7c2e-9e7d-8fb27d4a7e1a' as TeamsMessageDeliveryID;
const NOW = new Date('2026-10-07T12:00:00.000Z');
// 70k code points but 87.5k UTF-16 units, the unit Teams counts.
const SEVENTY_K_ASTRAL_TEXT = '😀😀 abcd '.repeat(8_750);

type ClaimRef = { deliveryId: string; claimToken: string; claimGeneration: number };

/** In-memory delivery row with the repository's claim, marker, and receipt rules. */
class FakeDeliveryRepository {
  row: TeamsMessageDelivery;
  calls: string[] = [];

  constructor(overrides: Partial<TeamsMessageDelivery> = {}) {
    this.row = {
      delivery_id: DELIVERY_ID,
      message_id: 'message-1' as never,
      gateway_channel_id: 'channel-1' as never,
      thread_session_map_id: 'mapping-1' as never,
      provider_installation_id: 'teams-app',
      provider_config_generation: 3,
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: NOW.toISOString(),
      claim_token: null,
      claim_expires_at: null,
      claim_generation: 0,
      ambiguous_chunk_index: null,
      effect_started_at: null,
      chunk_receipts: [],
      chunk_plan_digest: null,
      last_error_code: null,
      provider_message_id: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      completed_at: null,
      canceled_at: null,
      dead_lettered_at: null,
      ...overrides,
    };
  }

  private copy(): TeamsMessageDelivery {
    return { ...this.row, chunk_receipts: this.row.chunk_receipts.map((r) => ({ ...r })) };
  }

  private current(ref: ClaimRef): void {
    if (
      this.row.status !== 'processing' ||
      this.row.claim_token !== ref.claimToken ||
      this.row.claim_generation !== ref.claimGeneration
    ) {
      throw new TeamsMessageDeliveryClaimLostError(ref.deliveryId);
    }
  }

  private asClaim(token: string): TeamsMessageDeliveryClaim {
    return {
      delivery_id: DELIVERY_ID,
      claim_token: token,
      claim_generation: this.row.claim_generation,
      lease_expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
      delivery: this.copy(),
    };
  }

  async findDueRefs() {
    return [];
  }

  async claim(_id: string, token: string) {
    if (this.row.status !== 'pending') return null;
    this.row = {
      ...this.row,
      status: 'processing',
      claim_token: token,
      claim_generation: this.row.claim_generation + 1,
      attempt_count: this.row.attempt_count + 1,
    };
    return this.asClaim(token);
  }

  async renewClaim(ref: ClaimRef) {
    try {
      this.current(ref);
    } catch {
      return null;
    }
    return this.asClaim(ref.claimToken);
  }

  async recordChunkPlan(ref: ClaimRef & { digest: string }) {
    this.current(ref);
    this.calls.push(`plan:${ref.digest.split(':')[0]}`);
    this.row.chunk_plan_digest = ref.digest;
    return this.copy();
  }

  async markEffectStarted(ref: ClaimRef & { chunkIndex?: number }) {
    this.current(ref);
    const chunkIndex = ref.chunkIndex ?? 0;
    this.calls.push(`mark:${chunkIndex}`);
    this.row.ambiguous_chunk_index = chunkIndex;
    this.row.effect_started_at = NOW.toISOString();
    return this.copy();
  }

  async clearChunkEffectMarker(ref: ClaimRef & { chunkIndex: number }) {
    this.current(ref);
    this.calls.push(`clear:${ref.chunkIndex}`);
    if (this.row.ambiguous_chunk_index === ref.chunkIndex) {
      this.row.ambiguous_chunk_index = null;
      this.row.effect_started_at = null;
    }
    return this.copy();
  }

  async checkpointChunk(ref: ClaimRef & { receipt: TeamsMessageDeliveryChunkReceipt }) {
    this.current(ref);
    this.calls.push(`receipt:${ref.receipt.chunk_index}`);
    this.row.chunk_receipts = [...this.row.chunk_receipts, ref.receipt];
    this.row.ambiguous_chunk_index = null;
    this.row.effect_started_at = null;
    return this.copy();
  }

  async complete(ref: ClaimRef) {
    this.current(ref);
    this.row = { ...this.row, status: 'completed', claim_token: null };
    return this.copy();
  }

  async fail(
    ref: ClaimRef & {
      status: 'pending' | 'canceled' | 'dead_letter';
      errorCode: string;
      retryDelayMs?: number;
    }
  ) {
    this.current(ref);
    this.row = {
      ...this.row,
      status: ref.status,
      claim_token: null,
      last_error_code: ref.errorCode,
      next_attempt_at: new Date(NOW.getTime() + (ref.retryDelayMs ?? 0)).toISOString(),
    };
    return this.copy();
  }

  async markAmbiguous(ref: ClaimRef & { errorCode?: string; chunkIndex?: number }) {
    this.current(ref);
    this.row = {
      ...this.row,
      status: 'ambiguous',
      claim_token: null,
      ambiguous_chunk_index: ref.chunkIndex ?? this.row.ambiguous_chunk_index,
      last_error_code: ref.errorCode ?? 'provider_effect_unknown',
    };
    return this.copy();
  }

  async purgeExpired() {
    return 0;
  }
}

function channel(config: Record<string, unknown> = {}): GatewayChannel {
  return {
    id: 'channel-1',
    channel_key: 'channel-key',
    name: 'Teams',
    channel_type: 'teams',
    enabled: true,
    config: {
      app_id: 'teams-app',
      app_password: 'secret',
      microsoft_tenant_id: 'tenant-1',
      outbound_enabled: true,
      ...config,
    },
    provider_installation_id: 'teams-app',
    provider_config_generation: 3,
  } as unknown as GatewayChannel;
}

function harness(
  options: {
    text?: string;
    delivery?: Partial<TeamsMessageDelivery>;
    fenced?: FencedTeamsAddress;
    send?: (text: string, signal?: AbortSignal) => Promise<string>;
    prepare?: () => Promise<PreparedTeamsSend>;
    maxChunks?: number;
    providerCallTimeoutMs?: number;
    onReplyPosted?: (sessionId: string) => void;
    channelConfig?: Record<string, unknown>;
    mappingMetadata?: Record<string, unknown>;
  } = {}
) {
  const repository = new FakeDeliveryRepository(options.delivery);
  const sent: string[] = [];
  const send = vi.fn(
    options.send ??
      (async (text: string) => {
        sent.push(text);
        return `activity-${sent.length}`;
      })
  );
  const prepareSend = vi.fn(
    options.prepare ??
      (async () => {
        repository.calls.push('prepare');
        return { send, sendTyping: vi.fn(async () => undefined) } satisfies PreparedTeamsSend;
      })
  );
  const invalidateTokens = vi.fn();
  const connector: TeamsSendConnector = {
    prepareSend,
    invalidateTokens,
    formatMessage: (text: string) => text,
  };
  const revokeThread = vi.fn(async () => 1);
  const loadFenced = vi.fn(
    async () =>
      options.fenced ?? {
        ok: true as const,
        row: {} as never,
        address: { serviceUrl: 'https://smba.trafficmanager.net/teams/' },
      }
  );
  const message = {
    message_id: 'message-1',
    session_id: 'session-1',
    role: 'assistant',
    content: options.text ?? 'A durable reply',
  } as unknown as Message;
  const mapping = {
    id: 'mapping-1',
    channel_id: 'channel-1',
    session_id: 'session-1',
    thread_id: '19:channel|root-1',
    metadata: options.mappingMetadata ?? {},
  } as unknown as ThreadSessionMap;
  const worker = new TeamsMessageDeliveryWorker({} as never, {
    tenantId: 'tenant-1',
    discover: async () => [
      {
        tenant_id: 'tenant-1',
        delivery_id: DELIVERY_ID,
        thread_session_map_id: 'mapping-1' as never,
      },
    ],
    chunkPacingMs: 0,
    maxChunks: options.maxChunks,
    providerCallTimeoutMs: options.providerCallTimeoutMs,
    sessionUrl: async () => 'https://agor.example.test/s/session-1',
    onReplyPosted: options.onReplyPosted,
    repositories: {
      delivery: repository as never,
      channel: { findById: vi.fn(async () => channel(options.channelConfig)) },
      mapping: { findById: vi.fn(async () => mapping) },
      message: { findById: vi.fn(async () => message) },
      address: { loadFenced, revokeThread },
    },
    connectorFactory: () => connector,
  });
  return {
    worker,
    repository,
    sent,
    send,
    prepareSend,
    invalidateTokens,
    loadFenced,
    revokeThread,
  };
}

function sendError(status?: number, extra: Record<string, unknown> = {}) {
  return new TeamsSendError({ phase: 'send', status, ...extra });
}

describe('TeamsMessageDeliveryWorker chunking', () => {
  it('sends a 70k-character reply as three chunks counted in UTF-16 units', async () => {
    const text = SEVENTY_K_ASTRAL_TEXT;
    expect(Array.from(text).length).toBeGreaterThanOrEqual(70_000);
    const setup = harness({ text });

    await setup.worker.checkOnce();

    expect(setup.sent).toHaveLength(3);
    expect(setup.sent.every((chunk) => chunk.length <= 40_000)).toBe(true);
    expect(setup.sent.join('')).toBe(text);
    expect(setup.repository.calls).toEqual([
      'plan:40000',
      'prepare',
      'mark:0',
      'receipt:0',
      'mark:1',
      'receipt:1',
      'mark:2',
      'receipt:2',
    ]);
    expect(setup.repository.row.status).toBe('completed');
  });

  it('delivers replies in a seeded thread and with proactive sends off', async () => {
    const setup = harness({
      channelConfig: { outbound_enabled: false },
      mappingMetadata: { outbound_seed_id: 'seed-1' },
    });
    await setup.worker.checkOnce();
    expect(setup.sent).toEqual(['A durable reply']);
    expect(setup.repository.row.status).toBe('completed');
  });

  it('reports the reply as posted once, after its first chunk, so typing can stop', async () => {
    const events: string[] = [];
    const setup = harness({
      text: SEVENTY_K_ASTRAL_TEXT,
      send: async () => {
        events.push('send');
        return 'activity';
      },
      onReplyPosted: (sessionId) => events.push(`posted:${sessionId}`),
    });
    await setup.worker.checkOnce();
    expect(events).toEqual(['send', 'posted:session-1', 'send', 'send']);
  });

  it('resumes at chunk 2 after a crash that checkpointed chunks 0 and 1', async () => {
    const text = SEVENTY_K_ASTRAL_TEXT;
    const plan = planTeamsChunks(text, 40_000);
    const setup = harness({
      text,
      delivery: {
        chunk_plan_digest: plan.digest,
        chunk_receipts: [
          { chunk_index: 0, provider_message_id: 'activity-0' },
          { chunk_index: 1, provider_message_id: 'activity-1' },
        ],
      },
    });

    await setup.worker.checkOnce();

    expect(setup.sent).toEqual([plan.chunks[2]]);
    expect(setup.repository.calls).toEqual(['prepare', 'mark:2', 'receipt:2']);
    expect(setup.repository.row.status).toBe('completed');
  });

  it('ends as ambiguous when a resumed claim finds an unreceipted chunk marker', async () => {
    const setup = harness({ delivery: { ambiguous_chunk_index: 0 } });
    await setup.worker.checkOnce();
    expect(setup.send).not.toHaveBeenCalled();
    expect(setup.repository.row).toMatchObject({ status: 'ambiguous', ambiguous_chunk_index: 0 });
  });

  it('re-plans at half the budget after a 413 on the first chunk', async () => {
    const setup = harness({ text: 'x '.repeat(30_000) });
    setup.send.mockRejectedValueOnce(sendError(413));

    await setup.worker.checkOnce();
    expect(setup.repository.row).toMatchObject({
      status: 'pending',
      last_error_code: 'chunk_replanned',
      ambiguous_chunk_index: null,
    });
    expect(setup.repository.row.chunk_plan_digest?.startsWith('20000:')).toBe(true);

    await setup.worker.checkOnce();
    expect(setup.sent.length).toBe(3);
    expect(setup.sent.every((chunk) => chunk.length <= 20_000)).toBe(true);
    expect(setup.repository.row.status).toBe('completed');
  });

  it('caps the chunk count and links the rest to Agor', async () => {
    const setup = harness({ text: 'y '.repeat(150_000), maxChunks: 3 });
    await setup.worker.checkOnce();
    expect(setup.sent).toHaveLength(3);
    expect(setup.sent[2]).toContain('Continued in Agor: https://agor.example.test/s/session-1');
  });
});

describe('TeamsMessageDeliveryWorker send outcomes', () => {
  it('leaves a token failure pending without a marker and prepares before marking', async () => {
    const setup = harness({
      prepare: async () => {
        throw new TeamsSendError({ phase: 'prepare', reason: 'token_unavailable' });
      },
    });
    await setup.worker.checkOnce();
    expect(setup.repository.calls).toEqual(['plan:40000']);
    expect(setup.repository.row).toMatchObject({
      status: 'pending',
      last_error_code: 'token_unavailable',
      ambiguous_chunk_index: null,
    });

    const ok = harness();
    await ok.worker.checkOnce();
    expect(ok.repository.calls.indexOf('prepare')).toBeLessThan(
      ok.repository.calls.indexOf('mark:0')
    );
  });

  it.each([
    [
      '429 with Retry-After',
      sendError(429, { retryAfterMs: 7_000 }),
      'provider_rate_limited',
      7_000,
    ],
    ['412', sendError(412), 'provider_http_412', 1_000],
    [
      'connection refused',
      sendError(undefined, { networkCode: 'ECONNREFUSED' }),
      'provider_unreachable',
      1_000,
    ],
  ])('clears the marker and retries on %s', async (_label, error, code, delayMs) => {
    const setup = harness();
    setup.send.mockRejectedValueOnce(error);
    await setup.worker.checkOnce();
    expect(setup.repository.calls).toContain('clear:0');
    expect(setup.repository.row).toMatchObject({
      status: 'pending',
      last_error_code: code,
      ambiguous_chunk_index: null,
    });
    expect(new Date(setup.repository.row.next_attempt_at).getTime()).toBe(NOW.getTime() + delayMs);
  });

  it('refreshes tokens after a 401', async () => {
    const setup = harness();
    setup.send.mockRejectedValueOnce(sendError(401));
    await setup.worker.checkOnce();
    expect(setup.invalidateTokens).toHaveBeenCalledOnce();
    expect(setup.repository.row).toMatchObject({
      status: 'pending',
      last_error_code: 'provider_http_401',
    });
  });

  it.each([
    ['503', sendError(503), 'provider_http_503'],
    ['504', sendError(504), 'provider_http_504'],
    [
      'connection reset',
      sendError(undefined, { networkCode: 'ECONNRESET' }),
      'provider_effect_unknown',
    ],
  ])('records %s as a terminal ambiguous chunk', async (_label, error, code) => {
    const setup = harness();
    setup.send.mockRejectedValueOnce(error);
    await setup.worker.checkOnce();
    expect(setup.repository.calls).not.toContain('clear:0');
    expect(setup.repository.row).toMatchObject({
      status: 'ambiguous',
      ambiguous_chunk_index: 0,
      last_error_code: code,
    });
  });

  it('times out a never-resolving send inside the lease and never resends it', async () => {
    const setup = harness({
      providerCallTimeoutMs: 10,
      send: () => new Promise<string>(() => undefined),
    });
    await setup.worker.checkOnce();
    expect(setup.send).toHaveBeenCalledOnce();
    expect(setup.repository.row).toMatchObject({ status: 'ambiguous', ambiguous_chunk_index: 0 });
  });

  it.each([
    ['500', sendError(500), 'dead_letter', 'provider_http_500'],
    ['400', sendError(400), 'dead_letter', 'provider_http_400'],
    [
      'bot removed',
      sendError(403, { providerCode: 'BotNotInConversationRoster' }),
      'canceled',
      'conversation_address_revoked',
    ],
    [
      'conversation gone',
      sendError(404, { providerCode: 'ConversationNotFound' }),
      'canceled',
      'conversation_address_revoked',
    ],
    [
      'bot disabled by admin',
      sendError(403, { providerCode: 'BotDisabledByAdmin' }),
      'canceled',
      'conversation_address_suspended',
    ],
  ])('terminalizes %s', async (_label, error, status, code) => {
    const setup = harness();
    setup.send.mockRejectedValueOnce(error);
    await setup.worker.checkOnce();
    expect(setup.repository.row).toMatchObject({ status, last_error_code: code });
  });

  it('revokes the thread address when Teams says the bot left the conversation', async () => {
    const setup = harness();
    setup.send.mockRejectedValueOnce(
      sendError(403, { providerCode: 'BotNotInConversationRoster' })
    );
    await setup.worker.checkOnce();
    expect(setup.revokeThread).toHaveBeenCalledWith(
      'channel-1',
      '19:channel|root-1',
      'bot_removed'
    );
    expect(setup.repository.row).toMatchObject({
      status: 'canceled',
      last_error_code: 'conversation_address_revoked',
    });
  });

  it('cancels a delivery to a revoked address before preparing a send', async () => {
    const setup = harness({ fenced: { ok: false, code: 'conversation_address_revoked' } });
    await setup.worker.checkOnce();
    expect(setup.prepareSend).not.toHaveBeenCalled();
    expect(setup.repository.row).toMatchObject({
      status: 'canceled',
      last_error_code: 'conversation_address_revoked',
    });
  });

  it('cancels before preparing when the address fence fails', async () => {
    const setup = harness({ fenced: { ok: false, code: 'conversation_address_stale' } });
    await setup.worker.checkOnce();
    expect(setup.prepareSend).not.toHaveBeenCalled();
    expect(setup.repository.row).toMatchObject({
      status: 'canceled',
      last_error_code: 'conversation_address_stale',
    });
  });

  it('dead-letters a retryable failure once attempts are exhausted', async () => {
    const setup = harness({ delivery: { attempt_count: 7 } });
    setup.send.mockRejectedValueOnce(sendError(429));
    await setup.worker.checkOnce();
    expect(setup.repository.row).toMatchObject({
      status: 'dead_letter',
      last_error_code: 'provider_rate_limited',
    });
  });

  it('delivers the extracted text from structured assistant content', async () => {
    const setup = harness();
    const message = {
      message_id: 'message-1',
      session_id: 'session-1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'first block' },
        { type: 'tool_use', id: 'tool-1' },
        { type: 'text', text: 'second block' },
      ],
    };
    const worker = new TeamsMessageDeliveryWorker({} as never, {
      tenantId: 'tenant-1',
      discover: async () => [
        {
          tenant_id: 'tenant-1',
          delivery_id: DELIVERY_ID,
          thread_session_map_id: 'mapping-1' as never,
        },
      ],
      chunkPacingMs: 0,
      repositories: {
        delivery: setup.repository as never,
        channel: { findById: vi.fn(async () => channel()) },
        mapping: {
          findById: vi.fn(async () => ({
            id: 'mapping-1',
            channel_id: 'channel-1',
            session_id: 'session-1',
            thread_id: '19:channel|root-1',
            metadata: {},
          })) as never,
        },
        message: { findById: vi.fn(async () => message) as never },
        address: { loadFenced: setup.loadFenced, revokeThread: setup.revokeThread },
      },
      connectorFactory: () => ({
        prepareSend: setup.prepareSend,
        invalidateTokens: setup.invalidateTokens,
        formatMessage: (text: string) => text,
      }),
    });
    await worker.checkOnce();
    expect(setup.sent).toEqual(['first block\nsecond block']);
  });
});
