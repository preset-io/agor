import { encryptApiKey } from '@agor/core/db';
import type { GatewayChannel } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { isVerifiedHttpGatewayCreate } from './gateway-authority';
import { TeamsGatewayWorker } from './teams-gateway-worker';

vi.stubEnv('AGOR_MASTER_SECRET', 'teams-worker-test-secret');

const now = new Date('2026-08-27T12:00:00.000Z');

function channel(): GatewayChannel {
  return {
    id: 'channel-1' as never,
    channel_key: 'channel-key',
    name: 'Teams experimental',
    channel_type: 'teams',
    enabled: true,
    created_by: 'user-1' as never,
    target_branch_id: 'branch-1' as never,
    agor_user_id: 'user-1' as never,
    config: {
      app_id: 'teams-app',
      app_password: 'secret',
      microsoft_tenant_id: 'tenant-1',
      require_mention: true,
      allow_thread_replies_without_mention: true,
      catch_up: {
        mode: 'best_effort',
        max_messages: 50,
        max_prompt_bytes: 16 * 1024,
        request_timeout_ms: 100,
      },
      outbound_enabled: true,
    },
    provider_installation_id: 'teams-app',
    provider_config_generation: 3,
  } as GatewayChannel;
}

function activity(overrides: Record<string, unknown> = {}) {
  return {
    activityId: 'activity-current',
    providerEventId: 'teams:activity:activity-current',
    threadId: '19:channel|root-1',
    conversationId: '19:channel',
    rootMessageId: 'root-1',
    conversationType: 'channel',
    serviceUrl: 'https://smba.trafficmanager.net/teams/',
    text: 'Please review this',
    activityType: 'message',
    userId: '29:human',
    userName: 'Ada',
    userAadObjectId: 'aad-1',
    tenantId: 'tenant-1',
    hasMention: true,
    timestamp: now.toISOString(),
    address: { serviceUrl: 'https://smba.trafficmanager.net/teams/' },
    metadata: {
      teams_conversation_type: 'channel',
      teams_channel_type: 'standard',
      teams_team_id: 'team-1',
      teams_channel_id: 'channel-graph-1',
      teams_service_url: 'https://smba.trafficmanager.net/teams/',
      teams_conversation_id: '19:channel',
      teams_tenant_id: 'tenant-1',
      teams_user_aad_id: 'aad-1',
      teams_has_mention: true,
    },
    ...overrides,
  };
}

function inboundEvent(): Record<string, unknown> {
  return {
    id: 'event-1',
    gateway_channel_id: 'channel-1',
    provider_event_id: 'teams:activity:activity-current',
    thread_id: '19:channel|root-1',
    status: 'processing',
    processing_token: 'claim-1',
    processing_expires_at: now.toISOString(),
    payload_encrypted: 'encrypted',
    payload_expires_at: new Date(now.getTime() + 60_000).toISOString(),
    provider_config_generation: 3,
    verified_app_id: 'teams-app',
    verified_tenant_id: 'tenant-1',
    attempt_count: 1,
    next_attempt_at: now.toISOString(),
    last_error_code: null,
    session_id: null,
    task_id: null,
    received_at: now.toISOString(),
    completed_at: null,
  };
}

