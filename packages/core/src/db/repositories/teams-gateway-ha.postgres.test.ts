/**
 * PostgreSQL HA/RLS coverage for the Teams ingress lane.
 *
 * Run with AGOR_DB_DIALECT=postgresql and AGOR_TEST_POSTGRES_URL set. The
 * SQLite repository suite covers the same transitions without a live server;
 * this file proves tenant projection, qualified tenant selection, and two
 * independent replica claims against PostgreSQL row-level security.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { BranchID, SessionID, TenantID, UUID } from '../../types';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import {
  BranchRepository,
  GatewayChannelRepository,
  GatewayInboundEventRepository,
  RepoRepository,
  SessionRepository,
  ThreadSessionMapRepository,
  UsersRepository,
} from '../repositories';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from '../tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

async function seedTeamsChannel(db: Database, tenantId: TenantID) {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
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
      provider_installation_id: 'teams-app',
      config: {
        app_id: 'teams-app',
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
    return { channel, session, mapping };
  });
}

function admission(channelId: string, tenantId: string, providerEventId: string) {
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
      verifiedAppId: 'teams-app',
      verifiedTenantId: tenantId,
      providerConfigGeneration: 1,
    },
    providerConfigGeneration: 1,
    verifiedAppId: 'teams-app',
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
    const { channel, mapping } = await seedTeamsChannel(dbA, tenantId);
    const first = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).admitVerifiedHttp(
        admission(channel.id, tenantId, 'teams:activity:pg-first')
      )
    );
    const second = await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).admitVerifiedHttp(
        admission(channel.id, tenantId, 'teams:activity:pg-second')
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
    const { channel } = await seedTeamsChannel(dbA, tenantId);
    const admitted = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
      new GatewayInboundEventRepository(scoped).admitVerifiedHttp({
        ...admission(channel.id, tenantId, 'teams:activity:pg-expired'),
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
});
