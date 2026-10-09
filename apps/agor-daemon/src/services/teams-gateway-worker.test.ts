import type { GatewayChannel } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { isVerifiedHttpGatewayCreate, verifiedHttpGatewayAuthority } from './gateway-authority';
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
  channelConfig?: Record<string, unknown>;
  gatewayCreate?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  discoverInbound?: () => Promise<
    Array<{ tenant_id: string; gateway_channel_id: string; thread_id: string; event_id: string }>
  >;
}) {
  const event = inboundEvent();
  const complete = vi.fn(async () => true);
  const create = vi.fn(
    options.gatewayCreate ??
      (async () => ({ success: true, taskId: 'task-1', sessionId: 'session-1' }))
  );
  const inbound = {
    findDueTeamsRefs: vi.fn(),
    claimQueued: vi.fn(async () => event),
    decryptQueuedPayload: vi.fn(() => options.activity),
    complete,
    failQueued: vi.fn(),
  };
  const findChannelById = vi.fn(async () => ({
    ...channel(),
    config: { ...channel().config, ...options.channelConfig },
  }));
  const worker = new TeamsGatewayWorker({} as never, {
    discoverInbound:
      options.discoverInbound ??
      (async () => [
        {
          tenant_id: 'tenant-1',
          gateway_channel_id: 'channel-1',
          thread_id: '19:channel|root-1',
          event_id: 'event-1',
        },
      ]),
    gatewayService: { create },
    random: () => 0,
    repositories: {
      inbound: inbound as never,
      channel: {
        findById: findChannelById,
      },
    },
  });
  return { worker, create, complete, inbound, channel: findChannelById };
}