function makeWorker(options: {
  activity: Record<string, unknown>;
  mapping?: Record<string, unknown> | null;
  channelConfig?: Record<string, unknown>;
  catchUp?: (input: Record<string, unknown>) => Promise<unknown>;
  gatewayCreate?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}) {
  const event = inboundEvent();
  const complete = vi.fn(async () => true);
  const advance = vi.fn(async () => true);
  const recordDeliveryMetadata = vi.fn(async () => true);
  const create = vi.fn(
    options.gatewayCreate ??
      (async () => ({ success: true, taskId: 'task-1', sessionId: 'session-1' }))
  );
  const inbound = {
    findDueTeamsRefs: vi.fn(),
    claimQueued: vi.fn(async () => event),
    decryptQueuedPayload: vi.fn(() => options.activity),
    recordDeliveryMetadata,
    complete,
    failQueued: vi.fn(),
  };
  const mapping = {
    findById: vi.fn(),
    findByChannelAndThread: vi.fn(async () => options.mapping ?? null),
    advanceTeamsLastAdmittedActivityId: advance,
  };
  const findChannelById = vi.fn(async () => ({
    ...channel(),
    config: { ...channel().config, ...options.channelConfig },
  }));
  const worker = new TeamsGatewayWorker({} as never, {
    discoverInbound: async () => [
      { tenant_id: 'tenant-1', gateway_channel_id: 'channel-1', event_id: 'event-1' },
    ],
    discoverDelivery: async () => [],
    gatewayService: { create },
    catchUp: options.catchUp as never,
    now: () => now,
    repositories: {
      inbound: inbound as never,
      delivery: {
        findDueRefs: vi.fn(),
        claim: vi.fn(),
        markEffectStarted: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
        markAmbiguous: vi.fn(),
      } as never,
      channel: {
        findById: findChannelById,
      },
      mapping: mapping as never,
      address: { findByChannelAndThread: vi.fn() } as never,
      message: { findById: vi.fn() } as never,
    },
  });
  return {
    worker,
    create,
    complete,
    advance,
    inbound,
    mapping,
    channel: findChannelById,
    recordDeliveryMetadata,
  };
}

