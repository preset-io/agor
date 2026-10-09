import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { select, update } from '../database-wrapper';
import { gatewayInboundEvents } from '../schema';
import { ownedDbTest } from '../test-helpers';
import {
  GatewayInboundEventRepository,
  type TeamsVerifiedHttpAdmissionInput,
} from './gateway-inbound-events';
import {
  decryptTeamsConversationAddress,
  TeamsConversationAddressRepository,
} from './teams-conversation-addresses';
import {
  assistantMessage,
  seedTeamsGateway,
  sqliteTeamsHarness,
  TEAMS_SHARED_CASES,
  TEAMS_THREAD_ID,
  teamsAdmission,
  teamsDeliveryWriters,
} from './teams-gateway-ha.test-support';
import { ThreadSessionMapRepository } from './thread-session-map';

describe('Teams gateway HA repositories', () => {
  const priorMasterSecret = process.env.AGOR_MASTER_SECRET;
  beforeAll(() => {
    process.env.AGOR_MASTER_SECRET = 'teams-gateway-ha-test-secret';
  });
  afterAll(() => {
    if (priorMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
    else process.env.AGOR_MASTER_SECRET = priorMasterSecret;
  });

  for (const [name, run] of TEAMS_SHARED_CASES) {
    ownedDbTest(name, ({ db }) => run(sqliteTeamsHarness(db)));
  }

  ownedDbTest(
    'advances the Teams catch-up cursor numerically and never backwards',
    async ({ db }) => {
      const { mapping } = await seedTeamsGateway(db);
      const maps = new ThreadSessionMapRepository(db);
      expect(await maps.advanceTeamsLastAdmittedActivityId(mapping.id, '1700000000999')).toBe(true);
      // Lexically larger but numerically older: a stale replica cannot move it back.
      expect(await maps.advanceTeamsLastAdmittedActivityId(mapping.id, '999999999999')).toBe(false);
      expect(await maps.advanceTeamsLastAdmittedActivityId(mapping.id, '1700000000999')).toBe(
        false
      );
      expect(await maps.advanceTeamsLastAdmittedActivityId(mapping.id, '1700000001000')).toBe(true);
      await expect(
        maps.advanceTeamsLastAdmittedActivityId(mapping.id, 'activity-2')
      ).rejects.toThrow(/Invalid Teams message ID/);
      expect((await maps.findById(mapping.id))?.teams_last_admitted_activity_id).toBe(
        '1700000001000'
      );
    }
  );

  ownedDbTest(
    'commits encrypted admission once and refreshes the durable address on retries',
    async ({ db }) => {
      const { channel } = await seedTeamsGateway(db);
      const inbound = new GatewayInboundEventRepository(db);
      const addresses = new TeamsConversationAddressRepository(db);
      const input = teamsAdmission(channel);
      const callerBehind = new Date('2000-01-01T00:00:00.000Z');
      const callerAhead = new Date('2999-01-01T00:00:00.000Z');
      const inputWithObsoleteTimestamps = {
        ...input,
        address: {
          ...input.address,
          refreshedAt: callerBehind,
          expiresAt: callerAhead,
        },
      } as unknown as TeamsVerifiedHttpAdmissionInput;

      const first = await inbound.admitVerifiedHttp(inputWithObsoleteTimestamps);
      const firstRawAddress = await addresses.findByChannelAndThread(channel.id, input.threadId);
      const duplicate = await inbound.admitVerifiedHttp(inputWithObsoleteTimestamps);
      expect(first.outcome).toBe('admitted');
      expect(duplicate.outcome).toBe('duplicate');
      expect(duplicate.event.id).toBe(first.event.id);
      expect(first.event.payload_encrypted).toBeTruthy();
      expect(first.event.payload_encrypted).not.toContain('hello');
      expect(first.event.delivery_metadata).toEqual({
        teams_channel_name: 'safe-display-name',
      });
      expect(inbound.decryptQueuedPayload(first.event)).toMatchObject({ text: 'hello' });
      const address = await addresses.findByChannelAndThread(channel.id, input.threadId);
      expect(address && decryptTeamsConversationAddress(address)).toEqual(input.address.address);

      await expect(
        inbound.admitVerifiedHttp(
          teamsAdmission(channel, input.providerEventId, 'different-thread')
        )
      ).rejects.toThrow('different thread');
      expect(await addresses.findByChannelAndThread(channel.id, 'different-thread')).toBeNull();

      const rawAddress = await addresses.findByChannelAndThread(channel.id, input.threadId);
      expect(rawAddress).toBeTruthy();
      for (const storedAddress of [firstRawAddress, rawAddress]) {
        expect(storedAddress?.refreshed_at).not.toBe(callerBehind.toISOString());
        expect(storedAddress).not.toHaveProperty('expires_at');
        expect(storedAddress?.revoked_at).toBeNull();
      }
      expect(rawAddress?.encrypted_address).not.toContain('trafficmanager');
      expect(rawAddress && decryptTeamsConversationAddress(rawAddress)).toEqual(
        input.address.address
      );

      const due = await inbound.findDueTeamsRefs(db, { now: new Date() });
      expect(due).toEqual([
        {
          tenant_id: 'default',
          gateway_channel_id: channel.id,
          thread_id: TEAMS_THREAD_ID,
          event_id: first.event.id,
        },
      ]);

      const claim = await inbound.claimQueued(first.event.id, 'cleanup-token', 30_000);
      expect(claim).toBeTruthy();
      expect(
        await inbound.complete({
          eventId: first.event.id,
          channelId: channel.id,
          processingToken: 'cleanup-token',
          requireListenerClaim: false,
        })
      ).toBe(true);
      const stored = await select(db)
        .from(gatewayInboundEvents)
        .where(eq(gatewayInboundEvents.id, first.event.id))
        .one();
      expect(stored?.payload_encrypted).toBeNull();
      expect(stored?.payload_expires_at).toBeNull();
      expect(await inbound.findDueTeamsRefs(db, { now: new Date() })).toEqual([]);
    }
  );

  ownedDbTest(
    'reclaims an expired pre-effect claim but fences an ambiguous provider effect',
    async ({ db }) => {
      const { channel, mapping } = await seedTeamsGateway(db);
      const inbound = new GatewayInboundEventRepository(db);
      const admitted = await inbound.admitVerifiedHttp(teamsAdmission(channel));
      const now = new Date(admitted.event.received_at);
      const claim = await inbound.claimQueued(admitted.event.id, 'inbound-a', 100, now);
      expect(claim?.processing_token).toBe('inbound-a');
      const reclaimed = await inbound.claimQueued(
        admitted.event.id,
        'inbound-b',
        100,
        new Date(now.getTime() + 101)
      );
      expect(reclaimed?.processing_token).toBe('inbound-b');

      const { deliveries, messages } = teamsDeliveryWriters(db);
      const message = await messages.create(assistantMessage(mapping.session_id, 0));
      const delivery = await deliveries.findByMessageId(message.message_id);
      if (!delivery) throw new Error('missing Teams delivery');
      const deliveryNow = new Date(delivery.next_attempt_at);
      const deliveryClaim = await deliveries.claim(
        delivery.delivery_id,
        'delivery-a',
        100,
        deliveryNow
      );
      if (!deliveryClaim) throw new Error('missing delivery claim');
      await deliveries.markEffectStarted({
        deliveryId: delivery.delivery_id,
        claimToken: deliveryClaim.claim_token,
        claimGeneration: deliveryClaim.claim_generation,
        now: deliveryNow,
      });
      expect(
        await deliveries.claim(
          delivery.delivery_id,
          'delivery-b',
          100,
          new Date(deliveryNow.getTime() + 101)
        )
      ).toBeNull();
      expect((await deliveries.findById(delivery.delivery_id))?.status).toBe('ambiguous');
    }
  );

  ownedDbTest('holds later messages behind the oldest mapped Teams delivery', async ({ db }) => {
    const { channel, mapping } = await seedTeamsGateway(db);
    const { deliveries, messages } = teamsDeliveryWriters(db);
    const first = await messages.create(assistantMessage(mapping.session_id, 0));
    const second = await messages.create(assistantMessage(mapping.session_id, 1));
    const firstDelivery = await deliveries.findByMessageId(first.message_id);
    const secondDelivery = await deliveries.findByMessageId(second.message_id);
    if (!firstDelivery || !secondDelivery) throw new Error('missing ordered Teams deliveries');

    expect(
      (await deliveries.findDueRefs(db, { now: new Date() })).map((row) => row.delivery_id)
    ).toEqual([firstDelivery.delivery_id]);
    const claim = await deliveries.claim(
      firstDelivery.delivery_id,
      'ordered-a',
      30_000,
      new Date()
    );
    if (!claim) throw new Error('missing ordered delivery claim');
    expect(
      (await deliveries.findDueRefs(db, { now: new Date() })).map((row) => row.delivery_id)
    ).toEqual([]);
    await deliveries.complete({
      deliveryId: firstDelivery.delivery_id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      providerMessageId: 'teams-message-1',
      now: new Date(),
    });
    expect(
      (await deliveries.findDueRefs(db, { now: new Date() })).map((row) => row.delivery_id)
    ).toEqual([secondDelivery.delivery_id]);

    // The inbound table remains independently queryable and tenant-free in SQLite.
    expect(
      await select(db)
        .from(gatewayInboundEvents)
        .where(
          and(
            eq(gatewayInboundEvents.gateway_channel_id, channel.id),
            eq(gatewayInboundEvents.status, 'pending')
          )
        )
        .all()
    ).toHaveLength(0);
    await update(db, gatewayInboundEvents)
      .set({ status: 'completed', completed_at: new Date() })
      .where(eq(gatewayInboundEvents.gateway_channel_id, channel.id))
      .run();
  });

  ownedDbTest('holds a later inbound occurrence behind its predecessor', async ({ db }) => {
    const { channel } = await seedTeamsGateway(db);
    const inbound = new GatewayInboundEventRepository(db);
    const first = await inbound.admitVerifiedHttp(teamsAdmission(channel, 'teams:activity:first'));
    const second = await inbound.admitVerifiedHttp(
      teamsAdmission(channel, 'teams:activity:second')
    );
    expect(first.outcome).toBe('admitted');
    expect(second.outcome).toBe('admitted');

    expect(
      (await inbound.findDueTeamsRefs(db, { now: new Date() })).map((row) => row.event_id)
    ).toEqual([first.event.id]);
    const claim = await inbound.claimQueued(first.event.id, 'predecessor-token', 30_000);
    expect(claim).toBeTruthy();
    expect(await inbound.findDueTeamsRefs(db, { now: new Date() })).toEqual([]);
    expect(
      await inbound.complete({
        eventId: first.event.id,
        channelId: channel.id,
        processingToken: 'predecessor-token',
        requireListenerClaim: false,
      })
    ).toBe(true);
    expect(
      (await inbound.findDueTeamsRefs(db, { now: new Date() })).map((row) => row.event_id)
    ).toEqual([second.event.id]);
  });

  ownedDbTest(
    'discovers expired payloads and terminalizes them in tenant-scoped claim',
    async ({ db }) => {
      const { channel } = await seedTeamsGateway(db);
      const inbound = new GatewayInboundEventRepository(db);
      const admitted = await inbound.admitVerifiedHttp({
        ...teamsAdmission(channel, 'teams:activity:expires'),
        payloadTtlMs: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await inbound.findDueTeamsRefs(db, { now: new Date() })).toEqual([
        expect.objectContaining({ event_id: admitted.event.id }),
      ]);
      expect(await inbound.claimQueued(admitted.event.id, 'expired-claim', 30_000)).toBeNull();
      const stored = await select(db)
        .from(gatewayInboundEvents)
        .where(eq(gatewayInboundEvents.id, admitted.event.id))
        .one();
      expect(stored).toMatchObject({
        status: 'dead_letter',
        payload_encrypted: null,
        payload_expires_at: null,
        last_error_code: 'payload_expired',
      });
    }
  );

  ownedDbTest(
    'schedules inbound and outbound retries from the injected SQLite database time',
    async ({ db }) => {
      const { channel, mapping } = await seedTeamsGateway(db);
      const inbound = new GatewayInboundEventRepository(db);
      const admitted = await inbound.admitVerifiedHttp(
        teamsAdmission(channel, 'teams:activity:retry')
      );
      const inboundNow = new Date(admitted.event.next_attempt_at);
      expect(
        await inbound.claimQueued(admitted.event.id, 'inbound-retry', 30_000, inboundNow)
      ).toBeTruthy();
      expect(
        await inbound.failQueued({
          eventId: admitted.event.id,
          processingToken: 'inbound-retry',
          status: 'pending',
          errorCode: 'transient',
          retryDelayMs: 1_234,
          now: inboundNow,
        })
      ).toBe(true);
      const retriedInbound = await inbound.findByProviderEvent(channel.id, 'teams:activity:retry');
      expect(new Date(retriedInbound!.next_attempt_at).getTime()).toBe(
        inboundNow.getTime() + 1_234
      );

      const { deliveries, messages } = teamsDeliveryWriters(db);
      const message = await messages.create(assistantMessage(mapping.session_id, 0));
      const delivery = await deliveries.findByMessageId(message.message_id);
      if (!delivery) throw new Error('missing Teams delivery');
      const outboundNow = new Date(delivery.next_attempt_at);
      const claim = await deliveries.claim(
        delivery.delivery_id,
        'outbound-retry',
        30_000,
        outboundNow
      );
      if (!claim) throw new Error('missing delivery claim');
      await deliveries.fail({
        deliveryId: delivery.delivery_id,
        claimToken: claim.claim_token,
        claimGeneration: claim.claim_generation,
        status: 'pending',
        errorCode: 'transient',
        retryDelayMs: 2_345,
        now: outboundNow,
      });
      const retriedDelivery = await deliveries.findById(delivery.delivery_id);
      expect(new Date(retriedDelivery!.next_attempt_at).getTime()).toBe(
        outboundNow.getTime() + 2_345
      );
    }
  );

  ownedDbTest(
    'expires only the claimed row, leaving bounded discovery to collect the rest',
    async ({ db }) => {
      const { channel } = await seedTeamsGateway(db);
      const inbound = new GatewayInboundEventRepository(db);
      const first = await inbound.admitVerifiedHttp(teamsAdmission(channel, 'expiry-a'));
      const second = await inbound.admitVerifiedHttp(teamsAdmission(channel, 'expiry-b'));
      await update(db, gatewayInboundEvents)
        .set({ payload_expires_at: new Date(0) })
        .where(eq(gatewayInboundEvents.gateway_channel_id, channel.id))
        .run();
      expect(await inbound.claimQueued(first.event.id, 'expiry-worker', 30_000)).toBeNull();
      const untouched = await inbound.findByProviderEvent(channel.id, 'expiry-b');
      expect(untouched?.status).toBe('pending');
      expect(untouched?.payload_encrypted).toBeTruthy();
      expect(await inbound.findDueTeamsRefs(db, { limit: 1 })).toEqual([
        {
          tenant_id: 'default',
          gateway_channel_id: channel.id,
          thread_id: TEAMS_THREAD_ID,
          event_id: second.event.id,
        },
      ]);
    }
  );
});
