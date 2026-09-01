/**
 * Real PostgreSQL proof for the Discord final-delivery repository and worker.
 *
 * Provider calls are an injected in-memory connector. Claims, leases, RLS,
 * tenant discovery, and all durable state transitions use the disposable
 * PostgreSQL database supplied by scripts/test-postgres-docker.sh.
 */

import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  DiscordMessageDeliveryClaimLostError,
  DiscordMessageDeliveryRepository,
  deleteTenantData,
  discordMessageDeliveries,
  eq,
  executeRaw,
  GatewayChannelRepository,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  MessagesRepository,
  RepoRepository,
  runDatabaseTransaction,
  runWithoutTenantDatabaseScope,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  SessionRepository,
  sql,
  ThreadSessionMapRepository,
  tenantPortabilityForeignKeys,
  UsersRepository,
  update,
} from '@agor/core/db';
import { DISCORD_METADATA_KEY, type GatewayConnector } from '@agor/core/gateway';
import {
  DEFAULT_DISCORD_CATCH_UP,
  type DiscordMessageDeliveryID,
  type Message,
  MessageRole,
  SessionStatus,
  type TenantID,
} from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DiscordMessageDeliveryWorker,
  deterministicDiscordDeliveryNonce,
} from './discord-message-delivery-worker.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

let branchUnique = (Date.now() % 1_000_000) + 12_000_000;
let snowflakeCounter = 0n;

function discordSnowflake(): string {
  return (100_000_000_000_000_000n + snowflakeCounter++).toString();
}

const discordConfig = (
  applicationId: string,
  guildId: string,
  channelId: string,
  userId: string
) => ({
  bot_token: 'discord-test-token',
  application_id: applicationId,
  guild_id: guildId,
  allowed_channel_ids: [channelId],
  allowed_user_ids: [userId],
  allowed_role_ids: [],
  message_content_enabled: true,
  thread_mode: 'public_thread_per_summon' as const,
  align_discord_users: false,
  catch_up: { ...DEFAULT_DISCORD_CATCH_UP },
  files: false as const,
  agent_tools: [] as never[],
});

async function seedDelivery(db: Database, tenantId: TenantID, text = 'A durable Discord reply') {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const users = new UsersRepository(scoped);
    const repos = new RepoRepository(scoped);
    const branches = new BranchRepository(scoped);
    const sessions = new SessionRepository(scoped);
    const channels = new GatewayChannelRepository(scoped);
    const mappings = new ThreadSessionMapRepository(scoped);

    const user = await users.create({
      user_id: generateId(),
      email: `${tenantId}-${generateId()}@example.com`,
      name: 'Discord delivery PostgreSQL test',
      role: 'admin',
    });
    const repo = await repos.create({
      repo_id: generateId(),
      slug: `discord-delivery-${generateId()}`,
      name: 'Discord delivery PostgreSQL test',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/discord-delivery.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await branches.create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `discord-delivery-${generateId()}`,
      ref: 'main',
      branch_unique_id: branchUnique++,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
    });
    const session = await sessions.create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      created_by: user.user_id,
      status: SessionStatus.IDLE,
      title: 'Discord delivery PostgreSQL test',
      tasks: [],
    });

    const applicationId = discordSnowflake();
    const guildId = discordSnowflake();
    const platformChannelId = discordSnowflake();
    const platformUserId = discordSnowflake();
    const draft = await channels.create({
      id: generateId(),
      name: 'Discord delivery PostgreSQL test',
      channel_type: 'discord',
      channel_key: `discord-delivery-${generateId()}`,
      enabled: false,
      target_branch_id: branch.branch_id,
      agor_user_id: user.user_id,
      created_by: user.user_id,
      config: discordConfig(applicationId, guildId, platformChannelId, platformUserId),
    });
    const channel = await channels.updateWithVerifiedDiscordInstallation(
      draft.id,
      { enabled: true, agor_user_id: user.user_id },
      applicationId,
      draft.provider_config_generation
    );
    const mapping = await mappings.create({
      channel_id: channel.id,
      thread_id: `discord:message:${platformChannelId}:${discordSnowflake()}`,
      session_id: session.session_id,
      branch_id: branch.branch_id,
      metadata: {},
    });

    const deliveries = new DiscordMessageDeliveryRepository(scoped);
    const messages = new MessagesRepository(scoped, (tx, message) =>
      deliveries.enqueueForMessageInTransaction(tx, message).then(() => undefined)
    );
    const message = await messages.create({
      message_id: generateId(),
      session_id: session.session_id,
      type: 'assistant',
      role: MessageRole.ASSISTANT,
      index: 0,
      timestamp: new Date().toISOString(),
      content_preview: text.slice(0, 200),
      content: text,
    });
    const delivery = await deliveries.findByMessageId(message.message_id);
    if (!delivery) throw new Error('PostgreSQL delivery fixture was not enqueued');
    return { channel, delivery, mapping, message, tenantId };
  });
}

