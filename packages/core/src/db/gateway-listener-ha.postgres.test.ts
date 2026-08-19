/**
 * PostgreSQL integration for shared-nothing gateway listener ownership.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/gateway-listener-ha.postgres.test.ts
 */

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { ChannelType, GatewayChannelID, TenantID } from '../types';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase, update } from './database-wrapper';
import { initializeDatabase } from './migrate';
import {
  BranchRepository,
  GatewayChannelRepository,
  GatewayInboundEventRepository,
  GatewayListenerDiscoveryRepository,
  RepoRepository,
  UsersRepository,
} from './repositories';
import { gatewayChannels, gatewayInboundEvents } from './schema';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = (Date.now() % 1_000_000) + 7_000_000;

async function seedChannel(
  db: Database,
  tenantId: TenantID,
  options: { channelType?: ChannelType; config?: Record<string, unknown>; enabled?: boolean } = {}
) {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}-${generateId()}@example.com`,
      name: 'Gateway listener HA',
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `gateway-ha-${tenantId}-${generateId()}`,
      name: `Gateway HA ${tenantId}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/gateway-ha.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `gateway-ha-${tenantId}`,
      ref: 'main',
      branch_unique_id: branchUnique++,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
    });
    const channelType = options.channelType ?? 'slack';
    const channel = await new GatewayChannelRepository(scoped).create({
      id: generateId() as GatewayChannelID,
      name: 'HA Slack',
      channel_type: channelType,
      created_by: user.user_id,
      agor_user_id: user.user_id,
      target_branch_id: branch.branch_id,
      channel_key: generateId(),
      enabled: options.enabled ?? true,
      config:
        options.config ??
        (channelType === 'slack' ? { bot_token: 'xoxb-test', app_token: 'xapp-test' } : {}),
    });
    return { channel, user, branch };
  });
}

async function expireChannelLease(db: Database, channelId: GatewayChannelID): Promise<void> {
  await update(db, gatewayChannels)
    .set({ listener_lease_expires_at: sql`CURRENT_TIMESTAMP - INTERVAL '1 second'` })
    .where(eq(gatewayChannels.id, channelId))
    .run();
}