describe('TeamsGatewayWorker inbound admission', () => {
  it('never creates a Task for an unmentioned standard-channel message', async () => {
    const catchUp = vi.fn(async () => ({ activities: [], complete: true }));
    const setup = makeWorker({
      activity: activity({
        hasMention: false,
        text: 'ordinary channel chatter',
        metadata: {
          teams_conversation_type: 'channel',
          teams_channel_type: 'standard',
          teams_has_mention: false,
          requires_mapping_verification: true,
        },
      }),
      catchUp,
    });

    expect(await setup.worker.checkOnce()).toBe(1);
    expect(setup.create).not.toHaveBeenCalled();
    expect(setup.complete).toHaveBeenCalledOnce();
    expect(setup.advance).not.toHaveBeenCalled();
    expect(catchUp).not.toHaveBeenCalled();
  });

  it('never creates a Task for an unmentioned group-chat message even when legacy config is false', async () => {
    const setup = makeWorker({
      activity: activity({
        conversationType: 'groupChat',
        hasMention: false,
        text: 'ordinary group chatter',
        metadata: {
          teams_conversation_type: 'groupChat',
          teams_has_mention: false,
        },
      }),
      channelConfig: { require_mention: false },
    });

    await setup.worker.checkOnce();

    expect(setup.create).not.toHaveBeenCalled();
    expect(setup.complete).toHaveBeenCalledOnce();
  });

  it('puts only correlated bounded human catch-up before the one current Task', async () => {
    const catchUp = vi.fn(async () => ({
      activities: [
        {
          activityId: 'prior-human',
          timestamp: '2026-08-27T11:59:00.000Z',
          actorLabel: 'Ada',
          text: 'The failing test is in auth.ts',
          isBot: false,
          isMention: false,
        },
        {
          activityId: 'activity-current',
          timestamp: now.toISOString(),
          actorLabel: 'Ada',
          text: 'Please review this',
          isBot: false,
          isMention: true,
        },
      ],
      complete: true,
      conversationId: '19:channel',
      rootMessageId: 'root-1',
      afterActivityId: 'prior-cursor',
      throughActivityId: 'activity-current',
      triggerActivityId: 'activity-current',
    }));
    const setup = makeWorker({
      activity: activity(),
      mapping: {
        id: 'mapping-1',
        thread_id: '19:channel|root-1',
        teams_last_admitted_activity_id: 'prior-cursor',
      },
      catchUp,
    });
    const order: string[] = [];
    setup.advance.mockImplementation(async () => {
      order.push('advance');
      return true;
    });
    setup.complete.mockImplementation(async () => {
      order.push('complete');
      return true;
    });

    await setup.worker.checkOnce();
    expect(catchUp).toHaveBeenCalledOnce();
    expect(setup.create.mock.calls[0]?.[0].text).toContain('The failing test is in auth.ts');
    expect(setup.create.mock.calls[0]?.[0].text).toContain('**Current mention**');
    expect(setup.create.mock.calls[0]?.[0].metadata).toEqual({
      teams_conversation_type: 'channel',
      teams_channel_type: 'standard',
      teams_has_mention: true,
    });
    expect(setup.create).toHaveBeenCalledOnce();
    expect(setup.advance).toHaveBeenCalledWith('mapping-1', 'activity-current', 'prior-cursor');
    expect(isVerifiedHttpGatewayCreate(setup.create.mock.calls[0]?.[0])).toBe(true);
    expect(order).toEqual(['advance', 'complete']);
    expect(setup.recordDeliveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { teams_catch_up: { outcome: 'used' } } })
    );
  });

  it('falls back to the current mention when history is incomplete', async () => {
    const setup = makeWorker({
      activity: activity(),
      catchUp: async () => ({
        activities: [],
        complete: false,
        conversationId: '19:channel',
        rootMessageId: 'root-1',
        afterActivityId: null,
        throughActivityId: 'wrong-trigger',
        triggerActivityId: 'wrong-trigger',
      }),
    });

    await setup.worker.checkOnce();
    expect(setup.create.mock.calls[0]?.[0].text).toBe('Please review this');
    expect(setup.create).toHaveBeenCalledOnce();
  });

  it('runs channel catch-up without trusting a channel-type metadata label', async () => {
    const catchUp = vi.fn(async () => ({
      activities: [
        {
          activityId: 'prior-human',
          timestamp: '2026-08-27T11:59:00.000Z',
          actorLabel: 'Ada',
          text: 'Earlier context',
          isBot: false,
          isMention: false,
        },
        {
          activityId: 'activity-current',
          timestamp: now.toISOString(),
          actorLabel: 'Ada',
          text: 'Please review this',
          isBot: false,
          isMention: true,
        },
      ],
      complete: true,
      conversationId: '19:channel',
      rootMessageId: 'root-1',
      afterActivityId: null,
      throughActivityId: 'activity-current',
      triggerActivityId: 'activity-current',
    }));
    const setup = makeWorker({
      activity: activity({
        metadata: {
          teams_conversation_type: 'channel',
          teams_team_id: 'team-1',
          teams_channel_id: 'channel-graph-1',
          teams_has_mention: true,
        },
      }),
      catchUp,
    });

    await setup.worker.checkOnce();
    expect(catchUp).toHaveBeenCalledOnce();
    expect(setup.create.mock.calls[0]?.[0].text).toContain('Earlier context');
  });

  it('does not advance or complete when Task admission fails', async () => {
    const setup = makeWorker({
      activity: activity(),
      catchUp: async () => ({
        activities: [],
        complete: false,
        conversationId: '19:channel',
        rootMessageId: 'root-1',
        afterActivityId: null,
        throughActivityId: 'wrong-trigger',
        triggerActivityId: 'wrong-trigger',
      }),
      gatewayCreate: async () => {
        throw new Error('Task admission failed');
      },
    });

    await setup.worker.checkOnce();
    expect(setup.advance).not.toHaveBeenCalled();
    expect(setup.complete).not.toHaveBeenCalled();
    expect(setup.inbound.failQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        errorCode: 'teams_gateway_service_unavailable',
        retryDelayMs: 1_000,
      })
    );
  });

  it.each([
    ['channel lookup', (setup: ReturnType<typeof makeWorker>) => setup.channel],
    [
      'pre-admission mapping lookup',
      (setup: ReturnType<typeof makeWorker>) => setup.mapping.findByChannelAndThread,
    ],
  ])('retries a transient %s repository failure', async (_name, getMock) => {
    const setup = makeWorker({
      activity: activity(),
      channelConfig: { catch_up: { mode: 'off' } },
    });
    getMock(setup).mockRejectedValueOnce(new Error('repository unavailable'));

    await setup.worker.checkOnce();
    expect(setup.inbound.failQueued).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', errorCode: 'teams_worker_failure' })
    );
    expect(setup.create).not.toHaveBeenCalled();

    await setup.worker.checkOnce();
    expect(setup.create).toHaveBeenCalledOnce();
    expect(setup.complete).toHaveBeenCalledOnce();
  });

  it('retries a transient post-admission repository failure with event-derived IDs', async () => {
    const setup = makeWorker({
      activity: activity(),
      mapping: { id: 'mapping-1' },
      channelConfig: { catch_up: { mode: 'off' } },
    });
    setup.advance.mockRejectedValueOnce(new Error('cursor unavailable'));

    await setup.worker.checkOnce();
    expect(setup.inbound.failQueued).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', errorCode: 'teams_worker_failure' })
    );
    await setup.worker.checkOnce();

    expect(setup.create).toHaveBeenCalledTimes(2);
    expect(setup.create.mock.calls[0]?.[0].idempotency_task_id).toBe(
      setup.create.mock.calls[1]?.[0].idempotency_task_id
    );
    expect(setup.create.mock.calls[0]?.[0].idempotency_session_id).toBe(
      setup.create.mock.calls[1]?.[0].idempotency_session_id
    );
    expect(setup.complete).toHaveBeenCalledOnce();
  });

  it('retries a transient post-admission mapping lookup failure with event-derived IDs', async () => {
    const setup = makeWorker({
      activity: activity(),
      mapping: { id: 'mapping-1' },
      channelConfig: { catch_up: { mode: 'off' } },
    });
    setup.mapping.findByChannelAndThread
      .mockResolvedValueOnce({ id: 'mapping-1' })
      .mockRejectedValueOnce(new Error('mapping unavailable'));

    await setup.worker.checkOnce();
    expect(setup.inbound.failQueued).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', errorCode: 'teams_worker_failure' })
    );
    await setup.worker.checkOnce();

    expect(setup.create).toHaveBeenCalledTimes(2);
    expect(setup.create.mock.calls[0]?.[0].idempotency_task_id).toBe(
      setup.create.mock.calls[1]?.[0].idempotency_task_id
    );
    expect(setup.complete).toHaveBeenCalledOnce();
  });

  it.each([
    ['non-message', { activityType: 'event', text: '' }],
    ['unmentioned group message', { conversationType: 'groupChat', hasMention: false }],
    ['admitted message', {}],
  ] as const)('retries a transient %s completion failure', async (_name, overrides) => {
    const setup = makeWorker({
      activity: activity(overrides),
      channelConfig: { catch_up: { mode: 'off' } },
    });
    setup.complete.mockRejectedValueOnce(new Error('completion unavailable'));

    await setup.worker.checkOnce();
    expect(setup.inbound.failQueued).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', errorCode: 'teams_worker_failure' })
    );
    await setup.worker.checkOnce();

    expect(setup.complete).toHaveBeenCalledTimes(2);
    if (overrides.activityType === undefined && overrides.conversationType === undefined) {
      expect(setup.create).toHaveBeenCalledTimes(2);
      expect(setup.create.mock.calls[0]?.[0].idempotency_task_id).toBe(
        setup.create.mock.calls[1]?.[0].idempotency_task_id
      );
      expect(setup.create.mock.calls[0]?.[0].idempotency_session_id).toBe(
        setup.create.mock.calls[1]?.[0].idempotency_session_id
      );
    } else {
      expect(setup.create).not.toHaveBeenCalled();
    }
  });

  it('terminalizes a known payload fence without retrying', async () => {
    const setup = makeWorker({
      activity: activity({ providerEventId: 'teams:activity:other' }),
    });

    await setup.worker.checkOnce();

    expect(setup.inbound.failQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'dead_letter',
        errorCode: 'teams_payload_identity_mismatch',
      })
    );
  });
});

