import type { BranchID, Message, MessageID, SessionID, UUID } from '@agor/core/types';
import { MessageRole, SessionStatus } from '@agor/core/types';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { select, update } from '../database-wrapper';
import { gatewayInboundEvents } from '../schema';
import { ownedDbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import {
  GatewayInboundEventRepository,
  type TeamsVerifiedHttpAdmissionInput,
} from './gateway-inbound-events';
import { MessagesRepository } from './messages';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import {
  decryptTeamsConversationAddress,
  TEAMS_CONVERSATION_ADDRESS_TTL_MS,
  TeamsConversationAddressRepository,
} from './teams-conversation-addresses';
import { TeamsMessageDeliveryRepository } from './teams-message-deliveries';
import { ThreadSessionMapRepository } from './thread-session-map';

const teamsConfig = {
  app_id: 'teams-app-id',
  app_password: 'teams-app-secret',
  microsoft_tenant_id: 'teams-tenant-id',
  require_mention: true,
  allow_thread_replies_without_mention: true,
  catch_up: {
    mode: 'best_effort' as const,
    max_messages: 50,
    max_prompt_bytes: 16 * 1024,
    request_timeout_ms: 2_000,
  },
  outbound_enabled: true,
};

async function seedTeamsMapping(db: Database) {
  const userId = 'test-user' as UUID;
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `teams/${generateId()}`,
    name: 'Teams gateway test repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/teams-gateway.git',
    local_path: '/tmp/teams-gateway-test-repo',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'main',
    ref: 'refs/heads/main',
    branch_unique_id: 1,
    path: '/tmp/teams-gateway-test-repo/main',
    created_by: userId,
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId() as SessionID,
    branch_id: branch.branch_id as BranchID,
    created_by: userId,
    status: SessionStatus.IDLE,
    title: 'Teams gateway session',
    tasks: [],
  });
  const channel = await new GatewayChannelRepository(db).create({
    name: 'Teams gateway',
    created_by: userId,
    target_branch_id: branch.branch_id as UUID,
    agor_user_id: userId,
    channel_type: 'teams',
    enabled: false,
    config: teamsConfig,
  });
  const enabledChannel = await new GatewayChannelRepository(db).update(channel.id, {
    enabled: true,
  });
  const mapping = await new ThreadSessionMapRepository(db).create({
    channel_id: enabledChannel.id,
    thread_id: '19:conversation@thread.tacv2',
    session_id: session.session_id,
    branch_id: branch.branch_id,
    metadata: {},
  });
  return { channel: enabledChannel, mapping, session };
}

function assistantMessage(sessionId: SessionID, index: number): Message {
  return {
    message_id: generateId() as MessageID,
    session_id: sessionId,
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    index,
    timestamp: new Date().toISOString(),
    content_preview: `Reply ${index}`,
    content: `Reply ${index}`,
  };
}

function admissionInput(
  channelId: string,
  generation: number,
  providerEventId = 'teams:activity:activity-1',
  threadId = '19:conversation@thread.tacv2'
): TeamsVerifiedHttpAdmissionInput {
  return {
    channelId: channelId as never,
    providerEventId,
    threadId,
    payload: { providerEventId, threadId, text: 'hello' },
    deliveryMetadata: {
      teams_tenant_id: 'teams-tenant-id',
      teams_conversation_id: '19:secret@thread.tacv2',
      teams_channel_name: 'safe-display-name',
    },
    address: {
      gatewayChannelId: channelId as never,
      threadId,
      conversationId: '19:conversation@thread.tacv2',
      rootMessageId: null,
      address: { serviceUrl: 'https://smba.trafficmanager.net/teams/' },
      verifiedAppId: 'teams-app-id',
      verifiedTenantId: 'teams-tenant-id',
      providerConfigGeneration: generation,
    },
    providerConfigGeneration: generation,
    verifiedAppId: 'teams-app-id',
    verifiedTenantId: 'teams-tenant-id',
  };
}

