/**
 * PostgreSQL/RLS coverage for Teams final-delivery claims: tenant-bound claims,
 * database-clock ambiguity for a lapsed chunk marker, and tenant-bound address
 * revocation. Task-addressed routing runs in the shared Teams gateway cases.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { TenantID } from '../../types';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import {
  TeamsConversationAddressRepository,
  TeamsMessageDeliveryRepository,
} from '../repositories';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from '../tenant-scope';
import {
  assistantMessage,
  seedTeamsGateway,
  TEAMS_MICROSOFT_TENANT,
  TEAMS_THREAD_ID,
  teamsDeliveryWriters,
} from './teams-gateway-ha.test-support';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

function seed(db: Database, tenantId: TenantID) {
  return runWithTenantDatabaseScope(db, tenantId, (scoped) => seedTeamsGateway(scoped));
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)('Teams message deliveries PostgreSQL', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
  });

  afterAll(async () => {
    await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  it('keeps claims tenant-bound and makes a lapsed chunk marker ambiguous on database time', async () => {
    const tenantA = `teams-claim-a-${generateId()}` as TenantID;
    const tenantB = `teams-claim-b-${generateId()}` as TenantID;
    const { session } = await seed(db, tenantA);
    await seed(db, tenantB);
    const deliveryId = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      const { deliveries, messages } = teamsDeliveryWriters(scoped);
      const message = await messages.create(assistantMessage(session.session_id));
      return (await deliveries.findByMessageId(message.message_id))!.delivery_id;
    });

    const due = await runWithSystemDatabaseScope(
      db,
      'Teams delivery PostgreSQL discovery',
      (systemDb) => new TeamsMessageDeliveryRepository(systemDb).findDueRefs(systemDb),
      { capability: 'teams_message_delivery_discovery' }
    );
    expect(due).toContainEqual(
      expect.objectContaining({ tenant_id: tenantA, delivery_id: deliveryId })
    );

    expect(
      await runWithTenantDatabaseScope(db, tenantB, (scoped) =>
        new TeamsMessageDeliveryRepository(scoped).claim(deliveryId, 'foreign', 30_000)
      )
    ).toBeNull();

    const claim = await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
      new TeamsMessageDeliveryRepository(scoped).claim(deliveryId, 'owner', 1_500)
    );
    if (!claim) throw new Error('missing owner claim');
    await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
      new TeamsMessageDeliveryRepository(scoped).markEffectStarted({
        deliveryId,
        claimToken: claim.claim_token,
        claimGeneration: claim.claim_generation,
        chunkIndex: 0,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    // A caller clock far in the past must not keep the lapsed lease alive.
    expect(
      await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
        new TeamsMessageDeliveryRepository(scoped).claim(
          deliveryId,
          'successor',
          30_000,
          new Date('2000-01-01T00:00:00.000Z')
        )
      )
    ).toBeNull();
    expect(
      await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
        new TeamsMessageDeliveryRepository(scoped).findById(deliveryId)
      )
    ).toMatchObject({ status: 'ambiguous', ambiguous_chunk_index: 0 });
  });

  it('does not let another tenant revoke an address by channel id', async () => {
    const previousSecret = process.env.AGOR_MASTER_SECRET;
    process.env.AGOR_MASTER_SECRET = 'teams-address-pg-secret';
    try {
      const tenantA = `teams-revoke-a-${generateId()}` as TenantID;
      const tenantB = `teams-revoke-b-${generateId()}` as TenantID;
      const { channel } = await seed(db, tenantA);
      await seed(db, tenantB);
      await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
        new TeamsConversationAddressRepository(scoped).refresh({
          gatewayChannelId: channel.id,
          threadId: TEAMS_THREAD_ID,
          conversationId: TEAMS_THREAD_ID,
          rootMessageId: null,
          address: { serviceUrl: 'https://smba.trafficmanager.net/amer/' },
          verifiedAppId: channel.provider_installation_id!,
          verifiedTenantId: TEAMS_MICROSOFT_TENANT,
          providerConfigGeneration: channel.provider_config_generation,
        })
      );
      expect(
        await runWithTenantDatabaseScope(db, tenantB, (scoped) =>
          new TeamsConversationAddressRepository(scoped).revokeConversations(channel.id, [
            TEAMS_THREAD_ID,
          ])
        )
      ).toBe(0);
      expect(
        await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
          new TeamsConversationAddressRepository(scoped).loadFenced({
            channel,
            threadId: TEAMS_THREAD_ID,
          })
        )
      ).toMatchObject({ ok: true });
    } finally {
      if (previousSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = previousSecret;
    }
  });
});