describe('TeamsGatewayWorker outbound fencing', () => {
  function deliverySetup(
    addressOverrides: Record<string, unknown> = {},
    options: {
      attemptCount?: number;
      connectorFactory?: () => unknown;
      providerTimeoutMs?: number;
      messageContent?: unknown;
    } = {}
  ) {
    const delivery = {
      delivery_id: 'delivery-1',
      message_id: 'message-1',
      gateway_channel_id: 'channel-1',
      thread_session_map_id: 'mapping-1',
      provider_installation_id: 'teams-app',
      provider_config_generation: 3,
      attempt_count: options.attemptCount ?? 1,
    };
    const claim = {
      delivery_id: 'delivery-1',
      claim_token: 'delivery-claim',
      claim_generation: 1,
      lease_expires_at: new Date(now.getTime() + 30_000).toISOString(),
      lease_remaining_ms: 30_000,
      delivery,
    };
    const fail = vi.fn(async () => true);
    const markEffectStarted = vi.fn(async () => true);
    const complete = vi.fn(async () => true);
    const markAmbiguous = vi.fn(async () => true);
    const sendMessage = vi.fn(async () => 'teams-message-1');
    const address = {
      address_id: 'address-1',
      gateway_channel_id: 'channel-1',
      thread_id: '19:channel|root-1',
      conversation_id: '19:channel',
      root_message_id: 'root-1',
      encrypted_address: encryptApiKey(JSON.stringify({ serviceUrl: 'https://teams.example' })),
      verified_app_id: 'teams-app',
      verified_tenant_id: 'tenant-1',
      provider_config_generation: 3,
      refreshed_at: now.toISOString(),
      expires_at: null,
      ...addressOverrides,
    };
    const worker = new TeamsGatewayWorker({} as never, {
      discoverInbound: async () => [],
      discoverDelivery: async () => [
        { tenant_id: 'tenant-1', delivery_id: 'delivery-1', thread_session_map_id: 'mapping-1' },
      ],
      now: () => now,
      providerTimeoutMs: options.providerTimeoutMs,
      repositories: {
        inbound: {} as never,
        delivery: {
          findDueRefs: vi.fn(),
          claim: vi.fn(async () => claim),
          markEffectStarted,
          complete,
          fail,
          markAmbiguous,
        } as never,
        channel: { findById: vi.fn(async () => channel()) },
        mapping: {
          findById: vi.fn(async () => ({ id: 'mapping-1', thread_id: '19:channel|root-1' })),
          findByChannelAndThread: vi.fn(),
          advanceTeamsLastAdmittedActivityId: vi.fn(),
        } as never,
        address: {
          findByChannelAndThread: vi.fn(async () => address),
          isExpired: vi.fn(
            async () =>
              address.expires_at !== null &&
              address.expires_at !== undefined &&
              new Date(address.expires_at as string).getTime() <= now.getTime()
          ),
        } as never,
        message: {
          findById: vi.fn(async () => ({ content: options.messageContent ?? 'reply' })),
        } as never,
      },
      connectorFactory:
        (options.connectorFactory as never) ??
        (() => ({ channelType: 'teams', sendMessage }) as never),
    });
    return { worker, fail, markEffectStarted, complete, markAmbiguous, sendMessage };
  }

  it('cancels before decryption or effect when the address generation is stale', async () => {
    const setup = deliverySetup({ provider_config_generation: 2 });
    await setup.worker.checkOnce();
    expect(setup.fail).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'canceled', errorCode: 'conversation_address_stale' })
    );
    expect(setup.markEffectStarted).not.toHaveBeenCalled();
    expect(setup.sendMessage).not.toHaveBeenCalled();
  });

  it('records an ambiguous terminal after effect start throws', async () => {
    const setup = deliverySetup();
    setup.sendMessage.mockRejectedValueOnce(new Error('connection reset'));
    await setup.worker.checkOnce();
    expect(setup.markEffectStarted).toHaveBeenCalledOnce();
    expect(setup.markAmbiguous).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'provider_effect_unknown' })
    );
    expect(setup.complete).not.toHaveBeenCalled();
  });

  it('times out a never-resolving provider call inside the lease and never retries it', async () => {
    const sendMessage = vi.fn(() => new Promise<never>(() => undefined));
    const setup = deliverySetup(
      {},
      {
        providerTimeoutMs: 10,
        connectorFactory: () => ({ channelType: 'teams', sendMessage }) as never,
      }
    );

    await setup.worker.checkOnce();

    expect(setup.markEffectStarted).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(setup.markAmbiguous).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'provider_effect_unknown' })
    );
    expect(setup.complete).not.toHaveBeenCalled();
  });

  it('delivers the complete extracted text from structured assistant content', async () => {
    const setup = deliverySetup(
      {},
      {
        messageContent: [
          { type: 'text', text: 'first block' },
          { type: 'tool_use', id: 'tool-1' },
          { type: 'text', text: 'second block' },
        ],
      }
    );

    await setup.worker.checkOnce();

    expect(setup.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'first block\nsecond block' })
    );
  });

  it('retries when the durable effect marker is rejected before provider send', async () => {
    const setup = deliverySetup();
    setup.markEffectStarted.mockRejectedValueOnce(new Error('marker unavailable'));
    await setup.worker.checkOnce();
    expect(setup.markEffectStarted).toHaveBeenCalledOnce();
    expect(setup.sendMessage).not.toHaveBeenCalled();
    expect(setup.markAmbiguous).not.toHaveBeenCalled();
    expect(setup.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        errorCode: 'pre_effect_failure',
        retryDelayMs: 1_000,
      })
    );
  });

  it('dead-letters an exhausted marker rejection without provider send', async () => {
    const setup = deliverySetup({}, { attemptCount: 8 });
    setup.markEffectStarted.mockRejectedValueOnce(new Error('marker unavailable'));
    await setup.worker.checkOnce();
    expect(setup.markEffectStarted).toHaveBeenCalledOnce();
    expect(setup.sendMessage).not.toHaveBeenCalled();
    expect(setup.markAmbiguous).not.toHaveBeenCalled();
    expect(setup.fail).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dead_letter', errorCode: 'pre_effect_failure' })
    );
  });

  it('retries failures before the effect marker with bounded backoff', async () => {
    const setup = deliverySetup(
      {},
      {
        connectorFactory: () => {
          throw new Error('connector unavailable');
        },
      }
    );
    await setup.worker.checkOnce();
    expect(setup.markEffectStarted).not.toHaveBeenCalled();
    expect(setup.markAmbiguous).not.toHaveBeenCalled();
    expect(setup.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        errorCode: 'pre_effect_failure',
        retryDelayMs: 1_000,
      })
    );
  });

  it('dead-letters an exhausted pre-effect failure', async () => {
    const setup = deliverySetup(
      {},
      {
        attemptCount: 8,
        connectorFactory: () => {
          throw new Error('connector unavailable');
        },
      }
    );
    await setup.worker.checkOnce();
    expect(setup.markEffectStarted).not.toHaveBeenCalled();
    expect(setup.markAmbiguous).not.toHaveBeenCalled();
    expect(setup.fail).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dead_letter', errorCode: 'pre_effect_failure' })
    );
  });
});