async function seedAdditionalDelivery(
  db: Database,
  fixture: Awaited<ReturnType<typeof seedDelivery>>,
  text: string
) {
  return runWithTenantDatabaseScope(db, fixture.tenantId, async (scoped) => {
    const deliveries = new DiscordMessageDeliveryRepository(scoped);
    const messages = new MessagesRepository(scoped, (tx, message) =>
      deliveries.enqueueForMessageInTransaction(tx, message).then(() => undefined)
    );
    const message = await messages.create({
      message_id: generateId(),
      session_id: fixture.message.session_id,
      type: 'assistant',
      role: MessageRole.ASSISTANT,
      index: fixture.message.index + 1,
      timestamp: new Date().toISOString(),
      content_preview: text,
      content: text,
    });
    const delivery = await deliveries.findByMessageId(message.message_id);
    if (!delivery) throw new Error('PostgreSQL additional delivery was not enqueued');
    return { message, delivery };
  });
}

interface FakeProviderState {
  effects: Array<{ nonce: string; text: string }>;
  receipts: Map<string, { messageId: string; replyAliases: string[]; createdAt: number }>;
  recoveryNow?: number;
  newerMessagesBeforeReceipt?: number;
}

function fakeProvider(
  state: FakeProviderState,
  beforeRecovery?: () => Promise<void>
): GatewayConnector {
  return {
    channelType: 'discord',
    recoverMessageByNonce: async ({ nonce }) => {
      if (beforeRecovery) await beforeRecovery();
      const receipt = state.receipts.get(nonce);
      if (!receipt) return null;
      const now = state.recoveryNow ?? Date.now();
      if (now - receipt.createdAt < -60_000 || now - receipt.createdAt > 5 * 60_000) return null;
      if ((state.newerMessagesBeforeReceipt ?? 0) > 100) return null;
      return receipt;
    },
    sendMessage: async ({ text, metadata }) => {
      const nonce = String(metadata?.[DISCORD_METADATA_KEY.deliveryNonce]);
      const receipt = {
        messageId: `provider-${state.effects.length + 1}`,
        replyAliases: [],
        createdAt: state.recoveryNow ?? Date.now(),
      };
      state.effects.push({ nonce, text });
      state.receipts.set(nonce, receipt);
      return receipt;
    },
  };
}

function worker(
  db: Database,
  tenantId: TenantID,
  provider: GatewayConnector,
  now: () => Date,
  options: {
    discover?: (limit: number) => Promise<
      Array<{
        tenant_id: string;
        delivery_id: DiscordMessageDeliveryID;
        thread_session_map_id: string;
      }>
    >;
  } = {}
) {
  return new DiscordMessageDeliveryWorker(
    createTenantScopedDatabaseProxy(db, {
      requireScope: true,
      label: 'Discord delivery PostgreSQL test',
    }),
    {
      tenantId,
      connectorFactory: () => provider,
      leaseDurationMs: 30_000,
      now,
      ...(options.discover ? { discover: options.discover } : {}),
    }
  );
}

