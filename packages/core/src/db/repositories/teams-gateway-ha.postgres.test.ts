/**
 * PostgreSQL HA/RLS coverage for the Teams ingress lane.
 *
 * Run with AGOR_DB_DIALECT=postgresql and AGOR_TEST_POSTGRES_URL set. The
 * SQLite repository suite covers the same transitions without a live server;
 * this file proves tenant projection, qualified tenant selection, and two
 * independent replica claims against PostgreSQL row-level security.
 */

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { BranchID, MessageID, SessionID, TenantID, UUID } from '../../types';
import { MessageRole, TaskStatus } from '../../types';
import { createDatabase, type Database } from '../client';
import {
  executeRaw,
  getDatabaseNow,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import {
  BranchRepository,
  GatewayChannelRepository,
  GatewayInboundEventRepository,
  MessagesRepository,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  TeamsMessageDeliveryRepository,
  ThreadSessionMapRepository,
  UsersRepository,
} from '../repositories';
import { getPostgresSqlState } from '../sanitize-error';
import { gatewayChannels, gatewayInboundEvents, tasks, teamsMessageDeliveries } from '../schema';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from '../tenant-scope';
import {
  TEAMS_CONVERSATION_ADDRESS_TTL_MS,
  TeamsConversationAddressRepository,
} from './teams-conversation-addresses';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

async function seedTeamsChannel(db: Database, tenantId: TenantID) {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const appId = `teams-app-${generateId()}`;
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}-${generateId()}@example.com`,
      name: 'Teams HA PostgreSQL',
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId() as UUID,
      slug: `teams-ha-${generateId()}`,
      name: 'Teams HA PostgreSQL',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/teams-ha.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id as UUID,
      name: 'main',
      ref: 'main',
      branch_unique_id: Date.now() % 1_000_000,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
    });
    const session = await new SessionRepository(scoped).create({
      session_id: generateId() as SessionID,
      branch_id: branch.branch_id,
      created_by: user.user_id,
      status: 'idle',
      title: 'Teams HA PostgreSQL',
      tasks: [],
    });
    const channel = await new GatewayChannelRepository(scoped).create({
      name: 'Teams HA PostgreSQL',
      created_by: user.user_id,
      target_branch_id: branch.branch_id as UUID,
      agor_user_id: user.user_id,
      channel_type: 'teams',
      enabled: true,
      provider_installation_id: appId,
      config: {
        app_id: appId,
        app_password: 'teams-secret',
        microsoft_tenant_id: tenantId,
        catch_up: {
          mode: 'best_effort',
          max_messages: 50,
          max_prompt_bytes: 16 * 1024,
          request_timeout_ms: 2_000,
        },
        outbound_enabled: true,
      },
    });
    const mapping = await new ThreadSessionMapRepository(scoped).create({
      channel_id: channel.id,
      thread_id: '19:postgres-channel|root-1',
      session_id: session.session_id,
      branch_id: branch.branch_id,
      metadata: {},
    });
    return { appId, channel, session, mapping };
  });
}

async function seedClaimedTeamsDelivery(db: Database, tenantId: TenantID) {
  const { channel, session } = await seedTeamsChannel(db, tenantId);
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const deliveries = new TeamsMessageDeliveryRepository(scoped);
    const messages = new MessagesRepository(scoped, (tx, message) =>
      deliveries.enqueueForMessageInTransaction(tx, message).then(() => undefined)
    );
    const message = await messages.create({
      message_id: generateId() as MessageID,
      session_id: session.session_id,
      type: 'assistant',
      role: MessageRole.ASSISTANT,
      index: 0,
      timestamp: new Date().toISOString(),
      content_preview: 'effect cutoff',
      content: 'effect cutoff',
    });
    const delivery = await deliveries.findByMessageId(message.message_id);
    if (!delivery) throw new Error('missing fixture delivery');
    const claim = await deliveries.claim(delivery.delivery_id, 'effect-owner', 30_000);
    if (!claim) throw new Error('missing fixture delivery claim');
    return { channel, claim };
  });
}

function admission(channelId: string, tenantId: string, providerEventId: string, appId: string) {
  return {
    channelId: channelId as never,
    providerEventId,
    threadId: '19:postgres-channel|root-1',
    payload: {
      providerEventId,
      threadId: '19:postgres-channel|root-1',
      text: 'hello',
    },
    deliveryMetadata: {
      teams_service_url: 'https://smba.trafficmanager.net/teams/',
      teams_tenant_id: tenantId,
      teams_channel_name: 'safe display',
    },
    address: {
      gatewayChannelId: channelId as never,
      threadId: '19:postgres-channel|root-1',
      conversationId: '19:postgres-channel',
      rootMessageId: 'root-1',
      address: { serviceUrl: 'https://smba.trafficmanager.net/teams/' },
      verifiedAppId: appId,
      verifiedTenantId: tenantId,
      providerConfigGeneration: 1,
    },
    providerConfigGeneration: 1,
    verifiedAppId: appId,
    verifiedTenantId: tenantId,
  };
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)('Teams gateway HA PostgreSQL/RLS', () => {
  let dbA: Database;
  let dbB: Database;

  beforeAll(async () => {
    dbA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    dbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(dbA);
  });

  afterAll(async () => {
    await Promise.all([
      (dbA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      (dbB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
    ]);
  });

  it('projects tenant ids without ambiguous joins and serializes the same lane across replicas', async () => {
    const tenantId = `teams-pg-${generateId()}` as TenantID;
    const { appId, channel, mapping } = await seedTeamsChannel(dbA, tenantId);
    const first = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).admitVerifiedHttp(
        admission(channel.id, tenantId, 'teams:activity:pg-first', appId)
      )
    );
    const second = await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).admitVerifiedHttp(
        admission(channel.id, tenantId, 'teams:activity:pg-second', appId)
      )
    );

    const due = await runWithSystemDatabaseScope(
      dbA,
      'Teams PostgreSQL lane discovery',
      (systemDb) =>
        new GatewayInboundEventRepository(systemDb).findDueTeamsRefs(systemDb, {
          limit: 10,
          now: new Date(),
        }),
      { capability: 'teams_gateway_ingress_discovery' }
    );
    expect(due).toEqual([
      { tenant_id: tenantId, gateway_channel_id: channel.id, event_id: first.event.id },
    ]);

    const firstClaim = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).claimQueued(
        first.event.id,
        'replica-a',
        30_000,
        new Date()
      )
    );
    expect(firstClaim).toBeTruthy();
    expect(
      await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
        new GatewayInboundEventRepository(scoped).claimQueued(
          second.event.id,
          'replica-b',
          30_000,
          new Date()
        )
      )
    ).toBeNull();

    await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).complete({
        eventId: first.event.id,
        channelId: channel.id,
        processingToken: 'replica-a',
        requireListenerClaim: false,
      })
    );
    expect(
      (
        await runWithSystemDatabaseScope(
          dbB,
          'Teams PostgreSQL second lane discovery',
          (systemDb) =>
            new GatewayInboundEventRepository(systemDb).findDueTeamsRefs(systemDb, {
              limit: 10,
              now: new Date(),
            }),
          { capability: 'teams_gateway_ingress_discovery' }
        )
      ).map((ref) => ref.event_id)
    ).toEqual([second.event.id]);

    const otherTenant = `teams-pg-other-${generateId()}` as TenantID;
    expect(
      await runWithTenantDatabaseScope(dbB, otherTenant, (scoped) =>
        new GatewayInboundEventRepository(scoped).findByProviderEvent(
          channel.id,
          'teams:activity:pg-first'
        )
      )
    ).toBeNull();

    expect(
      await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new ThreadSessionMapRepository(scoped).advanceTeamsLastAdmittedActivityId(
          mapping.id,
          'activity-second',
          null
        )
      )
    ).toBe(true);
    expect(
      await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
        new ThreadSessionMapRepository(scoped).advanceTeamsLastAdmittedActivityId(
          mapping.id,
          'activity-first',
          null
        )
      )
    ).toBe(false);
  });

  it('terminalizes expired encrypted payloads inside the owning tenant scope', async () => {
    const tenantId = `teams-pg-expiry-${generateId()}` as TenantID;
    const { appId, channel } = await seedTeamsChannel(dbA, tenantId);
    const admitted = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).admitVerifiedHttp({
        ...admission(channel.id, tenantId, 'teams:activity:pg-expired', appId),
        payloadTtlMs: 1,
      })
    );
    await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayChannelRepository(scoped).update(channel.id, { enabled: false })
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const due = await runWithSystemDatabaseScope(
      dbA,
      'Teams PostgreSQL expired payload discovery',
      (systemDb) =>
        new GatewayInboundEventRepository(systemDb).findDueTeamsRefs(systemDb, {
          limit: 100,
          now: new Date(),
        }),
      { capability: 'teams_gateway_ingress_discovery' }
    );
    expect(due.map((ref) => ref.event_id)).toContain(admitted.event.id);

    const otherTenant = `${tenantId}-other` as TenantID;
    expect(
      await runWithTenantDatabaseScope(dbB, otherTenant, (scoped) =>
        new GatewayInboundEventRepository(scoped).claimQueued(
          admitted.event.id,
          'wrong-tenant-claim',
          30_000,
          new Date()
        )
      )
    ).toBeNull();

    expect(
      await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new GatewayInboundEventRepository(scoped).claimQueued(
          admitted.event.id,
          'expiry-claim',
          30_000,
          new Date()
        )
      )
    ).toBeNull();
    const terminal = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).findByProviderEvent(
        channel.id,
        'teams:activity:pg-expired'
      )
    );
    expect(terminal).toMatchObject({
      status: 'dead_letter',
      payload_encrypted: null,
      payload_expires_at: null,
      last_error_code: 'payload_expired',
    });
  });

  it('uses PostgreSQL transaction time for skewed discovery, retries, leases, and effect fences', async () => {
    const tenantId = `teams-pg-clock-${generateId()}` as TenantID;
    const { appId, channel, mapping } = await seedTeamsChannel(dbA, tenantId);
    const callerBehind = new Date('2000-01-01T00:00:00.000Z');
    const callerAhead = new Date('2999-01-01T00:00:00.000Z');
    const baseAdmission = admission(
      channel.id,
      tenantId,
      `teams:activity:clock-${generateId()}`,
      appId
    );
    const skewedAdmission = {
      ...baseAdmission,
      address: {
        ...baseAdmission.address,
        refreshedAt: callerBehind,
        expiresAt: callerAhead,
      },
    };
    const addressDatabaseStart = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      getDatabaseNow(scoped, gatewayChannels, eq(gatewayChannels.id, channel.id))
    );
    const admitted = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).admitVerifiedHttp(skewedAdmission)
    );
    const addressDatabaseEnd = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      getDatabaseNow(scoped, gatewayChannels, eq(gatewayChannels.id, channel.id))
    );
    const storedAddress = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new TeamsConversationAddressRepository(scoped).findByChannelAndThread(
        channel.id,
        skewedAdmission.threadId
      )
    );
    expect(storedAddress).toBeTruthy();
    expect(addressDatabaseStart).toBeTruthy();
    expect(addressDatabaseEnd).toBeTruthy();
    expect(new Date(storedAddress!.refreshed_at).getTime()).toBeGreaterThanOrEqual(
      addressDatabaseStart!.getTime()
    );
    expect(new Date(storedAddress!.refreshed_at).getTime()).toBeLessThanOrEqual(
      addressDatabaseEnd!.getTime()
    );
    expect(storedAddress!.refreshed_at).not.toBe(callerBehind.toISOString());
    expect(storedAddress!.expires_at).not.toBe(callerAhead.toISOString());
    expect(new Date(storedAddress!.expires_at!).getTime()).toBe(
      new Date(storedAddress!.refreshed_at).getTime() + TEAMS_CONVERSATION_ADDRESS_TTL_MS
    );

    const inboundDue = await runWithSystemDatabaseScope(
      dbA,
      'Teams PostgreSQL skewed-clock ingress discovery',
      (systemDb) =>
        new GatewayInboundEventRepository(systemDb).findDueTeamsRefs(systemDb, {
          limit: 10,
          now: callerBehind,
        }),
      { capability: 'teams_gateway_ingress_discovery' }
    );
    expect(inboundDue.map((ref) => ref.event_id)).toContain(admitted.event.id);

    const inboundClaim = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).claimQueued(
        admitted.event.id,
        'clock-replica-a',
        30_000,
        callerBehind
      )
    );
    expect(inboundClaim).toBeTruthy();
    expect(new Date(inboundClaim!.processing_expires_at).getTime()).toBeGreaterThan(
      callerBehind.getTime()
    );
    expect(
      await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new GatewayInboundEventRepository(scoped).claimQueued(
          admitted.event.id,
          'clock-replica-b',
          30_000,
          callerAhead
        )
      )
    ).toBeNull();
    expect(
      await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new GatewayInboundEventRepository(scoped).complete({
          eventId: admitted.event.id,
          channelId: channel.id,
          processingToken: 'clock-replica-a',
          requireListenerClaim: false,
        })
      )
    ).toBe(true);

    const retriedInbound = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).admitVerifiedHttp(
        admission(channel.id, tenantId, `teams:activity:retry-${generateId()}`, appId)
      )
    );
    const retriedInboundClaim = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).claimQueued(
        retriedInbound.event.id,
        'clock-retry-inbound',
        30_000,
        callerBehind
      )
    );
    expect(retriedInboundClaim).toBeTruthy();
    const inboundRetryStartedAt = Date.now();
    await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).failQueued({
        eventId: retriedInbound.event.id,
        processingToken: 'clock-retry-inbound',
        status: 'pending',
        errorCode: 'transient',
        retryDelayMs: 60_000,
        now: callerAhead,
      })
    );
    const inboundRetryRow = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).findByProviderEvent(
        channel.id,
        retriedInbound.event.provider_event_id
      )
    );
    expect(new Date(inboundRetryRow!.next_attempt_at).getTime()).toBeGreaterThan(
      inboundRetryStartedAt + 55_000
    );
    expect(new Date(inboundRetryRow!.next_attempt_at).getTime()).toBeLessThan(
      callerAhead.getTime()
    );

    const deliveries = new TeamsMessageDeliveryRepository(dbA);
    let messageId: MessageID;
    await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
      const messages = new MessagesRepository(scoped, (tx, message) =>
        deliveries.enqueueForMessageInTransaction(tx, message).then(() => undefined)
      );
      const message = await messages.create({
        message_id: generateId() as MessageID,
        session_id: mapping.session_id,
        type: 'assistant',
        role: MessageRole.ASSISTANT,
        index: 0,
        timestamp: new Date().toISOString(),
        content_preview: 'clock reply',
        content: 'clock reply',
      });
      messageId = message.message_id;
    });
    const delivery = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new TeamsMessageDeliveryRepository(scoped).findByMessageId(messageId!)
    );
    expect(delivery).toBeTruthy();
    const deliveryDue = await runWithSystemDatabaseScope(
      dbA,
      'Teams PostgreSQL skewed-clock delivery discovery',
      (systemDb) =>
        new TeamsMessageDeliveryRepository(systemDb).findDueRefs(systemDb, {
          limit: 10,
          now: callerBehind,
        }),
      { capability: 'teams_message_delivery_discovery' }
    );
    expect(deliveryDue.map((ref) => ref.delivery_id)).toContain(delivery!.delivery_id);
    const deliveryClaim = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new TeamsMessageDeliveryRepository(scoped).claim(
        delivery!.delivery_id,
        'clock-delivery',
        30_000,
        callerBehind
      )
    );
    expect(deliveryClaim).toBeTruthy();
    await expect(
      runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new TeamsMessageDeliveryRepository(scoped).markEffectStarted({
          deliveryId: delivery!.delivery_id,
          claimToken: deliveryClaim!.claim_token,
          claimGeneration: deliveryClaim!.claim_generation,
          now: callerAhead,
        })
      )
    ).resolves.toMatchObject({ status: 'processing', effect_started_at: expect.any(String) });
    await expect(
      runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new TeamsMessageDeliveryRepository(scoped).complete({
          deliveryId: delivery!.delivery_id,
          claimToken: deliveryClaim!.claim_token,
          claimGeneration: deliveryClaim!.claim_generation,
          providerMessageId: 'teams-clock-message',
          now: callerAhead,
        })
      )
    ).resolves.toMatchObject({ status: 'completed' });

    let retryMessageId: MessageID;
    await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
      const messages = new MessagesRepository(scoped, (tx, message) =>
        deliveries.enqueueForMessageInTransaction(tx, message).then(() => undefined)
      );
      const message = await messages.create({
        message_id: generateId() as MessageID,
        session_id: mapping.session_id,
        type: 'assistant',
        role: MessageRole.ASSISTANT,
        index: 1,
        timestamp: new Date().toISOString(),
        content_preview: 'clock retry reply',
        content: 'clock retry reply',
      });
      retryMessageId = message.message_id;
    });
    const retryDelivery = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new TeamsMessageDeliveryRepository(scoped).findByMessageId(retryMessageId!)
    );
    expect(retryDelivery).toBeTruthy();
    const retryDeliveryClaim = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new TeamsMessageDeliveryRepository(scoped).claim(
        retryDelivery!.delivery_id,
        'clock-retry-delivery',
        30_000,
        callerBehind
      )
    );
    expect(retryDeliveryClaim).toBeTruthy();
    const outboundRetryStartedAt = Date.now();
    const failedDelivery = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new TeamsMessageDeliveryRepository(scoped).fail({
        deliveryId: retryDelivery!.delivery_id,
        claimToken: retryDeliveryClaim!.claim_token,
        claimGeneration: retryDeliveryClaim!.claim_generation,
        status: 'pending',
        errorCode: 'transient',
        retryDelayMs: 60_000,
        now: callerAhead,
      })
    );
    expect(new Date(failedDelivery.next_attempt_at).getTime()).toBeGreaterThan(
      outboundRetryStartedAt + 55_000
    );
    expect(new Date(failedDelivery.next_attempt_at).getTime()).toBeLessThan(callerAhead.getTime());
  });
  it.each(['disable', 'policy', 'reclaim'] as const)(
    'rejects stale admission after another replica commits %s',
    async (mutation) => {
      const tenantId = `teams-cutoff-${generateId()}` as TenantID;
      const { appId, channel, session } = await seedTeamsChannel(dbA, tenantId);
      const claim = await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const inbound = new GatewayInboundEventRepository(scoped);
        const admitted = await inbound.admitVerifiedHttp(
          admission(channel.id, tenantId, 'cutoff', appId)
        );
        return inbound.claimQueued(admitted.event.id, 'replica-a', 30_000);
      });
      if (!claim) throw new Error('missing claim');
      let resume!: () => void;
      const pause = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const work = (async () => {
        await pause;
        return runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          runDatabaseTransaction(scoped, async (tx) => {
            await new GatewayInboundEventRepository(tx).assertTeamsTaskAdmission(claim);
            return new TaskRepository(tx).createPending({
              status: TaskStatus.QUEUED,
              session_id: session.session_id,
              full_prompt: 'stale',
              created_by: session.created_by!,
            });
          })
        );
      })();
      await runWithTenantDatabaseScope(dbB, tenantId, async (scoped) => {
        if (mutation === 'reclaim') {
          await update(scoped, gatewayInboundEvents)
            .set({ processing_expires_at: new Date(0) })
            .where(eq(gatewayInboundEvents.id, claim.id))
            .run();
          expect(
            await new GatewayInboundEventRepository(scoped).claimQueued(
              claim.id,
              'replica-b',
              30_000
            )
          ).toBeTruthy();
        } else {
          await new GatewayChannelRepository(scoped).update(
            channel.id,
            mutation === 'disable'
              ? { enabled: false }
              : { config: { ...channel.config, allowed_user_aad_object_ids: ['revoked'] } }
          );
        }
      });
      const rejected = expect(work).rejects.toThrow('admission authority');
      resume();
      await rejected;
      expect(
        await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          select(scoped).from(tasks).where(eq(tasks.session_id, session.session_id)).all()
        )
      ).toEqual([]);
    }
  );

  it('rejects a foreign-tenant admission capability even with its exact event token', async () => {
    const tenantA = `teams-owner-${generateId()}` as TenantID;
    const tenantB = `teams-foreign-${generateId()}` as TenantID;
    const { appId, channel } = await seedTeamsChannel(dbA, tenantA);
    await seedTeamsChannel(dbB, tenantB);
    const claim = await runWithTenantDatabaseScope(dbA, tenantA, async (scoped) => {
      const inbound = new GatewayInboundEventRepository(scoped);
      const admitted = await inbound.admitVerifiedHttp(
        admission(channel.id, tenantA, 'foreign', appId)
      );
      return inbound.claimQueued(admitted.event.id, 'owner-token', 30_000);
    });
    if (!claim) throw new Error('missing claim');
    await expect(
      runWithTenantDatabaseScope(dbB, tenantB, (scoped) =>
        runDatabaseTransaction(scoped, (tx) =>
          new GatewayInboundEventRepository(tx).assertTeamsTaskAdmission(claim)
        )
      )
    ).rejects.toThrow('admission authority');
  });
  it('holds channel and event locks through Task insertion and commit', async () => {
    const tenantId = `teams-locks-${generateId()}` as TenantID;
    const { appId, channel, session } = await seedTeamsChannel(dbA, tenantId);
    const claim = await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
      const inbound = new GatewayInboundEventRepository(scoped);
      const admitted = await inbound.admitVerifiedHttp(
        admission(channel.id, tenantId, 'locked', appId)
      );
      return inbound.claimQueued(admitted.event.id, 'owner', 30_000);
    });
    if (!claim) throw new Error('missing claim');
    let locked!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const work = runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      runDatabaseTransaction(scoped, async (tx) => {
        await new GatewayInboundEventRepository(tx).assertTeamsTaskAdmission(claim);
        locked();
        await pause;
        return new TaskRepository(tx).createPending({
          status: TaskStatus.QUEUED,
          session_id: session.session_id,
          full_prompt: 'current',
          created_by: session.created_by!,
        });
      })
    );
    try {
      await Promise.race([ready, work]);
      for (const target of ['channel', 'event'] as const) {
        await expect(
          runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
            runDatabaseTransaction(scoped, async (tx) => {
              await executeRaw(tx, sql`SET LOCAL lock_timeout = '100ms'`);
              if (target === 'channel') {
                await new GatewayChannelRepository(tx).update(channel.id, { enabled: false });
              } else {
                await update(tx, gatewayInboundEvents)
                  .set({ processing_token: 'stale-reclaimer' })
                  .where(eq(gatewayInboundEvents.id, claim.id))
                  .run();
              }
            })
          )
        ).rejects.toThrow();
      }
    } finally {
      resume();
    }
    expect((await work).session_id).toBe(session.session_id);
  });
  it.each(['disable', 'config-change'] as const)(
    'denies the effect marker and send when another replica commits %s first',
    async (mutation) => {
      const tenantId = `teams-effect-${generateId()}` as TenantID;
      const { channel, claim } = await seedClaimedTeamsDelivery(dbA, tenantId);
      // The worker has read the enabled channel and claimed the delivery. Pause
      // its asynchronous address/pre-send preparation before the atomic marker.
      let resume!: () => void;
      const pause = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let sent = false;
      const work = (async () => {
        await pause;
        await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new TeamsMessageDeliveryRepository(scoped).markEffectStarted({
            deliveryId: claim.delivery_id,
            claimToken: claim.claim_token,
            claimGeneration: claim.claim_generation,
          })
        );
        sent = true;
      })();
      try {
        await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
          new GatewayChannelRepository(scoped).update(
            channel.id,
            mutation === 'disable'
              ? { enabled: false }
              : { config: { ...channel.config, catch_up: { mode: 'off' } } }
          )
        );
      } finally {
        resume();
      }
      await expect(work).rejects.toThrow();
      expect(sent).toBe(false);
      expect(
        await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new TeamsMessageDeliveryRepository(scoped).findById(claim.delivery_id)
        )
      ).toMatchObject({ effect_started_at: null });
    }
  );

  it('holds channel and delivery locks until the effect marker transaction commits', async () => {
    const tenantId = `teams-effect-locks-${generateId()}` as TenantID;
    const { channel, claim } = await seedClaimedTeamsDelivery(dbA, tenantId);
    let marked!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>((resolve) => {
      marked = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const work = runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      runDatabaseTransaction(scoped, async (tx) => {
        // markEffectStarted's nested transaction releases its savepoint, not
        // the outer transaction's row locks. Pause before the durable commit.
        const result = await new TeamsMessageDeliveryRepository(tx).markEffectStarted({
          deliveryId: claim.delivery_id,
          claimToken: claim.claim_token,
          claimGeneration: claim.claim_generation,
        });
        marked();
        await pause;
        return result;
      })
    );
    try {
      await Promise.race([ready, work]);
      expect(
        await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
          new TeamsMessageDeliveryRepository(scoped).findById(claim.delivery_id)
        )
      ).toMatchObject({ effect_started_at: null });
      for (const target of ['channel', 'delivery'] as const) {
        const outcome = await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
          runDatabaseTransaction(scoped, async (tx) => {
            await executeRaw(tx, sql`SET LOCAL lock_timeout = '100ms'`);
            if (target === 'channel') {
              await new GatewayChannelRepository(tx).update(channel.id, { enabled: false });
            } else {
              await update(tx, teamsMessageDeliveries)
                .set({ claim_token: 'foreign-worker' })
                .where(eq(teamsMessageDeliveries.delivery_id, claim.delivery_id))
                .run();
            }
          })
        ).then(
          () => 'unexpected_success',
          (error: unknown) => getPostgresSqlState(error)
        );
        expect(outcome).toBe('55P03');
      }
    } finally {
      resume();
    }
    expect((await work).effect_started_at).toBeTruthy();
    // Once the marker commits, revocation is allowed, but it cannot retract
    // the already-authorized provider effect (the documented cutoff).
    await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
      new GatewayChannelRepository(scoped).update(channel.id, { enabled: false })
    );
    expect(
      await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
        new TeamsMessageDeliveryRepository(scoped).findById(claim.delivery_id)
      )
    ).toMatchObject({ effect_started_at: expect.any(String), claim_token: claim.claim_token });
  });
});