async function expireInboundProcessing(db: Database, eventId: string): Promise<void> {
  await update(db, gatewayInboundEvents)
    .set({ processing_expires_at: sql`CURRENT_TIMESTAMP - INTERVAL '1 second'` })
    .where(eq(gatewayInboundEvents.id, eventId))
    .run();
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)('gateway listener HA (PostgreSQL)', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
  });

  afterAll(async () => {
    await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  it('elects one of five daemons, takes over, and fences stale renew/checkpoint/release', async () => {
    const tenantId = `gateway-five-${generateId()}` as TenantID;
    const { channel } = await seedChannel(db, tenantId);

    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        runWithTenantDatabaseScope(db, tenantId, (scoped) =>
          new GatewayChannelRepository(scoped).claimListener({
            channelId: channel.id,
            claimToken: `token-${index}`,
            leaseDurationMs: 30_000,
            instanceId: `daemon-${index}`,
            bootId: `boot-${index}`,
          })
        )
      )
    );
    const winner = attempts.find((attempt) => attempt.outcome === 'claimed');
    expect(attempts.filter((attempt) => attempt.outcome === 'claimed')).toHaveLength(1);
    if (winner?.outcome !== 'claimed') throw new Error('No listener winner');

    const claimableWhileHeld = await runWithSystemDatabaseScope(
      db,
      'gateway listener held-candidate test',
      (systemDb) =>
        new GatewayListenerDiscoveryRepository(systemDb).findEnabledTenantRefs({ limit: 1_000 }),
      { capability: 'gateway_listener_discovery' }
    );
    expect(claimableWhileHeld.some((ref) => ref.channel_id === channel.id)).toBe(false);

    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const channels = new GatewayChannelRepository(scoped);
      const renewed = await channels.renewListener(channel.id, winner.lease.claim_token, 30_000);
      expect(renewed).not.toBeNull();
      expect(new Date(renewed!.lease_expires_at).getTime()).toBeGreaterThan(
        new Date(renewed!.claimed_at).getTime()
      );
      expect(
        await channels.claimListener({
          channelId: channel.id,
          claimToken: 'too-early',
          leaseDurationMs: 30_000,
          instanceId: 'daemon-new',
          bootId: 'boot-new',
        })
      ).toMatchObject({ outcome: 'held' });

      await expireChannelLease(scoped, channel.id);
      const takeover = await channels.claimListener({
        channelId: channel.id,
        claimToken: 'takeover',
        leaseDurationMs: 300_000,
        instanceId: 'daemon-new',
        bootId: 'boot-new',
      });
      expect(takeover).toMatchObject({ outcome: 'claimed' });
      expect(await channels.renewListener(channel.id, winner.lease.claim_token, 30_000)).toBeNull();
      expect(
        await channels.saveListenerCheckpoint(channel.id, winner.lease.claim_token, {
          cursor: 'stale',
        })
      ).toBe(false);
      expect(await channels.releaseListener(channel.id, winner.lease.claim_token)).toBe(false);
    });
  });

  it('enforces provider installation identity globally without disclosing the other tenant', async () => {
    const tenantA = `gateway-provider-a-${generateId()}` as TenantID;
    const tenantB = `gateway-provider-b-${generateId()}` as TenantID;
    const providerInstallationId = String(BigInt(Date.now()) * 1_000_000n + 123_456n);
    const config = {
      bot_token: `discord-token-${generateId()}`,
      application_id: providerInstallationId,
    };
    const [{ channel: channelA }, { channel: channelB }] = await Promise.all([
      seedChannel(db, tenantA, { channelType: 'discord', config, enabled: false }),
      seedChannel(db, tenantB, { channelType: 'discord', config, enabled: false }),
    ]);
    const claim = (tenantId: TenantID, channelId: GatewayChannelID) =>
      runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new GatewayChannelRepository(scoped).claimProviderInstallationIdentity({
          channelId,
          channelType: 'discord',
          providerInstallationId,
          expectedConfig: config,
        })
      );

    await expect(claim(tenantA, channelA.id)).resolves.toBe(true);
    await expect(claim(tenantB, channelB.id)).rejects.toThrow(
      'Provider installation is already connected'
    );
  });

  it('keeps bounded Discord alignment-user validation inside the tenant RLS scope', async () => {
    const tenantA = `gateway-users-a-${generateId()}` as TenantID;
    const tenantB = `gateway-users-b-${generateId()}` as TenantID;
    const userA = await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
      new UsersRepository(scoped).create({
        email: `gateway-user-${generateId()}@example.com`,
        name: 'Tenant A Discord user',
      })
    );

    await expect(
      runWithTenantDatabaseScope(db, tenantA, (scoped) =>
        new UsersRepository(scoped).findExistingIds([userA.user_id])
      )
    ).resolves.toEqual(new Set([userA.user_id]));
    await expect(
      runWithTenantDatabaseScope(db, tenantB, (scoped) =>
        new UsersRepository(scoped).findExistingIds([userA.user_id])
      )
    ).resolves.toEqual(new Set());
  });

  it('serializes disabled Discord probes and fences config mutation and cross-tenant access', async () => {
    const tenantId = `gateway-probe-${generateId()}` as TenantID;
    const otherTenant = `gateway-probe-other-${generateId()}` as TenantID;
    const applicationId = String(BigInt(Date.now()) * 1_000_000n + 654_321n);
    const config = {
      bot_token: `discord-token-${generateId()}`,
      application_id: applicationId,
    };
    const { channel } = await seedChannel(db, tenantId, {
      channelType: 'discord',
      config,
      enabled: false,
    });
    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        runWithTenantDatabaseScope(db, tenantId, (scoped) =>
          new GatewayChannelRepository(scoped).claimProviderProbe({
            channelId: channel.id,
            claimToken: `probe-${index}`,
            leaseDurationMs: 30_000,
          })
        )
      )
    );
    const winner = attempts.find((attempt) => attempt.outcome === 'claimed');
    expect(attempts.filter((attempt) => attempt.outcome === 'claimed')).toHaveLength(1);
    if (winner?.outcome !== 'claimed') throw new Error('No provider probe winner');

    await runWithTenantDatabaseScope(db, otherTenant, async (scoped) => {
      const channels = new GatewayChannelRepository(scoped);
      expect(
        await channels.providerProbeClaimIsCurrent(
          channel.id,
          winner.lease.claim_token,
          winner.lease.generation,
          winner.lease.provider_config_generation
        )
      ).toBe(false);
      await expect(
        channels.renewProviderProbe({
          channelId: channel.id,
          claimToken: winner.lease.claim_token,
          generation: winner.lease.generation,
          providerConfigGeneration: winner.lease.provider_config_generation,
          leaseDurationMs: 30_000,
        })
      ).resolves.toBeNull();
      expect(
        await channels.releaseProviderProbe(
          channel.id,
          winner.lease.claim_token,
          winner.lease.generation
        )
      ).toBe(false);
    });

    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const channels = new GatewayChannelRepository(scoped);
      expect(
        await channels.providerProbeClaimIsCurrent(
          channel.id,
          winner.lease.claim_token,
          winner.lease.generation,
          winner.lease.provider_config_generation
        )
      ).toBe(true);
      const renewed = await channels.renewProviderProbe({
        channelId: channel.id,
        claimToken: winner.lease.claim_token,
        generation: winner.lease.generation,
        providerConfigGeneration: winner.lease.provider_config_generation,
        leaseDurationMs: 30_000,
      });
      expect(renewed).toMatchObject({
        claim_token: winner.lease.claim_token,
        generation: winner.lease.generation,
        provider_config_generation: winner.lease.provider_config_generation,
      });
      await expect(
        channels.claimProviderProbe({
          channelId: channel.id,
          claimToken: 'second-daemon-while-renewed',
          leaseDurationMs: 30_000,
        })
      ).resolves.toMatchObject({ outcome: 'held' });
      await expect(channels.update(channel.id, { enabled: true })).rejects.toThrow(
        'Discord connection test is in progress'
      );
      expect(
        await channels.providerProbeClaimIsCurrent(
          channel.id,
          winner.lease.claim_token,
          winner.lease.generation,
          winner.lease.provider_config_generation
        )
      ).toBe(true);
      const changed = await channels.update(channel.id, {
        config: { bot_token: `${config.bot_token}-rotated` },
      });
      expect(changed.provider_config_generation).toBe(winner.lease.provider_config_generation + 1);
      expect(
        await channels.providerProbeClaimIsCurrent(
          channel.id,
          winner.lease.claim_token,
          winner.lease.generation,
          winner.lease.provider_config_generation
        )
      ).toBe(false);
      await expect(
        channels.claimProviderProbe({
          channelId: channel.id,
          claimToken: 'probe-overlap-after-config-change',
          leaseDurationMs: 30_000,
        })
      ).resolves.toMatchObject({ outcome: 'held' });
      expect(
        await channels.releaseProviderProbe(
          channel.id,
          winner.lease.claim_token,
          winner.lease.generation
        )
      ).toBe(true);

      const retry = await channels.claimProviderProbe({
        channelId: channel.id,
        claimToken: 'probe-retry',
        leaseDurationMs: 30_000,
      });
      expect(retry.outcome).toBe('claimed');
      if (retry.outcome !== 'claimed') throw new Error('No retry probe winner');
      await expect(
        channels.claimProviderInstallationIdentity({
          channelId: channel.id,
          channelType: 'discord',
          providerInstallationId: applicationId,
          expectedConfig: {
            application_id: applicationId,
            bot_token: `${config.bot_token}-rotated`,
          },
          expectedConfigGeneration: retry.lease.provider_config_generation,
          providerProbe: {
            claimToken: retry.lease.claim_token,
            generation: retry.lease.generation,
          },
          retainProviderProbeLeaseMs: 30_000,
        })
      ).resolves.toBe(true);
      const retainedGeneration = retry.lease.provider_config_generation + 1;
      expect(
        await channels.providerProbeClaimIsCurrent(
          channel.id,
          retry.lease.claim_token,
          retry.lease.generation,
          retry.lease.provider_config_generation
        )
      ).toBe(false);
      expect(
        await channels.providerProbeClaimIsCurrent(
          channel.id,
          retry.lease.claim_token,
          retry.lease.generation,
          retainedGeneration
        )
      ).toBe(true);
      await expect(
        channels.claimProviderProbe({
          channelId: channel.id,
          claimToken: 'probe-after-installation-bind',
          leaseDurationMs: 30_000,
        })
      ).resolves.toMatchObject({ outcome: 'held' });
    });
  });

  it('deduplicates provider events, reclaims expiry, and rejects stale completion', async () => {
    const tenantId = `gateway-event-${generateId()}` as TenantID;
    const { channel } = await seedChannel(db, tenantId);

    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const channels = new GatewayChannelRepository(scoped);
      const events = new GatewayInboundEventRepository(scoped);
      await channels.claimListener({
        channelId: channel.id,
        claimToken: 'old-owner',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-old',
        bootId: 'boot-old',
      });
      const first = await events.claim({
        channelId: channel.id,
        providerEventId: 'slack:event:Ev-1',
        threadId: 'C1-1.0',
        processingToken: 'old-owner',
        leaseDurationMs: 120_000,
        requireListenerClaim: true,
      });
      expect(first.outcome).toBe('claimed');
      if (first.outcome !== 'claimed') throw new Error('Event was not claimed');
      expect(
        await events.recordDeliveryMetadata({
          eventId: first.event.id,
          channelId: channel.id,
          processingToken: 'old-owner',
          metadata: { processing_comment_id: 42 },
          requireListenerClaim: true,
        })
      ).toBe(true);
      const sameOwnerRetry = await events.claim({
        channelId: channel.id,
        providerEventId: 'slack:event:Ev-1',
        threadId: 'C1-1.0',
        processingToken: 'old-owner',
        leaseDurationMs: 120_000,
        requireListenerClaim: true,
      });
      expect(sameOwnerRetry.outcome).toBe('claimed');
      if (sameOwnerRetry.outcome === 'claimed') {
        expect(sameOwnerRetry.event.delivery_metadata).toEqual({ processing_comment_id: 42 });
      }

      await expireChannelLease(scoped, channel.id);
      await channels.claimListener({
        channelId: channel.id,
        claimToken: 'new-owner',
        leaseDurationMs: 300_000,
        instanceId: 'daemon-new',
        bootId: 'boot-new',
      });
      expect(
        await events.complete({
          eventId: first.event.id,
          channelId: channel.id,
          processingToken: 'old-owner',
          requireListenerClaim: true,
        })
      ).toBe(false);

      expect(
        await events.claim({
          channelId: channel.id,
          providerEventId: 'slack:event:Ev-1',
          threadId: 'C1-1.0',
          processingToken: 'new-owner',
          leaseDurationMs: 120_000,
          requireListenerClaim: true,
        })
      ).toMatchObject({ outcome: 'in_progress_elsewhere' });

      await expireInboundProcessing(scoped, first.event.id);
      const reclaimed = await events.claim({
        channelId: channel.id,
        providerEventId: 'slack:event:Ev-1',
        threadId: 'C1-1.0',
        processingToken: 'new-owner',
        leaseDurationMs: 120_000,
        requireListenerClaim: true,
      });
      expect(reclaimed.outcome).toBe('claimed');
      if (reclaimed.outcome !== 'claimed') throw new Error('Event was not reclaimed');
      expect(reclaimed.event.delivery_metadata).toEqual({ processing_comment_id: 42 });
      expect(
        await events.complete({
          eventId: reclaimed.event.id,
          channelId: channel.id,
          processingToken: 'new-owner',
          requireListenerClaim: true,
        })
      ).toBe(true);
      expect(
        await events.claim({
          channelId: channel.id,
          providerEventId: 'slack:event:Ev-1',
          threadId: 'C1-1.0',
          processingToken: 'new-owner',
          leaseDurationMs: 120_000,
          requireListenerClaim: true,
        })
      ).toMatchObject({ outcome: 'completed_duplicate' });
    });
  });

  it('keeps discovery, claims, and event identities tenant-scoped', async () => {
    const tenantA = `gateway-a-${generateId()}` as TenantID;
    const tenantB = `gateway-b-${generateId()}` as TenantID;
    const a = await seedChannel(db, tenantA);
    await seedChannel(db, tenantB);
    const unsupported = await seedChannel(db, tenantA, {
      channelType: 'teams',
      config: { app_id: 'teams-app', app_password: 'teams-secret' },
    });
    const discordApplicationId = String(BigInt(Date.now()) * 1_000_000n + 777_777n);
    const discordConfig = {
      bot_token: `discord-token-${generateId()}`,
      application_id: discordApplicationId,
      guild_id: String(BigInt(discordApplicationId) + 1n),
      allowed_channel_ids: [String(BigInt(discordApplicationId) + 2n)],
      align_discord_users: false,
    };
    const discord = await seedChannel(db, tenantA, {
      channelType: 'discord',
      config: discordConfig,
      enabled: false,
    });
    await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      const channels = new GatewayChannelRepository(scoped);
      expect(
        await channels.claimProviderInstallationIdentity({
          channelId: discord.channel.id,
          channelType: 'discord',
          providerInstallationId: discordApplicationId,
          expectedConfig: discordConfig,
        })
      ).toBe(true);
      await channels.update(discord.channel.id, { enabled: true });
    });

    const refs = await runWithSystemDatabaseScope(
      db,
      'gateway listener test discovery',
      (systemDb) =>
        new GatewayListenerDiscoveryRepository(systemDb).findEnabledTenantRefs({ limit: 1_000 }),
      { capability: 'gateway_listener_discovery' }
    );
    expect(refs).toContainEqual({ channel_id: a.channel.id, tenant_id: tenantA });
    expect(refs).toContainEqual({ channel_id: discord.channel.id, tenant_id: tenantA });
    expect(refs.some((ref) => ref.channel_id === unsupported.channel.id)).toBe(false);

    await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      const candidates = await new GatewayChannelRepository(scoped).findEnabledListenerCandidates(
        100
      );
      expect(candidates.some((channel) => channel.id === a.channel.id)).toBe(true);
      expect(candidates.some((channel) => channel.id === discord.channel.id)).toBe(true);
      expect(candidates.some((channel) => channel.id === unsupported.channel.id)).toBe(false);

      await new GatewayChannelRepository(scoped).claimListener({
        channelId: a.channel.id,
        claimToken: 'tenant-a-owner',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-a',
        bootId: 'boot-a',
      });
      expect(
        await new GatewayInboundEventRepository(scoped).claim({
          channelId: a.channel.id,
          providerEventId: 'slack:event:tenant-a',
          threadId: 'C-A-1.0',
          processingToken: 'tenant-a-owner',
          leaseDurationMs: 120_000,
          requireListenerClaim: true,
        })
      ).toMatchObject({ outcome: 'claimed' });
    });

    await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
      expect(await new GatewayChannelRepository(scoped).findById(a.channel.id)).toBeNull();
      expect(
        await new GatewayChannelRepository(scoped).claimListener({
          channelId: a.channel.id,
          claimToken: 'forged-cross-tenant',
          leaseDurationMs: 30_000,
          instanceId: 'daemon-b',
          bootId: 'boot-b',
        })
      ).toMatchObject({ outcome: 'unavailable' });
      expect(
        await new GatewayInboundEventRepository(scoped).findByProviderEvent(
          a.channel.id,
          'slack:event:tenant-a'
        )
      ).toBeNull();
    });
  });

  it('revokes ownership on disable or credential/config rotation', async () => {
    const tenantId = `gateway-rotate-${generateId()}` as TenantID;
    const { channel } = await seedChannel(db, tenantId);
    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const channels = new GatewayChannelRepository(scoped);
      await channels.claimListener({
        channelId: channel.id,
        claimToken: 'rotated-owner',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-a',
        bootId: 'boot-a',
      });
      expect(
        await channels.saveListenerCheckpoint(channel.id, 'rotated-owner', {
          cursor: 'old-credential-scope',
        })
      ).toBe(true);
      await channels.update(channel.id, {
        config: { bot_token: 'xoxb-rotated', app_token: 'xapp-rotated' },
      });
      expect(await channels.listenerClaimIsCurrent(channel.id, 'rotated-owner')).toBe(false);

      const replacement = await channels.claimListener({
        channelId: channel.id,
        claimToken: 'replacement',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-b',
        bootId: 'boot-b',
      });
      expect(replacement.outcome).toBe('claimed');
      if (replacement.outcome === 'claimed') expect(replacement.lease.checkpoint).toBeNull();
      await channels.update(channel.id, { enabled: false });
      expect(await channels.listenerClaimIsCurrent(channel.id, 'replacement')).toBe(false);
      await channels.delete(channel.id);
      expect(await channels.findById(channel.id)).toBeNull();
      expect(await channels.listenerClaimIsCurrent(channel.id, 'replacement')).toBe(false);
    });
  });
});