async function withDeliveryRepo<T>(
  db: Database,
  tenantId: TenantID,
  work: (repo: DiscordMessageDeliveryRepository, scoped: Database) => Promise<T>
): Promise<T> {
  return runWithTenantDatabaseScope(db, tenantId, (scoped) =>
    work(new DiscordMessageDeliveryRepository(scoped), scoped)
  );
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Discord message delivery worker (PostgreSQL)',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    });

    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('lets two tenant-scoped workers contend while exactly one provider effect wins', async () => {
      const tenantId = `delivery-contend-${generateId()}` as TenantID;
      const { delivery } = await seedDelivery(db, tenantId);
      const state: FakeProviderState = { effects: [], receipts: new Map() };
      const now = () => new Date(Date.now() + 60_000);

      await Promise.all([
        worker(db, tenantId, fakeProvider(state), now).checkOnce(),
        worker(db, tenantId, fakeProvider(state), now).checkOnce(),
      ]);

      expect(state.effects).toHaveLength(1);
      const completed = await withDeliveryRepo(db, tenantId, (repo) =>
        repo.findById(delivery.delivery_id)
      );
      expect(completed).toMatchObject({
        status: 'completed',
        chunk_receipts: [{ chunk_index: 0 }],
      });
    }, 30_000);

    it('serializes competing workers on one mapping and never lets a newer delivery overtake', async () => {
      const tenantId = `delivery-order-${generateId()}` as TenantID;
      const first = await seedDelivery(db, tenantId, 'first Discord reply');
      const second = await seedAdditionalDelivery(db, first, 'second Discord reply');
      const state: FakeProviderState = { effects: [], receipts: new Map() };
      const now = () => new Date(Date.now() + 60_000);

      await Promise.all([
        worker(db, tenantId, fakeProvider(state), now).checkOnce(),
        worker(db, tenantId, fakeProvider(state), now).checkOnce(),
      ]);
      expect(state.effects.map((effect) => effect.text)).toEqual(['first Discord reply']);
      await expect(
        withDeliveryRepo(db, tenantId, (repo) => repo.findById(second.delivery.delivery_id))
      ).resolves.toMatchObject({ status: 'pending' });

      await worker(db, tenantId, fakeProvider(state), now).checkOnce();
      expect(state.effects.map((effect) => effect.text)).toEqual([
        'first Discord reply',
        'second Discord reply',
      ]);
    }, 30_000);

    it('blocks a due successor behind a durable retry-wait predecessor', async () => {
      const tenantId = `delivery-retry-order-${generateId()}` as TenantID;
      const first = await seedDelivery(db, tenantId, 'retrying Discord reply');
      const second = await seedAdditionalDelivery(db, first, 'overtaking Discord reply');
      const now = new Date(Date.now() + 60_000);
      const retryAt = new Date(now.getTime() + 60_000);

      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        await update(scoped, discordMessageDeliveries)
          .set({ next_attempt_at: retryAt, updated_at: now })
          .where(eq(discordMessageDeliveries.delivery_id, first.delivery.delivery_id))
          .run();
        const repo = new DiscordMessageDeliveryRepository(scoped);
        await expect(
          repo.claim(second.delivery.delivery_id, 'successor', 30_000, now)
        ).resolves.toBeNull();
      });

      const refs = await runWithSystemDatabaseScope(
        db,
        'Discord retry-wait ordering proof',
        (systemDb) =>
          new DiscordMessageDeliveryRepository(systemDb).findDueRefs(systemDb, { limit: 10, now }),
        { capability: 'discord_message_delivery_discovery' }
      );
      expect(refs).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ delivery_id: second.delivery.delivery_id }),
        ])
      );
      await expect(
        withDeliveryRepo(db, tenantId, (repo) =>
          repo.claim(first.delivery.delivery_id, 'predecessor', 30_000, retryAt)
        )
      ).resolves.not.toBeNull();
    }, 30_000);

    it('applies tenant fairness before the discovery limit on saturated backlogs', async () => {
      const tenantA = `delivery-fair-a-${generateId()}` as TenantID;
      const tenantB = `delivery-fair-b-${generateId()}` as TenantID;
      await seedDelivery(db, tenantA, 'tenant A reply 1');
      await seedDelivery(db, tenantA, 'tenant A reply 2');
      await seedDelivery(db, tenantA, 'tenant A reply 3');
      const tenantBDelivery = await seedDelivery(db, tenantB, 'tenant B reply');
      const refs = await runWithSystemDatabaseScope(
        db,
        'Discord tenant fairness proof',
        (systemDb) =>
          new DiscordMessageDeliveryRepository(systemDb).findDueRefs(systemDb, {
            limit: 2,
            now: new Date(Date.now() + 60_000),
          }),
        { capability: 'discord_message_delivery_discovery' }
      );
      expect(refs).toHaveLength(2);
      expect(new Set(refs.map((ref) => ref.tenant_id))).toEqual(new Set([tenantA, tenantB]));
      expect(refs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tenant_id: tenantB,
            delivery_id: tenantBDelivery.delivery.delivery_id,
          }),
        ])
      );
    }, 30_000);

    it('takes over an expired lease and rejects stale checkpoint and completion', async () => {
      const tenantId = `delivery-lease-${generateId()}` as TenantID;
      const { delivery } = await seedDelivery(db, tenantId);
      const firstNow = new Date(Date.now() + 60_000);
      const first = await withDeliveryRepo(db, tenantId, (repo) =>
        repo.claim(delivery.delivery_id, 'stale-owner', 1_000, firstNow)
      );
      expect(first).not.toBeNull();
      const held = await withDeliveryRepo(db, tenantId, (repo) =>
        repo.claim(delivery.delivery_id, 'still-held', 1_000, firstNow)
      );
      expect(held).toBeNull();

      const takeoverNow = new Date(firstNow.getTime() + 1_001);
      const takeover = await withDeliveryRepo(db, tenantId, (repo) =>
        repo.claim(delivery.delivery_id, 'new-owner', 30_000, takeoverNow)
      );
      expect(takeover).not.toBeNull();
      expect(takeover?.claim_generation).toBe((first?.claim_generation ?? 0) + 1);
      if (!first || !takeover) throw new Error('Lease fixture did not produce both claims');

      await expect(
        withDeliveryRepo(db, tenantId, (repo) =>
          repo.checkpointChunk({
            deliveryId: delivery.delivery_id,
            claimToken: first.claim_token,
            claimGeneration: first.claim_generation,
            receipt: {
              chunk_index: 0,
              nonce: 'stale-nonce',
              provider_message_id: 'stale-provider-message',
              reply_aliases: [],
            },
            now: takeoverNow,
          })
        )
      ).rejects.toBeInstanceOf(DiscordMessageDeliveryClaimLostError);
      await expect(
        withDeliveryRepo(db, tenantId, (repo) =>
          repo.completeClaim({
            deliveryId: delivery.delivery_id,
            claimToken: first.claim_token,
            claimGeneration: first.claim_generation,
            now: takeoverNow,
          })
        )
      ).rejects.toBeInstanceOf(DiscordMessageDeliveryClaimLostError);
    }, 30_000);

    it('keeps known IDs, claims, checkpoints, completion, and delivery tenant-scoped', async () => {
      const tenantA = `delivery-a-${generateId()}` as TenantID;
      const tenantB = `delivery-b-${generateId()}` as TenantID;
      const a = await seedDelivery(db, tenantA);
      await seedDelivery(db, tenantB);
      const now = new Date(Date.now() + 60_000);
      const claim = await withDeliveryRepo(db, tenantA, (repo) =>
        repo.claim(a.delivery.delivery_id, 'tenant-a-owner', 30_000, now)
      );
      if (!claim) throw new Error('Tenant A fixture was not claimed');

      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        expect(
          await new DiscordMessageDeliveryRepository(scoped).findById(a.delivery.delivery_id)
        ).toBeNull();
        expect(
          await new DiscordMessageDeliveryRepository(scoped).findByMessageId(a.message.message_id)
        ).toBeNull();
        expect(await new GatewayChannelRepository(scoped).findById(a.channel.id)).toBeNull();
        expect(await new ThreadSessionMapRepository(scoped).findById(a.mapping.id)).toBeNull();
        expect(await new MessagesRepository(scoped).findById(a.message.message_id)).toBeNull();
        expect(
          await new DiscordMessageDeliveryRepository(scoped).claim(
            a.delivery.delivery_id,
            'tenant-b-owner',
            30_000,
            now
          )
        ).toBeNull();
        await expect(
          new DiscordMessageDeliveryRepository(scoped).checkpointChunk({
            deliveryId: a.delivery.delivery_id,
            claimToken: claim.claim_token,
            claimGeneration: claim.claim_generation,
            receipt: {
              chunk_index: 0,
              nonce: 'cross-tenant',
              provider_message_id: 'cross-tenant',
              reply_aliases: [],
            },
            now,
          })
        ).rejects.toBeInstanceOf(DiscordMessageDeliveryClaimLostError);
        await expect(
          new DiscordMessageDeliveryRepository(scoped).completeClaim({
            deliveryId: a.delivery.delivery_id,
            claimToken: claim.claim_token,
            claimGeneration: claim.claim_generation,
            now,
          })
        ).rejects.toBeInstanceOf(DiscordMessageDeliveryClaimLostError);
      });

      const state: FakeProviderState = { effects: [], receipts: new Map() };
      await worker(db, tenantB, fakeProvider(state), () => now, {
        discover: async () => [
          {
            tenant_id: tenantB,
            delivery_id: a.delivery.delivery_id,
            thread_session_map_id: a.delivery.thread_session_map_id,
          },
        ],
      }).checkOnce();
      expect(state.effects).toHaveLength(0);
    }, 30_000);

    it('requires explicit tenant identity for PostgreSQL delivery insertion', async () => {
      const tenantId = `delivery-explicit-tenant-${generateId()}` as TenantID;
      const fixture = await seedDelivery(db, tenantId);
      const message = {
        ...fixture.message,
        message_id: generateId(),
      } as Message;

      await expect(
        runDatabaseTransaction(db, async (tx) => {
          await executeRaw(tx, sql`SELECT set_config('agor.tenant_id', ${tenantId}, true)`);
          return runWithoutTenantDatabaseScope(() =>
            new DiscordMessageDeliveryRepository(tx).enqueueForMessageInTransaction(tx, message)
          );
        })
      ).rejects.toThrow('requires explicit tenant identity');
    }, 30_000);

    it.each([
      { name: 'disable', updates: { enabled: false }, error: 'channel_disabled_or_changed' },
      {
        name: 'generation change',
        updates: { config: { thread_auto_archive_minutes: 1440 as const } },
        error: 'config_generation_changed',
      },
    ])(
      'cancels when $name happens between recovery and provider send',
      async ({ updates, error }) => {
        const tenantId = `delivery-route-${generateId()}` as TenantID;
        const { channel, delivery } = await seedDelivery(db, tenantId);
        const state: FakeProviderState = { effects: [], receipts: new Map() };
        let changed = false;
        const provider = fakeProvider(state, async () => {
          if (changed) return;
          changed = true;
          await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
            const channels = new GatewayChannelRepository(scoped);
            if (updates.enabled === false) {
              await channels.update(channel.id, updates);
              return;
            }
            const installationId = channel.provider_installation_id;
            if (!installationId) throw new Error('Discord fixture is missing its installation ID');
            await channels.updateWithVerifiedDiscordInstallation(
              channel.id,
              updates,
              installationId,
              channel.provider_config_generation
            );
          });
        });

        await worker(db, tenantId, provider, () => new Date(Date.now() + 60_000)).checkOnce();

        expect(state.effects).toHaveLength(0);
        const canceled = await withDeliveryRepo(db, tenantId, (repo) =>
          repo.findById(delivery.delivery_id)
        );
        expect(canceled).toMatchObject({ status: 'canceled', last_error_code: error });
      },
      30_000
    );

    it('resumes after takeover from a per-chunk checkpoint without duplicating the checkpointed chunk', async () => {
      const tenantId = `delivery-chunks-${generateId()}` as TenantID;
      const { delivery } = await seedDelivery(db, tenantId, 'x'.repeat(2_100));
      const firstNow = new Date(Date.now() + 60_000);
      const first = await withDeliveryRepo(db, tenantId, (repo) =>
        repo.claim(delivery.delivery_id, 'chunk-owner-old', 1_000, firstNow)
      );
      if (!first) throw new Error('Chunk fixture was not claimed');
      await withDeliveryRepo(db, tenantId, (repo) =>
        repo.markChunkEffectStarted({
          deliveryId: delivery.delivery_id,
          claimToken: first.claim_token,
          claimGeneration: first.claim_generation,
          chunkIndex: 0,
          now: firstNow,
        })
      );
      await withDeliveryRepo(db, tenantId, (repo) =>
        repo.checkpointChunk({
          deliveryId: delivery.delivery_id,
          claimToken: first.claim_token,
          claimGeneration: first.claim_generation,
          receipt: {
            chunk_index: 0,
            nonce: deterministicDiscordDeliveryNonce(delivery.delivery_id, 0),
            provider_message_id: 'provider-existing-chunk',
            reply_aliases: [],
          },
          now: firstNow,
        })
      );

      const state: FakeProviderState = { effects: [], receipts: new Map() };
      const takeoverNow = new Date(firstNow.getTime() + 1_001);
      await worker(db, tenantId, fakeProvider(state), () => takeoverNow).checkOnce();

      expect(state.effects).toHaveLength(1);
      expect(state.effects[0].nonce).toBe(
        deterministicDiscordDeliveryNonce(delivery.delivery_id, 1)
      );
      const completed = await withDeliveryRepo(db, tenantId, (repo) =>
        repo.findById(delivery.delivery_id)
      );
      expect(completed).toMatchObject({ status: 'completed' });
      expect(completed?.chunk_receipts.map((receipt) => receipt.chunk_index)).toEqual([0, 1]);
    }, 30_000);

    it('dead-letters an expired marked chunk when nonce recovery is outside its time window', async () => {
      const tenantId = `delivery-ambiguous-expiry-${generateId()}` as TenantID;
      const { delivery } = await seedDelivery(db, tenantId);
      const markedAt = new Date(Date.now() + 60_000);
      const first = await withDeliveryRepo(db, tenantId, (repo) =>
        repo.claim(delivery.delivery_id, 'ambiguous-old-owner', 1_000, markedAt)
      );
      if (!first) throw new Error('Ambiguous expiry fixture was not claimed');
      await withDeliveryRepo(db, tenantId, (repo) =>
        repo.markChunkEffectStarted({
          deliveryId: delivery.delivery_id,
          claimToken: first.claim_token,
          claimGeneration: first.claim_generation,
          chunkIndex: 0,
          recoveryGraceMs: 1_000,
          now: markedAt,
        })
      );

      const takeoverNow = new Date(markedAt.getTime() + 1_001);
      const state: FakeProviderState = {
        effects: [],
        receipts: new Map([
          [
            deterministicDiscordDeliveryNonce(delivery.delivery_id, 0),
            {
              messageId: 'provider-too-old',
              replyAliases: [],
              createdAt: takeoverNow.getTime() - 6 * 60_000,
            },
          ],
        ]),
        recoveryNow: takeoverNow.getTime(),
      };
      await worker(db, tenantId, fakeProvider(state), () => takeoverNow).checkOnce();

      expect(state.effects).toHaveLength(0);
      await expect(
        withDeliveryRepo(db, tenantId, (repo) => repo.findById(delivery.delivery_id))
      ).resolves.toMatchObject({
        status: 'dead_letter',
        last_error_code: 'nonce_acceptance_unproven',
        ambiguous_chunk_index: 0,
      });
    }, 30_000);

    it('does not recover a marked chunk hidden behind more than 100 newer messages', async () => {
      const tenantId = `delivery-ambiguous-window-${generateId()}` as TenantID;
      const { delivery } = await seedDelivery(db, tenantId);
      const markedAt = new Date(Date.now() + 60_000);
      const first = await withDeliveryRepo(db, tenantId, (repo) =>
        repo.claim(delivery.delivery_id, 'ambiguous-window-owner', 1_000, markedAt)
      );
      if (!first) throw new Error('Ambiguous window fixture was not claimed');
      await withDeliveryRepo(db, tenantId, (repo) =>
        repo.markChunkEffectStarted({
          deliveryId: delivery.delivery_id,
          claimToken: first.claim_token,
          claimGeneration: first.claim_generation,
          chunkIndex: 0,
          recoveryGraceMs: 1_000,
          now: markedAt,
        })
      );

      const takeoverNow = new Date(markedAt.getTime() + 1_001);
      const state: FakeProviderState = {
        effects: [],
        receipts: new Map([
          [
            deterministicDiscordDeliveryNonce(delivery.delivery_id, 0),
            {
              messageId: 'provider-hidden-by-newer',
              replyAliases: [],
              createdAt: takeoverNow.getTime(),
            },
          ],
        ]),
        newerMessagesBeforeReceipt: 101,
        recoveryNow: takeoverNow.getTime(),
      };
      await worker(db, tenantId, fakeProvider(state), () => takeoverNow).checkOnce();

      expect(state.effects).toHaveLength(0);
      await expect(
        withDeliveryRepo(db, tenantId, (repo) => repo.findById(delivery.delivery_id))
      ).resolves.toMatchObject({
        status: 'dead_letter',
        last_error_code: 'nonce_acceptance_unproven',
      });
    }, 30_000);

    it('uses a non-superuser/NOBYPASSRLS system discovery that exposes only tenant_id and delivery_id', async () => {
      const tenantA = `delivery-discovery-a-${generateId()}` as TenantID;
      const tenantB = `delivery-discovery-b-${generateId()}` as TenantID;
      const a = await seedDelivery(db, tenantA);
      const b = await seedDelivery(db, tenantB);
      const roleResult = await executeRaw(
        db,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const role = (Array.isArray(roleResult) ? roleResult[0] : undefined) as
        | { rolsuper?: boolean; rolbypassrls?: boolean }
        | undefined;
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });

      const refs = await runWithSystemDatabaseScope(
        db,
        'Discord delivery PostgreSQL discovery proof',
        (systemDb) =>
          new DiscordMessageDeliveryRepository(systemDb).findDueRefs(systemDb, {
            limit: 100,
            now: new Date(Date.now() + 60_000),
          }),
        { capability: 'discord_message_delivery_discovery' }
      );
      expect(refs).toEqual(
        expect.arrayContaining([
          {
            tenant_id: tenantA,
            delivery_id: a.delivery.delivery_id,
            thread_session_map_id: a.delivery.thread_session_map_id,
          },
          {
            tenant_id: tenantB,
            delivery_id: b.delivery.delivery_id,
            thread_session_map_id: b.delivery.thread_session_map_id,
          },
        ])
      );
      for (const ref of refs) {
        expect(Object.keys(ref).sort()).toEqual([
          'delivery_id',
          'tenant_id',
          'thread_session_map_id',
        ]);
      }
    }, 30_000);

    it('purges retained rows, deletes one tenant, and keeps the portable delivery FKs tenant-local', async () => {
      const tenantA = `delivery-retention-a-${generateId()}` as TenantID;
      const tenantB = `delivery-retention-b-${generateId()}` as TenantID;
      const a = await seedDelivery(db, tenantA);
      const b = await seedDelivery(db, tenantB);
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        await update(scoped, discordMessageDeliveries)
          .set({ status: 'completed', updated_at: old, completed_at: old })
          .where(eq(discordMessageDeliveries.delivery_id, a.delivery.delivery_id))
          .run();
        expect(await new DiscordMessageDeliveryRepository(scoped).purgeExpired()).toBe(1);
        expect(
          await new DiscordMessageDeliveryRepository(scoped).findById(a.delivery.delivery_id)
        ).toBeNull();
      });

      const freshA = await seedDelivery(db, tenantA, 'delete with tenant');
      const deletion = await deleteTenantData(db, tenantA);
      expect(deletion.rowCounts.discord_message_deliveries).toBeGreaterThanOrEqual(1);
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        expect(
          await new DiscordMessageDeliveryRepository(scoped).findById(freshA.delivery.delivery_id)
        ).toBeNull();
      });
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        expect(
          await new DiscordMessageDeliveryRepository(scoped).findById(b.delivery.delivery_id)
        ).not.toBeNull();
      });

      const deliveryFks = tenantPortabilityForeignKeys().filter(
        (foreignKey) => foreignKey.childTable === 'discord_message_deliveries'
      );
      expect(deliveryFks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ parentTable: 'messages', childColumns: ['message_id'] }),
          expect.objectContaining({
            parentTable: 'gateway_channels',
            childColumns: ['gateway_channel_id'],
          }),
          expect.objectContaining({
            parentTable: 'thread_session_map',
            childColumns: ['thread_session_map_id'],
          }),
        ])
      );
      expect(deliveryFks).toHaveLength(3);
    }, 30_000);
  }
);