describe('TeamsGatewayWorker inbound admission', () => {
  it('admits the current mention with its original authority and verified catch-up coordinates', async () => {
    const setup = makeWorker({
      activity: activity({
        activityId: '1616990132035',
        metadata: {
          ...activity().metadata,
          teams_team_aad_group_id: 'fbe2bf47-16c8-47cf-b4a5-4b9b187c508b',
        },
      }),
    });
    await setup.worker.checkOnce();

    const request = setup.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(isVerifiedHttpGatewayCreate(request)).toBe(true);
    expect(verifiedHttpGatewayAuthority(request)).toMatchObject({
      id: 'event-1',
      gateway_channel_id: 'channel-1',
      processing_token: 'claim-1',
      provider_config_generation: 3,
      verified_app_id: 'teams-app',
      verified_tenant_id: 'tenant-1',
    });
    expect(request.text).toBe('Please review this');
    expect(request.metadata).toEqual({
      teams_conversation_type: 'channel',
      teams_channel_type: 'standard',
      teams_has_mention: true,
    });
    expect(request.teams_catch_up).toEqual({
      activity_id: '1616990132035',
      timestamp: now.toISOString(),
      service_url: 'https://smba.trafficmanager.net/teams/',
      team_id: 'team-1',
      team_group_id: 'fbe2bf47-16c8-47cf-b4a5-4b9b187c508b',
    });
    expect(setup.complete).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', taskId: 'task-1' })
    );
  });

  it('backs off empty discovery instead of scanning shared events every second', async () => {
    vi.useFakeTimers();
    const scan = vi.fn(async () => []);
    const setup = makeWorker({ activity: activity(), discoverInbound: scan });
    try {
      setup.worker.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scan.mock.calls.length).toBeLessThanOrEqual(6);
      expect(scan.mock.calls.length).toBeGreaterThan(0);
      await setup.worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('claims immediately when local ingress wakes it during the idle back-off', async () => {
    vi.useFakeTimers();
    const scan = vi.fn(async () => []);
    const setup = makeWorker({ activity: activity(), discoverInbound: scan });
    try {
      setup.worker.start();
      // Scans at ~0, 2, 6, 14, 30 s; the next idle scan is not due until ~62 s.
      await vi.advanceTimersByTimeAsync(31_000);
      const idleScans = scan.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scan.mock.calls.length).toBe(idleScans);
      setup.worker.wake();
      await vi.advanceTimersByTimeAsync(100);
      expect(scan.mock.calls.length).toBe(idleScans + 1);
      await setup.worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reruns at once when woken while a scan is already in flight', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const scan = vi
      .fn(async (): Promise<never[]> => [])
      .mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([]))));
    const setup = makeWorker({ activity: activity(), discoverInbound: scan });
    try {
      setup.worker.start();
      await vi.advanceTimersByTimeAsync(600);
      expect(scan).toHaveBeenCalledTimes(1);
      setup.worker.wake();
      release();
      await vi.advanceTimersByTimeAsync(100);
      expect(scan).toHaveBeenCalledTimes(2);
      await setup.worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets another thread on the same channel progress while one admission is slow', async () => {
    let releaseSlow!: () => void;
    const slowClaim = new Promise<null>((resolve) => {
      releaseSlow = () => resolve(null);
    });
    const claimQueued = vi.fn(async (eventId: string) =>
      eventId === 'event-a' ? slowClaim : null
    );
    const worker = new TeamsGatewayWorker({} as never, {
      discoverInbound: async () => [
        {
          tenant_id: 'tenant-1',
          gateway_channel_id: 'channel-1',
          thread_id: 'thread-a',
          event_id: 'event-a',
        },
        {
          tenant_id: 'tenant-1',
          gateway_channel_id: 'channel-1',
          thread_id: 'thread-b',
          event_id: 'event-b',
        },
      ],
      discoverDelivery: async () => [],
      repositories: {
        inbound: { claimQueued } as never,
        delivery: {} as never,
        channel: { findById: vi.fn() },
        address: { findByChannelAndThread: vi.fn() } as never,
        message: { findById: vi.fn() } as never,
      },
    });
    const scan = worker.checkOnce();
    await vi.waitFor(() =>
      expect(claimQueued).toHaveBeenCalledWith('event-b', expect.any(String), 30_000)
    );
    releaseSlow();
    await scan;
  });

  it('drains rows queued before ingress filtering without creating a Task', async () => {
    for (const overrides of [
      { activityType: 'conversationUpdate', text: '' },
      {
        hasMention: false,
        metadata: { teams_conversation_type: 'channel', teams_has_mention: false },
      },
      { conversationType: 'groupChat', hasMention: false },
    ]) {
      const setup = makeWorker({
        activity: activity(overrides),
        channelConfig: { require_mention: false },
      });
      await setup.worker.checkOnce();
      expect(setup.create).not.toHaveBeenCalled();
      expect(setup.complete).toHaveBeenCalledOnce();
    }
  });

  it('does not complete when Task admission fails', async () => {
    const setup = makeWorker({
      activity: activity(),
      gatewayCreate: async () => {
        throw new Error('Task admission failed');
      },
    });

    await setup.worker.checkOnce();
    expect(setup.complete).not.toHaveBeenCalled();
    expect(setup.inbound.failQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        errorCode: 'teams_gateway_service_unavailable',
        retryDelayMs: 1_000,
      })
    );
  });

  it('retries a transient channel lookup failure', async () => {
    const setup = makeWorker({ activity: activity() });
    setup.channel.mockRejectedValueOnce(new Error('repository unavailable'));

    await setup.worker.checkOnce();
    expect(setup.inbound.failQueued).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', errorCode: 'teams_worker_failure' })
    );
    expect(setup.create).not.toHaveBeenCalled();

    await setup.worker.checkOnce();
    expect(setup.create).toHaveBeenCalledOnce();
    expect(setup.complete).toHaveBeenCalledOnce();
  });

  it.each([
    ['non-message', { activityType: 'event', text: '' }],
    ['unmentioned group message', { conversationType: 'groupChat', hasMention: false }],
    ['admitted message', {}],
  ] as const)('retries a transient %s completion failure', async (_name, overrides) => {
    const setup = makeWorker({ activity: activity(overrides) });
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
