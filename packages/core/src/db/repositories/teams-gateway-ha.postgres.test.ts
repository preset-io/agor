/**
 * PostgreSQL HA/RLS coverage for the Teams gateway lanes. Engine-neutral cases
 * from the shared support run here against two connections and a foreign
 * tenant; the rest prove tenant projection, discovery policies, database time,
 * and row locks.
 */

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { TenantID } from '../../types';
import { TaskStatus } from '../../types';
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
  GatewayChannelRepository,
  GatewayInboundEventRepository,
  TaskRepository,
  TeamsMessageDeliveryRepository,
} from '../repositories';
import { getPostgresSqlState } from '../sanitize-error';
import { gatewayChannels, gatewayInboundEvents, teamsMessageDeliveries } from '../schema';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from '../tenant-scope';
import { TeamsConversationAddressRepository } from './teams-conversation-addresses';
import {
  assistantMessage,
  postgresTeamsHarness,
  seedClaimedTeamsDelivery,
  seedTeamsGateway,
  TEAMS_SHARED_CASES,
  TEAMS_THREAD_ID,
  teamsAdmission,
  teamsDeliveryWriters,
} from './teams-gateway-ha.test-support';
import { ThreadSessionMapRepository } from './thread-session-map';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

function seedTeamsChannel(db: Database, tenantId: TenantID) {
  return runWithTenantDatabaseScope(db, tenantId, (scoped) => seedTeamsGateway(scoped));
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
    const { channel } = await seedTeamsChannel(dbA, tenantId);
    const first = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).admitVerifiedHttp(
        teamsAdmission(channel, 'teams:activity:pg-first')
      )
    );
    const second = await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).admitVerifiedHttp(
        teamsAdmission(channel, 'teams:activity:pg-second')
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
      {
        tenant_id: tenantId,
        gateway_channel_id: channel.id,
        thread_id: TEAMS_THREAD_ID,
        event_id: first.event.id,
      },
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
  });

  it('keeps the Teams catch-up cursor monotonic across replicas', async () => {
    const tenantId = `teams-pg-${generateId()}` as TenantID;
    const { mapping } = await seedTeamsChannel(dbA, tenantId);
    expect(
      await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new ThreadSessionMapRepository(scoped).advanceTeamsLastAdmittedActivityId(
          mapping.id,
          '1700000002000'
        )
      )
    ).toBe(true);
    expect(
      await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
        new ThreadSessionMapRepository(scoped).advanceTeamsLastAdmittedActivityId(
          mapping.id,
          '1700000001000'
        )
      )
    ).toBe(false);
  });

  it('limits system-scope inbound discovery to queued Teams rows in every tenant', async () => {
    const tenantA = `teams-pg-rls-a-${generateId()}` as TenantID;
    const tenantB = `teams-pg-rls-b-${generateId()}` as TenantID;
    const teamsA = await seedTeamsChannel(dbA, tenantA);
    const teamsB = await seedTeamsChannel(dbA, tenantB);
    const queued = await runWithTenantDatabaseScope(dbA, tenantA, (scoped) =>
      new GatewayInboundEventRepository(scoped).admitVerifiedHttp(
        teamsAdmission(teamsA.channel, 'teams:activity:rls-queued')
      )
    );
    const completed = await runWithTenantDatabaseScope(dbA, tenantB, async (scoped) => {
      const inbound = new GatewayInboundEventRepository(scoped);
      const admitted = await inbound.admitVerifiedHttp(
        teamsAdmission(teamsB.channel, 'teams:activity:rls-completed')
      );
      await inbound.claimQueued(admitted.event.id, 'rls-claim', 30_000);
      await inbound.complete({
        eventId: admitted.event.id,
        channelId: teamsB.channel.id,
        processingToken: 'rls-claim',
        requireListenerClaim: false,
      });
      return admitted.event;
    });
    const slack = await runWithTenantDatabaseScope(dbA, tenantB, async (scoped) => {
      const channel = await new GatewayChannelRepository(scoped).create({
        name: `Slack ${generateId()}`,
        created_by: teamsB.channel.created_by,
        target_branch_id: teamsB.channel.target_branch_id,
        channel_type: 'slack',
        enabled: true,
        config: { bot_token: 'xoxb-test', app_token: 'xapp-test' },
      });
      const claim = await new GatewayInboundEventRepository(scoped).claim({
        channelId: channel.id,
        providerEventId: `slack:event:${generateId()}`,
        threadId: 'C123-1700000000.000001',
        processingToken: 'slack-listener',
        leaseDurationMs: 30_000,
        requireListenerClaim: false,
      });
      if (claim.outcome !== 'claimed') throw new Error('expected a Slack inbound claim');
      return claim.event;
    });

    const visible = (await runWithSystemDatabaseScope(
      dbB,
      'Teams PostgreSQL discovery policy probe',
      (systemDb) =>
        select(systemDb, { id: gatewayInboundEvents.id }).from(gatewayInboundEvents).all(),
      { capability: 'teams_gateway_ingress_discovery' }
    )) as Array<{ id: string }>;
    const ids = visible.map((row) => row.id);
    expect(ids).toContain(queued.event.id);
    expect(ids).not.toContain(completed.id);
    expect(ids).not.toContain(slack.id);
  });

  it('uses PostgreSQL transaction time for skewed discovery, retries, leases, and effect fences', async () => {
    const tenantId = `teams-pg-clock-${generateId()}` as TenantID;
    const { channel, mapping } = await seedTeamsChannel(dbA, tenantId);
    const callerBehind = new Date('2000-01-01T00:00:00.000Z');
    const callerAhead = new Date('2999-01-01T00:00:00.000Z');
    const baseAdmission = teamsAdmission(channel, `teams:activity:clock-${generateId()}`);
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
    expect(storedAddress).not.toHaveProperty('expires_at');
    expect(storedAddress!.revoked_at).toBeNull();

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
        teamsAdmission(channel, `teams:activity:retry-${generateId()}`)
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

    const enqueue = (index: number) =>
      runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const { deliveries, messages } = teamsDeliveryWriters(scoped);
        const message = await messages.create(assistantMessage(mapping.session_id, index));
        return deliveries.findByMessageId(message.message_id);
      });
    const delivery = await enqueue(0);
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

    const retryDelivery = await enqueue(1);
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
  it('rejects a foreign-tenant admission capability even with its exact event token', async () => {
    const tenantA = `teams-owner-${generateId()}` as TenantID;
    const tenantB = `teams-foreign-${generateId()}` as TenantID;
    const { channel } = await seedTeamsChannel(dbA, tenantA);
    await seedTeamsChannel(dbB, tenantB);
    const claim = await runWithTenantDatabaseScope(dbA, tenantA, async (scoped) => {
      const inbound = new GatewayInboundEventRepository(scoped);
      const admitted = await inbound.admitVerifiedHttp(teamsAdmission(channel, 'foreign'));
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
    const { channel, session } = await seedTeamsChannel(dbA, tenantId);
    const claim = await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
      const inbound = new GatewayInboundEventRepository(scoped);
      const admitted = await inbound.admitVerifiedHttp(teamsAdmission(channel, 'locked'));
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
  it('holds channel and delivery locks until the effect marker transaction commits', async () => {
    const tenantId = `teams-effect-locks-${generateId()}` as TenantID;
    const { channel, claim } = await runWithTenantDatabaseScope(
      dbA,
      tenantId,
      seedClaimedTeamsDelivery
    );
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

  // Last: these leave queued rows that the exact discovery assertions above would see.
  for (const [name, run] of TEAMS_SHARED_CASES) {
    it(name, () => run(postgresTeamsHarness(dbA, dbB, 'shared')));
  }
});