describe('Teams gateway HA repositories', () => {
  const priorMasterSecret = process.env.AGOR_MASTER_SECRET;
  beforeAll(() => {
    process.env.AGOR_MASTER_SECRET = 'teams-gateway-ha-test-secret';
  });
  afterAll(() => {
    if (priorMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
    else process.env.AGOR_MASTER_SECRET = priorMasterSecret;
  });

  ownedDbTest(
    'commits encrypted admission once and refreshes the durable address on retries',
    async ({ db }) => {
      const { channel } = await seedTeamsMapping(db);
      const inbound = new GatewayInboundEventRepository(db);
      const addresses = new TeamsConversationAddressRepository(db);
      const input = admissionInput(channel.id, channel.provider_config_generation);
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
      expect(await addresses.addressForChannelAndThread(channel.id, input.threadId)).toEqual(
        input.address.address
      );

      await expect(
        inbound.admitVerifiedHttp(
          admissionInput(
            channel.id,
            channel.provider_config_generation,
            input.providerEventId,
            'different-thread'
          )
        )
      ).rejects.toThrow('different thread');
      expect(await addresses.findByChannelAndThread(channel.id, 'different-thread')).toBeNull();

      const rawAddress = await addresses.findByChannelAndThread(channel.id, input.threadId);
      expect(rawAddress).toBeTruthy();
      expect(rawAddress?.expires_at).toBeTruthy();
      for (const storedAddress of [firstRawAddress, rawAddress]) {
        expect(storedAddress?.refreshed_at).not.toBe(callerBehind.toISOString());
        expect(storedAddress?.expires_at).not.toBe(callerAhead.toISOString());
        expect(new Date(storedAddress!.expires_at!).getTime()).toBe(
          new Date(storedAddress!.refreshed_at).getTime() + TEAMS_CONVERSATION_ADDRESS_TTL_MS
        );
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
      const { channel } = await seedTeamsMapping(db);
      const inbound = new GatewayInboundEventRepository(db);
      const input = admissionInput(channel.id, channel.provider_config_generation);
      const admitted = await inbound.admitVerifiedHttp(input);
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

      const deliveries = new TeamsMessageDeliveryRepository(db);
      const messages = new MessagesRepository(db, (tx, message) =>
        deliveries.enqueueForMessageInTransaction(tx, message).then(() => undefined)
      );
      const mapping = await new ThreadSessionMapRepository(db).findByChannelAndThread(
        channel.id,
        input.threadId
      );
      if (!mapping) throw new Error('missing test mapping');
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
    const { channel, mapping } = await seedTeamsMapping(db);
    const deliveries = new TeamsMessageDeliveryRepository(db);
    const messages = new MessagesRepository(db, (tx, message) =>
      deliveries.enqueueForMessageInTransaction(tx, message).then(() => undefined)
    );
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
    const { channel } = await seedTeamsMapping(db);
    const inbound = new GatewayInboundEventRepository(db);
    const first = await inbound.admitVerifiedHttp(
      admissionInput(channel.id, channel.provider_config_generation, 'teams:activity:first')
    );
    const second = await inbound.admitVerifiedHttp(
      admissionInput(channel.id, channel.provider_config_generation, 'teams:activity:second')
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
    'advances the Teams catch-up cursor only from the expected predecessor',
    async ({ db }) => {
      const { mapping } = await seedTeamsMapping(db);
      const maps = new ThreadSessionMapRepository(db);
      expect(await maps.advanceTeamsLastAdmittedActivityId(mapping.id, 'activity-1', null)).toBe(
        true
      );
      expect(await maps.advanceTeamsLastAdmittedActivityId(mapping.id, 'activity-2', null)).toBe(
        false
      );
      expect(
        await maps.advanceTeamsLastAdmittedActivityId(mapping.id, 'activity-2', 'activity-1')
      ).toBe(true);
      expect((await maps.findById(mapping.id))?.teams_last_admitted_activity_id).toBe('activity-2');
    }
  );

  ownedDbTest(
    'discovers expired payloads and terminalizes them in tenant-scoped claim',
    async ({ db }) => {
      const { channel } = await seedTeamsMapping(db);
      const inbound = new GatewayInboundEventRepository(db);
      const admitted = await inbound.admitVerifiedHttp({
        ...admissionInput(channel.id, channel.provider_config_generation, 'teams:activity:expires'),
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
    'discovers expired encrypted payloads after their Teams channel is disabled',
    async ({ db }) => {
      const { channel } = await seedTeamsMapping(db);
      const inbound = new GatewayInboundEventRepository(db);
      const admitted = await inbound.admitVerifiedHttp({
        ...admissionInput(
          channel.id,
          channel.provider_config_generation,
          'teams:activity:disabled'
        ),
        payloadTtlMs: 1,
      });
      await new GatewayChannelRepository(db).update(channel.id, { enabled: false });
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(await inbound.findDueTeamsRefs(db, { now: new Date() })).toEqual([
        {
          tenant_id: 'default',
          gateway_channel_id: channel.id,
          event_id: admitted.event.id,
        },
      ]);
      expect(
        await inbound.claimQueued(admitted.event.id, 'expired-disabled-claim', 30_000)
      ).toBeNull();
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
    'dead-letters a permanent inbound fence and erases its queued payload',
    async ({ db }) => {
      const { channel } = await seedTeamsMapping(db);
      const inbound = new GatewayInboundEventRepository(db);
      const admitted = await inbound.admitVerifiedHttp(
        admissionInput(channel.id, channel.provider_config_generation, 'teams:activity:permanent')
      );
      const claimed = await inbound.claimQueued(admitted.event.id, 'permanent-claim', 30_000);
      expect(claimed).toBeTruthy();

      expect(
        await inbound.failQueued({
          eventId: admitted.event.id,
          processingToken: 'permanent-claim',
          status: 'dead_letter',
          errorCode: 'teams_payload_identity_mismatch',
        })
      ).toBe(true);
      const stored = await select(db)
        .from(gatewayInboundEvents)
        .where(eq(gatewayInboundEvents.id, admitted.event.id))
        .one();
      expect(stored).toMatchObject({
        status: 'dead_letter',
        payload_encrypted: null,
        payload_expires_at: null,
        last_error_code: 'teams_payload_identity_mismatch',
      });
    }
  );

  ownedDbTest(
    'schedules inbound and outbound retries from the injected SQLite database time',
    async ({ db }) => {
      const { channel, mapping } = await seedTeamsMapping(db);
      const inbound = new GatewayInboundEventRepository(db);
      const admitted = await inbound.admitVerifiedHttp(
        admissionInput(channel.id, channel.provider_config_generation, 'teams:activity:retry')
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

      const deliveries = new TeamsMessageDeliveryRepository(db);
      const messages = new MessagesRepository(db, (tx, message) =>
        deliveries.enqueueForMessageInTransaction(tx, message).then(() => undefined)
      );
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
});
